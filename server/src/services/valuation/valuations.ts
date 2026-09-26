import { and, desc, eq, isNull } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { itemUnits, items, users } from "../../db/schema";
import { valuations, type ValuationRow, type ValuationSource } from "../../db/tables/valuation";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { lookupPricing, type PricingResult } from "../enrichment";
import { publish, actorFromOid } from "../event-backbone";
import { readAttachmentBytes } from "../media-ai-core";
import { env } from "../../env";
import { recordEvent } from "../items";
import { estimateFromPhotos, type ValuationEstimate } from "./estimate";
import { cleanText, today } from "./parse";
import { getProfileMode } from "./profiles";
import { isHighValue } from "./schedule";
import { getValuationSettings } from "./settings";

/**
 * Values and their history. Every value recorded is a new row in `valuations`
 * and never changes; the item's (or unit's) value_cents is set to the newest,
 * so everything that already shows a value keeps working.
 */

export type ValuationOwner = {
  item: {
    id: string;
    name: string;
    brand: string | null;
    model: string | null;
    category: string | null;
    valueCents: number | null;
    assetCode: string;
  };
  unit: { id: string; label: string | null; serial: string | null; valueCents: number | null; assetCode: string } | null;
  unitCount: number;
};

/** The item (and unit) a valuation is about. 404 when either is gone or the unit is not this item's. */
export async function loadOwner(itemId: string, unitId?: string | null): Promise<ValuationOwner> {
  const [item] = await db
    .select({
      id: items.id,
      name: items.name,
      brand: items.brand,
      model: items.model,
      category: items.category,
      valueCents: items.valueCents,
      assetCode: items.assetCode,
    })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (!item) throw notFound("That item no longer exists.");
  const units = await db
    .select({ id: itemUnits.id, label: itemUnits.label, serial: itemUnits.serial, valueCents: itemUnits.valueCents, assetCode: itemUnits.assetCode })
    .from(itemUnits)
    .where(eq(itemUnits.itemId, itemId));
  let unit: ValuationOwner["unit"] = null;
  if (unitId) {
    unit = units.find((u) => u.id === unitId) ?? null;
    if (!unit) throw notFound("That unit no longer exists, or belongs to another item.");
  }
  return { item, unit, unitCount: units.length };
}

export type Valuation = ValuationRow & { createdByName: string | null };

export async function listValuations(itemId: string): Promise<Valuation[]> {
  const rows = await db
    .select({ v: valuations, name: users.name })
    .from(valuations)
    .leftJoin(users, eq(users.oid, valuations.createdBy))
    .where(eq(valuations.itemId, itemId))
    .orderBy(desc(valuations.createdAt), desc(valuations.id));
  return rows.map((r) => ({ ...r.v, createdByName: r.name ?? null }));
}

/** The newest valuation of the item itself (unitId null) or of one unit. */
export async function latestValuation(itemId: string, unitId: string | null): Promise<ValuationRow | null> {
  const [row] = await db
    .select()
    .from(valuations)
    .where(and(eq(valuations.itemId, itemId), unitId ? eq(valuations.unitId, unitId) : isNull(valuations.unitId)))
    .orderBy(desc(valuations.createdAt), desc(valuations.id))
    .limit(1);
  return row ?? null;
}

export type RecordValuationInput = {
  itemId: string;
  unitId?: string | null;
  valueCents: number;
  source: ValuationSource;
  basis?: string | null;
  confidence?: number | null;
  lowCents?: number | null;
  highCents?: number | null;
  /** YYYY-MM-DD; today when omitted. */
  valuedOn?: string | null;
  details?: Record<string, unknown>;
  /** Accept the brand and model an estimate identified onto the item. */
  apply?: { brand?: string | null; model?: string | null };
};

const MAX_DETAILS_BYTES = 32 * 1024;

/**
 * Record a value, keep the one before it in history, and set it on the item or
 * unit, in one transaction. An item with tracked units takes its value from
 * them, so the value goes on a unit instead.
 */
