import { inArray, sql } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { custodyTransferItems, items, type CustodyOutcome } from "../../db/schema";
import { getShipment, listJobItems } from "../jobs-core";
import { OUTCOMES, type PartyInput } from "./model";
import { controlsFor } from "./policy";
import { createTransfer, getTransfer, listTransfers, openDeliveryFor, type Actor } from "./transfers";

/**
 * Delivery sign-off for a shipment: the receiving party sees every line on
 * it, with photos and anything already flagged, marks what is missing,
 * damaged or refused, and signs. Under the hood a sign-off is a custody
 * transfer with purpose "delivery" whose lines are the shipment's manifest
 * lines, so it lands in each item's chain like any other handoff.
 */

const PHOTOS_PER_LINE = 4;

/** A line already flagged on the job starts the review flagged the same way. */
export const presetOutcome = (stage: string): CustodyOutcome =>
  (OUTCOMES as readonly string[]).includes(stage) ? (stage as CustodyOutcome) : "accepted";

async function photosFor(itemIds: string[]) {
  const out = new Map<string, { id: string; stage: string | null; caption: string | null; thumbUrl: string }[]>();
  if (!itemIds.length) return out;
  const { rows } = await pool.query<{ id: string; owner_id: string; stage: string | null; caption: string | null }>(
    `SELECT id, owner_id, stage, caption FROM (
       SELECT id, owner_id, stage, caption,
              row_number() OVER (PARTITION BY owner_id ORDER BY created_at DESC) AS n
         FROM attachments
        WHERE owner_type = 'item' AND owner_id = ANY($1::uuid[]) AND kind = 'photo'
     ) p WHERE n <= $2`,
    [itemIds, PHOTOS_PER_LINE],
  );
  for (const r of rows) {
    const list = out.get(r.owner_id) ?? [];
    list.push({ id: r.id, stage: r.stage, caption: r.caption, thumbUrl: `/api/attachments/${r.id}/thumb?w=240` });
    out.set(r.owner_id, list);
  }
  return out;
}

export async function shipmentReview(shipmentId: string) {
  const shipment = await getShipment(shipmentId);
  const { lines } = await listJobItems(shipment.jobId, { shipmentId, limit: 10000 });
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const [photos, controls, pictures, deliveries, open] = await Promise.all([
    photosFor(itemIds),
    controlsFor(itemIds),
    itemIds.length
      ? db.select({ id: items.id, url: items.primaryImageUrl }).from(items).where(inArray(items.id, itemIds))
      : [],
    listTransfers({ shipmentId, purpose: "delivery" }),
    openDeliveryFor(shipmentId),
  ]);
  const pictureOf = new Map(pictures.map((p) => [p.id, p.url]));
  return {
    shipment: {
      id: shipment.id,
      code: shipment.code,
      name: shipment.name,
      status: shipment.status,
      carrier: shipment.carrier,
      sealNumbers: shipment.sealNumbers,
      jobId: shipment.jobId,
      jobCode: shipment.jobCode,
      jobName: shipment.jobName,
      vehicleName: shipment.vehicleName,
    },
    lines: lines.map((l) => ({
      jobItemId: l.id,
      itemId: l.itemId,
      unitId: l.unitId,
      name: l.itemName,
      sub: [l.itemBrand, l.itemModel, l.unitLabel, l.unitSerial].filter(Boolean).join(" · ") || null,
      assetCode: l.assetCode,
      unitCode: l.unitCode,
      stage: l.stage,
      crateNo: l.crateNo,
      destination: l.destinationName ?? l.destinationLabel,
      picture: pictureOf.get(l.itemId) ?? null,
      photos: photos.get(l.itemId) ?? [],
      controlled: controls.has(l.itemId),
      presetOutcome: presetOutcome(l.stage),
    })),
    deliveries,
    open: open ? await getTransfer(open.id) : null,
  };
}

export type SignOffInput = {
  to: PartyInput;
  from?: PartyInput;
  locationId?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  sealNumbers?: string[];
  conditionNote?: string | null;
};

