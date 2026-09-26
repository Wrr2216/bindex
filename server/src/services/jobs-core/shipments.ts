import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  jobItems,
  jobs,
  locations,
  shipmentStatusHistory,
  shipments,
  type Shipment,
  type ShipmentStatus,
} from "../../db/schema";
import { HttpError, badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { withFreshCode } from "./codes";
import { emitShipmentStatus } from "./hooks";
import { progressByShipment } from "./progress";
import { checkShipmentTransition, shipmentTimestamps } from "./rules";
import { actorLabel, assertJobOpen, clean, loadJob, loadShipment, type Actor } from "./shared";

/**
 * Shipments: one truck, trailer or container run within a job. Lines are put
 * on a shipment when they are scanned onto it (or assigned in the manifest),
 * and the shipment's status is held back until its lines have caught up.
 */

export type ShipmentInput = {
  jobId: string;
  name: string;
  vehicleLocationId?: string | null;
  carrier?: string | null;
  sealNumbers?: string[];
  weightKg?: number | null;
  volumeM3?: number | null;
  distanceKm?: number | null;
  eta?: string | null;
  notes?: string | null;
};

const cleanSeals = (seals: string[]) => [...new Set(seals.map((s) => s.trim()).filter(Boolean))];

function shipmentQuery() {
  return db
    .select({
      ...getTableColumns(shipments),
      jobCode: jobs.code,
      jobName: jobs.name,
      vehicleName: locations.name,
    })
    .from(shipments)
    .innerJoin(jobs, eq(shipments.jobId, jobs.id))
    .leftJoin(locations, eq(shipments.vehicleLocationId, locations.id));
}

export async function listShipments(opts: { jobId?: string; status?: ShipmentStatus } = {}) {
  const rows = await shipmentQuery()
    .where(
      and(
        opts.jobId ? eq(shipments.jobId, opts.jobId) : undefined,
        opts.status ? eq(shipments.status, opts.status) : undefined,
      ),
    )
    .orderBy(desc(shipments.createdAt));
  const progress = await progressByShipment(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, progress: progress.get(r.id)! }));
}

/** A shipment with its progress and status history, for the shipment page. */
export async function getShipment(id: string) {
  const [row] = await shipmentQuery().where(eq(shipments.id, id)).limit(1);
  if (!row) throw notFound("Shipment not found");
  const [progress, history] = await Promise.all([
    progressByShipment([id]),
    db
      .select()
      .from(shipmentStatusHistory)
      .where(eq(shipmentStatusHistory.shipmentId, id))
      .orderBy(asc(shipmentStatusHistory.createdAt)),
  ]);
  return { ...row, progress: progress.get(id)!, history };
}

export async function createShipment(input: ShipmentInput, actor: Actor): Promise<Shipment> {
  const job = await loadJob(input.jobId);
  assertJobOpen(job);
  const name = clean(input.name);
  if (!name) throw badRequest("A shipment needs a name, such as the truck or trailer it travels in.");
  const shipment = await withFreshCode("shipment", "uq_shipments_code", (code) =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(shipments)
        .values({
          code,
          jobId: job.id,
          name,
          vehicleLocationId: input.vehicleLocationId ?? null,
          carrier: clean(input.carrier),
          sealNumbers: cleanSeals(input.sealNumbers ?? []),
          weightKg: input.weightKg ?? null,
          volumeM3: input.volumeM3 ?? null,
          distanceKm: input.distanceKm ?? null,
          eta: input.eta ? new Date(input.eta) : null,
          notes: clean(input.notes),
          createdBy: actor.userOid,
        })
        .returning();
      await tx.insert(shipmentStatusHistory).values({
        shipmentId: row!.id,
        fromStatus: null,
        toStatus: "planned",
        userOid: actor.userOid,
        actor: actorLabel(actor),
      });
      return row!;
    }),
  );
  logger.info("jobs.shipment.created", { shipmentId: shipment.id, code: shipment.code, jobId: job.id });
  return shipment;
}