export async function recordValuation(input: RecordValuationInput, userOid: string | null): Promise<Valuation> {
  const owner = await loadOwner(input.itemId, input.unitId);
  if (!owner.unit && owner.unitCount > 0) {
    throw badRequest("This item's value is the total of its units. Record the value on a unit instead.");
  }
  if (!Number.isSafeInteger(input.valueCents) || input.valueCents < 0) throw badRequest("Enter a value of zero or more.");
  const details = input.details ?? {};
  if (Buffer.byteLength(JSON.stringify(details)) > MAX_DETAILS_BYTES) throw badRequest("Valuation details are limited to 32 KB.");
  const valuedOn = input.valuedOn ?? today();
  if (valuedOn > today()) throw badRequest("A valuation cannot be dated in the future.");

  const config = await getConfig();
  const settings = await getValuationSettings();
  const previous = owner.unit ? owner.unit.valueCents : owner.item.valueCents;
  const brand = cleanText(input.apply?.brand, 120);
  const model = cleanText(input.apply?.model, 120);

  const client = await pool.connect();
  let id: string;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO valuations
         (item_id, unit_id, value_cents, previous_cents, currency, source, basis, confidence,
          low_cents, high_cents, valued_on, details, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
       RETURNING id`,
      [
        owner.item.id,
        owner.unit?.id ?? null,
        input.valueCents,
        previous,
        config.currency,
        input.source,
        cleanText(input.basis, 500),
        input.confidence ?? null,
        input.lowCents ?? null,
        input.highCents ?? null,
        valuedOn,
        JSON.stringify(details),
        userOid,
      ],
    );
    id = rows[0]!.id;
    if (owner.unit) {
      await client.query(`UPDATE item_units SET value_cents = $2, updated_at = now() WHERE id = $1`, [owner.unit.id, input.valueCents]);
      // The same roll-up units.ts keeps: an item with units is worth their total.
      await client.query(
        `UPDATE items SET value_cents = (SELECT coalesce(sum(value_cents), 0) FROM item_units WHERE item_id = $1), updated_at = now()
          WHERE id = $1`,
        [owner.item.id],
      );
    } else {
      await client.query(
        `UPDATE items SET value_cents = $2, brand = coalesce($3, brand), model = coalesce($4, model), updated_at = now() WHERE id = $1`,
        [owner.item.id, input.valueCents, brand, model],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const fields = ["valueCents", ...(!owner.unit && brand ? ["brand"] : []), ...(!owner.unit && model ? ["model"] : [])];
  await recordEvent(owner.item.id, userOid, "updated", {
    source: "valuation",
    fields,
    valuationId: id,
    ...(owner.unit ? { unitId: owner.unit.id } : {}),
  });
  const subject = { type: "item", id: owner.item.id };
  const actor = actorFromOid(userOid);
  await publish(
    "valuation.recorded",
    {
      valuationId: id,
      itemId: owner.item.id,
      itemName: owner.item.name,
      unitId: owner.unit?.id ?? null,
      source: input.source,
      valueCents: input.valueCents,
      previousCents: previous,
      currency: config.currency,
      confidence: input.confidence ?? null,
      valuedOn,
    },
    { actor, subject },
  );

  const mode = await getProfileMode(owner.item.id, owner.unit?.id ?? null);
  const threshold = settings.highValueThresholdCents;
  if (!isHighValue(mode, previous, threshold) && isHighValue(mode, input.valueCents, threshold)) {
    await publish(
      "valuation.high_value_marked",
      {
        itemId: owner.item.id,
        itemName: owner.item.name,
        unitId: owner.unit?.id ?? null,
        valueCents: input.valueCents,
        thresholdCents: threshold,
        currency: config.currency,
      },
      { actor, subject },
    );
  }
  logger.info("valuation.recorded", { id, itemId: owner.item.id, unitId: owner.unit?.id, source: input.source });

  const [row] = await db.select().from(valuations).where(eq(valuations.id, id)).limit(1);
  const [who] = userOid ? await db.select({ name: users.name }).from(users).where(eq(users.oid, userOid)).limit(1) : [];
  return { ...row!, createdByName: who?.name ?? null };
}

// ---- AI estimate ------------------------------------------------------------

export type WebPrice = Pick<PricingResult, "found" | "priceCents" | "currency" | "retailer" | "url" | "notes" | "checkedAt">;

export type EstimateResult = {
  /** False when no vision model is configured. */
  available: boolean;
  found: boolean;
  estimate: ValuationEstimate | null;
  /** The web price lookup, when search and a language model are configured and it was asked for. */
  webPrice: WebPrice | null;
  /** The photos the estimate was made from, to keep with the valuation. */
  attachmentIds: string[];
  currency: string;
  message?: string;
};

/**
 * Estimate an item's value from photos already attached to it (or to one of
 * its units). Saves nothing: the person reviews, adjusts and confirms, and
 * recordValuation keeps the estimate as the valuation's evidence.
 */
export async function estimateValue(
  input: { itemId: string; unitId?: string | null; attachmentIds: string[]; crossCheck?: boolean },
  userOid: string | null,
): Promise<EstimateResult> {
  const owner = await loadOwner(input.itemId, input.unitId);
  const { currency } = await getConfig();
  if (!env.llmVisionConfigured) {
    return { available: false, found: false, estimate: null, webPrice: null, attachmentIds: [], currency };
  }
  if (!input.attachmentIds.length) throw badRequest("Take or pick at least one photo of the item.");

  const images: { mime: string; bytes: Buffer }[] = [];
  for (const id of input.attachmentIds.slice(0, 6)) {
    const { attachment, bytes } = await readAttachmentBytes(id, 25 * 1024 * 1024);
    const belongs =
      (attachment.ownerType === "item" && attachment.ownerId === owner.item.id) ||
      (attachment.ownerType === "unit" && owner.unit !== null && attachment.ownerId === owner.unit.id);
    if (!belongs) throw badRequest("Use photos attached to this item.");
    if (!attachment.mime.startsWith("image/")) throw badRequest("Only photos can be used for an estimate.");
    images.push({ mime: attachment.mime, bytes });
  }

  const estimate = await estimateFromPhotos(
    images,
    currency,
    { name: owner.item.name, brand: owner.item.brand, model: owner.item.model, category: owner.item.category },
    { itemId: owner.item.id, unitId: owner.unit?.id, user: userOid },
  );

  let webPrice: WebPrice | null = null;
  if (estimate && input.crossCheck !== false && env.webSearchConfigured && env.llmConfigured) {
    const r = await lookupPricing({
      name: owner.item.name,
      brand: estimate.brand ?? owner.item.brand,
      model: estimate.model ?? owner.item.model,
    });
    webPrice = { found: r.found, priceCents: r.priceCents, currency: r.currency, retailer: r.retailer, url: r.url, notes: r.notes, checkedAt: r.checkedAt };
  }

  const found = Boolean(estimate?.estimatedValue);
  logger.info("valuation.estimated", { itemId: owner.item.id, found, confidence: estimate?.confidence, webPrice: webPrice?.found });
  return {
    available: true,
    found,
    estimate,
    webPrice,
    attachmentIds: input.attachmentIds.slice(0, 6),
    currency,
    ...(found ? {} : { message: "No value could be estimated from these photos. Try a clearer photo that shows the whole item and any label." }),
  };
}