/**
 * Start (or resume) the sign-off for a shipment: a delivery transfer holding
 * every line on it, each preset from its stage. Asking again while one is
 * open returns that one, so two people opening the review do not fork it.
 */
export async function startSignOff(shipmentId: string, input: SignOffInput, actor: Actor) {
  // Held for the length of the call so two people opening the review at once
  // wait for one another; the work itself commits as it goes.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`custody-signoff:${shipmentId}`}, 0))`);
    return createSignOff(shipmentId, input, actor);
  });
}

async function createSignOff(shipmentId: string, input: SignOffInput, actor: Actor) {
  const existing = await openDeliveryFor(shipmentId);
  if (existing) return getTransfer(existing.id);

  const shipment = await getShipment(shipmentId);
  const { lines } = await listJobItems(shipment.jobId, { shipmentId, limit: 10000 });
  const transfer = await createTransfer(
    {
      purpose: "delivery",
      from: input.from ?? { kind: "external", name: shipment.carrier || `${shipment.name} crew`, org: shipment.carrier ? null : shipment.name },
      to: input.to,
      jobId: shipment.jobId,
      shipmentId,
      locationId: input.locationId,
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM,
      // The seals the shipment left with, for the receiver to check intact.
      sealNumbers: input.sealNumbers ?? shipment.sealNumbers,
      conditionNote: input.conditionNote,
    },
    actor,
    { signOff: true },
  );
  for (let i = 0; i < lines.length; i += 500) {
    await db.insert(custodyTransferItems).values(
      lines.slice(i, i + 500).map((l, j) => ({
        transferId: transfer.id,
        position: i + j + 1,
        itemId: l.itemId,
        unitId: l.unitId,
        assetCode: l.assetCode,
        unitCode: l.unitCode,
        name: l.unitLabel ? `${l.itemName} (${l.unitLabel})` : l.itemName,
        via: "line" as const,
        jobItemId: l.id,
        outcome: presetOutcome(l.stage),
      })),
    );
  }
  return getTransfer(transfer.id);
}

/**
 * Shipments on the road or at the door with no signed delivery yet: what the
 * custody page offers to sign off.
 */
export async function awaitingSignOff() {
  const { rows } = await pool.query<{
    id: string;
    code: string;
    name: string;
    status: string;
    carrier: string | null;
    eta: Date | null;
    job_id: string;
    job_code: string;
    job_name: string;
    lines: number;
    open_transfer_id: string | null;
  }>(
    `SELECT s.id, s.code, s.name, s.status, s.carrier, s.eta, j.id AS job_id, j.code AS job_code, j.name AS job_name,
            (SELECT count(*)::int FROM job_items ji WHERE ji.shipment_id = s.id) AS lines,
            (SELECT t.id FROM custody_transfers t
              WHERE t.shipment_id = s.id AND t.purpose = 'delivery' AND t.status IN ('draft', 'locked')
              ORDER BY t.created_at DESC LIMIT 1) AS open_transfer_id
       FROM shipments s JOIN jobs j ON j.id = s.job_id
      WHERE s.status <> 'closed'
        AND j.status IN ('planned', 'in_progress')
        -- On the road by its status, or by its lines: crews often scan the
        -- truck full without moving the shipment itself along.
        AND (s.status IN ('loaded', 'in_transit', 'delivered')
             OR EXISTS (SELECT 1 FROM job_items ji WHERE ji.shipment_id = s.id AND ji.stage IN ('loaded', 'delivered', 'placed')))
        AND NOT EXISTS (SELECT 1 FROM custody_transfers t
                         WHERE t.shipment_id = s.id AND t.purpose = 'delivery' AND t.status = 'completed')
      ORDER BY s.eta ASC NULLS LAST, s.created_at DESC
      LIMIT 100`,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status,
    carrier: r.carrier,
    eta: r.eta,
    jobId: r.job_id,
    jobCode: r.job_code,
    jobName: r.job_name,
    lines: r.lines,
    openTransferId: r.open_transfer_id,
  }));
}