/** Everything but the status, which has its own rules (setShipmentStatus). */
export async function updateShipment(
  id: string,
  patch: Partial<Omit<ShipmentInput, "jobId">>,
): Promise<Shipment> {
  await loadShipment(id);
  const set: Partial<typeof shipments.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = clean(patch.name);
    if (!name) throw badRequest("A shipment needs a name.");
    set.name = name;
  }
  if (patch.vehicleLocationId !== undefined) set.vehicleLocationId = patch.vehicleLocationId;
  if (patch.carrier !== undefined) set.carrier = clean(patch.carrier);
  if (patch.sealNumbers !== undefined) set.sealNumbers = cleanSeals(patch.sealNumbers);
  if (patch.weightKg !== undefined) set.weightKg = patch.weightKg;
  if (patch.volumeM3 !== undefined) set.volumeM3 = patch.volumeM3;
  if (patch.distanceKm !== undefined) set.distanceKm = patch.distanceKm;
  if (patch.eta !== undefined) set.eta = patch.eta ? new Date(patch.eta) : null;
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  const [row] = await db.update(shipments).set(set).where(eq(shipments.id, id)).returning();
  return row!;
}

/**
 * Move a shipment to a new status. Refused with a 409 whose `details.blockers`
 * counts the lines holding it back (by stage) when they are not ready, unless
 * forced with a reason; the reason is kept in the status history.
 */
export async function setShipmentStatus(
  id: string,
  to: ShipmentStatus,
  opts: { force?: boolean; reason?: string | null },
  actor: Actor,
): Promise<Shipment> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(shipments).where(eq(shipments.id, id)).for("update").limit(1);
    if (!current) throw notFound("Shipment not found");
    const lines = await tx.select({ stage: jobItems.stage }).from(jobItems).where(eq(jobItems.shipmentId, id));
    const check = checkShipmentTransition(
      current.status,
      to,
      lines.map((l) => l.stage),
      opts,
    );
    if (!check.ok) {
      throw new HttpError(check.code === "same_status" ? 400 : 409, check.code, check.message, {
        blockers: check.blockers,
      });
    }
    const [row] = await tx
      .update(shipments)
      .set({ status: to, updatedAt: now, ...shipmentTimestamps(to, current, now) })
      .where(eq(shipments.id, id))
      .returning();
    const reason = clean(opts.reason);
    await tx.insert(shipmentStatusHistory).values({
      shipmentId: id,
      fromStatus: current.status,
      toStatus: to,
      forced: check.forced,
      reason,
      userOid: actor.userOid,
      actor: actorLabel(actor),
      createdAt: now,
    });
    return { row: row!, from: current.status, forced: check.forced, reason };
  });
  logger.info("jobs.shipment.status", {
    shipmentId: id,
    from: result.from,
    to,
    forced: result.forced,
  });
  await emitShipmentStatus({
    shipment: result.row,
    from: result.from,
    to,
    forced: result.forced,
    reason: result.reason,
    userOid: actor.userOid,
    actor: actorLabel(actor),
  });
  return result.row;
}

/** Lines on the shipment stay on the job, off any shipment. */
export async function deleteShipment(id: string): Promise<void> {
  const deleted = await db.delete(shipments).where(eq(shipments.id, id)).returning({ id: shipments.id });
  if (!deleted.length) throw notFound("Shipment not found");
}

/** Per-feature data on a shipment (a tracker link, a capacity), under its own key. */
export async function setShipmentMetadata(id: string, key: string, value: unknown): Promise<Shipment> {
  const expr =
    value === undefined
      ? sql`${shipments.metadata} - ${key}`
      : sql`${shipments.metadata} || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)`;
  const [row] = await db
    .update(shipments)
    .set({ metadata: expr, updatedAt: new Date() })
    .where(eq(shipments.id, id))
    .returning();
  if (!row) throw notFound("Shipment not found");
  return row;
}
