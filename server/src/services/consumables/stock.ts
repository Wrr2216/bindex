import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import {
  consumableItems,
  entities,
  items,
  locations,
  stockLevels,
  stockMovements,
  users,
  type StockReason,
} from "../../db/schema";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import {
  formatQty,
  isLow,
  planMovement,
  roundQty,
  toQty,
  toQtyOrNull,
  type MovementInput,
  type MovementPlan,
} from "./ledger";

/**
 * Stock of consumables: which items are counted as supplies, how much of each
 * sits at each location, and the movements that got it there. A level and its
 * movement are always written in the same transaction.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Runner = typeof db | Tx;

export type Actor = { oid: string | null; admin: boolean };

// ---- Settings ---------------------------------------------------------------

export type ConsumableSettingsInput = {
  unit?: string | null;
  reorderPoint?: number | null;
  reorderQty?: number | null;
  supplier?: string | null;
};

export type ConsumableSettings = {
  itemId: string;
  unit: string;
  reorderPoint: number | null;
  reorderQty: number | null;
  supplier: string | null;
};

const settingsView = (r: typeof consumableItems.$inferSelect): ConsumableSettings => ({
  itemId: r.itemId,
  unit: r.unit,
  reorderPoint: toQtyOrNull(r.reorderPoint),
  reorderQty: toQtyOrNull(r.reorderQty),
  supplier: r.supplier,
});

const numOrNull = (n: number | null | undefined): string | null =>
  n === null || n === undefined ? null : String(roundQty(n));

/** Start counting an item as a consumable, or change how it is counted. */
export async function setConsumable(
  itemId: string,
  input: ConsumableSettingsInput,
): Promise<ConsumableSettings> {
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, itemId)).limit(1);
  if (!item) throw notFound("Item not found");
  for (const [field, v] of [
    ["reorder point", input.reorderPoint],
    ["reorder quantity", input.reorderQty],
  ] as const) {
    if (v !== null && v !== undefined && (!Number.isFinite(v) || v < 0)) {
      throw badRequest(`The ${field} cannot be negative.`);
    }
  }
  const unit = input.unit?.trim() || undefined;
  const values = {
    itemId,
    unit: unit ?? "each",
    reorderPoint: numOrNull(input.reorderPoint),
    reorderQty: numOrNull(input.reorderQty),
    supplier: input.supplier?.trim() || null,
  };
  // Only the fields that were sent change on an existing record.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (unit !== undefined) set.unit = unit;
  if (input.reorderPoint !== undefined) set.reorderPoint = values.reorderPoint;
  if (input.reorderQty !== undefined) set.reorderQty = values.reorderQty;
  if (input.supplier !== undefined) set.supplier = values.supplier;
  const [row] = await db
    .insert(consumableItems)
    .values(values)
    .onConflictDoUpdate({ target: consumableItems.itemId, set })
    .returning();
  return settingsView(row!);
}

/**
 * Stop counting an item as a consumable. Its levels and history stay, so
 * marking it again picks up where it left off.
 */
export async function removeConsumable(itemId: string): Promise<void> {
  const del = await db
    .delete(consumableItems)
    .where(eq(consumableItems.itemId, itemId))
    .returning({ id: consumableItems.itemId });
  if (!del.length) throw notFound("That item is not tracked as a consumable.");
}

async function loadConsumable(run: Runner, itemId: string) {
  const [row] = await run
    .select({
      id: items.id,
      name: items.name,
      valueCents: items.valueCents,
      unit: consumableItems.unit,
      tracked: consumableItems.itemId,
    })
    .from(items)
    .leftJoin(consumableItems, eq(consumableItems.itemId, items.id))
    .where(eq(items.id, itemId))
    .limit(1);
  if (!row) throw notFound("Item not found");
  if (!row.tracked) {
    throw badRequest(`${row.name} is not tracked as a consumable yet. Add it under Supplies first.`);
  }
  return { id: row.id, name: row.name, valueCents: row.valueCents, unit: row.unit ?? "each" };
}

async function locationNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (!wanted.length) return new Map();
  const rows = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(inArray(locations.id, wanted));
  const map = new Map(rows.map((r) => [r.id, r.name]));
  for (const id of wanted) if (!map.has(id)) throw badRequest("That location no longer exists.");
  return map;
}

export async function loadHolder(holderId: string) {
  const [row] = await db
    .select({ id: entities.id, name: entities.name, kind: entities.kind })
    .from(entities)
    .where(eq(entities.id, holderId))
    .limit(1);
  if (!row) throw badRequest("That crew, truck or branch no longer exists.");
  return row;
}

// ---- Movements --------------------------------------------------------------

export type MovementRequest = MovementInput & {
  itemId: string;
  jobRef?: string | null;
  note?: string | null;
};

type Context = {
  item: Awaited<ReturnType<typeof loadConsumable>>;
  holder: { id: string; name: string } | null;
  locs: Map<string, string>;
  jobRef: string | null;
  note: string | null;
  actor: Actor;
};

/** Lock and read one level, creating the row at zero if it does not exist. */
async function lockLevel(tx: Tx, itemId: string, locationId: string): Promise<number> {
  await tx
    .insert(stockLevels)
    .values({ itemId, locationId, qty: "0" })
    .onConflictDoNothing({ target: [stockLevels.itemId, stockLevels.locationId] });
  const res = await tx.execute<{ qty: string }>(
    sql`SELECT qty FROM stock_levels WHERE item_id = ${itemId} AND location_id = ${locationId} FOR UPDATE`,
  );
  return toQty(res.rows[0]?.qty);
}

/** A holder's outstanding balance of one item, serialized against concurrent returns. */
async function lockHolderBalance(tx: Tx, holderId: string, itemId: string): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`consumables:${holderId}:${itemId}`}, 0))`,
  );
  const res = await tx.execute<{ bal: string | null }>(
    sql`SELECT coalesce(sum(holder_delta), 0) AS bal FROM stock_movements
        WHERE holder_entity_id = ${holderId} AND item_id = ${itemId}`,
  );
  return toQty(res.rows[0]?.bal);
}

async function applyPlan(tx: Tx, plan: MovementPlan, ctx: Context) {
  const { item, holder, locs } = ctx;
  const unit = item.unit;

  if (plan.holderDelta < 0 && holder) {
    const balance = await lockHolderBalance(tx, holder.id, item.id);
    if (roundQty(balance + plan.holderDelta) < 0) {
      const alt =
        plan.reason === "return"
          ? "Record anything extra as received instead."
          : "Record it as used from a location instead.";
      throw badRequest(
        `${holder.name} has ${formatQty(balance)} ${unit} of ${item.name} outstanding, not ${formatQty(-plan.holderDelta)}. ${alt}`,
      );
    }
  }

  const levels: { locationId: string; qty: number }[] = [];
  for (const change of plan.levelChanges) {
    const delta = String(change.delta);
    if (change.delta > 0 || plan.mayGoNegative) {
      const res = await tx.execute<{ qty: string }>(sql`
        INSERT INTO stock_levels (item_id, location_id, qty, updated_at)
        VALUES (${item.id}, ${change.locationId}, ${delta}, now())
        ON CONFLICT (item_id, location_id)
        DO UPDATE SET qty = stock_levels.qty + EXCLUDED.qty, updated_at = now()
        RETURNING qty`);
      levels.push({ locationId: change.locationId, qty: toQty(res.rows[0]?.qty) });
      continue;
    }
    // The guard sits in the WHERE clause, so two people issuing the last box at
    // once cannot both succeed: the second re-checks after the first commits.
    const res = await tx.execute<{ qty: string }>(sql`
      UPDATE stock_levels SET qty = qty + ${delta}, updated_at = now()
      WHERE item_id = ${item.id} AND location_id = ${change.locationId} AND qty + ${delta} >= 0
      RETURNING qty`);
    if (!res.rows.length) {
      const [cur] = await tx
        .select({ qty: stockLevels.qty })
        .from(stockLevels)
        .where(and(eq(stockLevels.itemId, item.id), eq(stockLevels.locationId, change.locationId)));
      throw badRequest(
        `Only ${formatQty(toQty(cur?.qty))} ${unit} of ${item.name} on hand at ${locs.get(change.locationId) ?? "that location"}. ` +
          "Count it if the number is wrong, or ask an administrator to adjust it.",
      );
    }
    levels.push({ locationId: change.locationId, qty: toQty(res.rows[0]!.qty) });
  }

  const [movement] = await tx
    .insert(stockMovements)
    .values({
      itemId: item.id,
      reason: plan.reason,
      qty: String(plan.qty),
      fromLocationId: plan.fromLocationId,
      toLocationId: plan.toLocationId,
      holderEntityId: holder?.id ?? null,
      holderName: holder?.name ?? null,
      holderDelta: String(plan.holderDelta),
      jobRef: ctx.jobRef,
      note: ctx.note,
      unitCostCents: item.valueCents,
      expectedQty: plan.expectedQty === null ? null : String(plan.expectedQty),
      countedQty: plan.countedQty === null ? null : String(plan.countedQty),
      createdBy: ctx.actor.oid,
    })
    .returning();
  return { movement: movement!, levels };
}

const clean = (s: string | null | undefined) => s?.trim() || null;

/** Record one movement: receive, issue, return, consume, transfer, adjust or count. */
export async function recordMovement(req: MovementRequest, actor: Actor) {
  if (req.reason === "adjust") {
    if (!actor.admin) {
      throw forbidden("Only an administrator can adjust stock. Record a count instead.");
    }
    if (!clean(req.note)) throw badRequest("Say why the stock is being adjusted.");
  }
  // Validate the shape before touching the database, so a missing field is
  // reported as that rather than as a lookup failure.
  planMovement({ ...req, expectedQty: 0 });

  const item = await loadConsumable(db, req.itemId);
  const locs = await locationNames([req.locationId, req.reason === "transfer" ? req.toLocationId : null]);
  const holder = req.holderId ? await loadHolder(req.holderId) : null;
  const ctx: Context = { item, holder, locs, jobRef: clean(req.jobRef), note: clean(req.note), actor };

  const result = await db.transaction(async (tx) => {
    const expectedQty =
      req.reason === "count" ? await lockLevel(tx, item.id, req.locationId!) : null;
    return applyPlan(tx, planMovement({ ...req, expectedQty }), ctx);
  });
  logger.info("consumables.movement", {
    reason: req.reason,
    itemId: item.id,
    qty: toQty(result.movement.qty),
    holderId: holder?.id,
  });
  return { movement: movementBase(result.movement), levels: result.levels };
}

export type CountLine = { itemId: string; countedQty: number };

/**
 * A cycle count of one location: every line is compared with what is on file
 * and the level set to what was found, all or nothing.
 */
export async function recordCount(
  locationId: string,
  lines: CountLine[],
  actor: Actor,
  note?: string | null,
) {
  if (!lines.length) throw badRequest("Count at least one item.");
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.itemId)) throw badRequest("Each item can appear once in a count.");
    seen.add(l.itemId);
    planMovement({ reason: "count", locationId, countedQty: l.countedQty, expectedQty: 0 });
  }
  const locs = await locationNames([locationId]);
  const loaded = new Map<string, Awaited<ReturnType<typeof loadConsumable>>>();
  for (const l of lines) loaded.set(l.itemId, await loadConsumable(db, l.itemId));

  const results = await db.transaction(async (tx) => {
    const out: {
      itemId: string;
      itemName: string;
      unit: string;
      expectedQty: number;
      countedQty: number;
      variance: number;
    }[] = [];
    // Lock in a stable order so two overlapping counts cannot deadlock.
    for (const l of [...lines].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
      const item = loaded.get(l.itemId)!;
      const expectedQty = await lockLevel(tx, item.id, locationId);
      const plan = planMovement({ reason: "count", locationId, countedQty: l.countedQty, expectedQty });
      await applyPlan(tx, plan, { item, holder: null, locs, jobRef: null, note: clean(note), actor });
      out.push({
        itemId: item.id,
        itemName: item.name,
        unit: item.unit,
        expectedQty,
        countedQty: plan.countedQty!,
        variance: roundQty(plan.countedQty! - expectedQty),
      });
    }
    return out;
  });
  logger.info("consumables.count", {
    locationId,
    lines: results.length,
    off: results.filter((r) => r.variance !== 0).length,
  });
  return { locationId, locationName: locs.get(locationId)!, lines: results };
}

// ---- Reading ----------------------------------------------------------------

function movementBase(m: typeof stockMovements.$inferSelect) {
  return {
    id: m.id,
    itemId: m.itemId,
    reason: m.reason,
    qty: toQty(m.qty),
    fromLocationId: m.fromLocationId,
    toLocationId: m.toLocationId,
    holderId: m.holderEntityId,
    holderName: m.holderName,
    holderDelta: toQty(m.holderDelta),
    jobRef: m.jobRef,
    note: m.note,
    unitCostCents: m.unitCostCents,
    expectedQty: toQtyOrNull(m.expectedQty),
    countedQty: toQtyOrNull(m.countedQty),
    createdBy: m.createdBy,
    createdAt: m.createdAt,
  };
}

export type MovementFilter = {
  itemId?: string;
  holderId?: string;
  locationId?: string;
  reason?: StockReason;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

export async function listMovements(f: MovementFilter) {
  const fromLoc = alias(locations, "from_loc");
  const toLoc = alias(locations, "to_loc");
  const conds: (SQL | undefined)[] = [
    f.itemId ? eq(stockMovements.itemId, f.itemId) : undefined,
    f.holderId ? eq(stockMovements.holderEntityId, f.holderId) : undefined,
    f.locationId
      ? or(eq(stockMovements.fromLocationId, f.locationId), eq(stockMovements.toLocationId, f.locationId))
      : undefined,
    f.reason ? eq(stockMovements.reason, f.reason) : undefined,
    f.from ? gte(stockMovements.createdAt, f.from) : undefined,
    f.to ? lt(stockMovements.createdAt, f.to) : undefined,
  ];
  const where = conds.filter((c): c is SQL => !!c);
  const rows = await db
    .select({
      m: stockMovements,
      itemName: items.name,
      unit: consumableItems.unit,
      fromLocationName: fromLoc.name,
      toLocationName: toLoc.name,
      createdByName: users.name,
    })
    .from(stockMovements)
    .innerJoin(items, eq(items.id, stockMovements.itemId))
    .leftJoin(consumableItems, eq(consumableItems.itemId, stockMovements.itemId))
    .leftJoin(fromLoc, eq(fromLoc.id, stockMovements.fromLocationId))
    .leftJoin(toLoc, eq(toLoc.id, stockMovements.toLocationId))
    .leftJoin(users, eq(users.oid, stockMovements.createdBy))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(stockMovements.createdAt))
    .limit(Math.min(f.limit ?? 50, 5000))
    .offset(f.offset ?? 0);
  return rows.map((r) => ({
    ...movementBase(r.m),
    itemName: r.itemName,
    unit: r.unit ?? "each",
    fromLocationName: r.fromLocationName,
    toLocationName: r.toLocationName,
    createdByName: r.createdByName,
  }));
}

export type LevelView = { itemId: string; locationId: string; locationName: string; qty: number; low: boolean };

export async function levelsFor(itemIds: string[], locationId?: string): Promise<LevelView[]> {
  if (!itemIds.length && !locationId) return [];
  const rows = await db
    .select({
      itemId: stockLevels.itemId,
      locationId: stockLevels.locationId,
      locationName: locations.name,
      qty: stockLevels.qty,
      reorderPoint: consumableItems.reorderPoint,
    })
    .from(stockLevels)
    .innerJoin(locations, eq(locations.id, stockLevels.locationId))
    .leftJoin(consumableItems, eq(consumableItems.itemId, stockLevels.itemId))
    .where(
      and(
        itemIds.length ? inArray(stockLevels.itemId, itemIds) : undefined,
        locationId ? eq(stockLevels.locationId, locationId) : undefined,
      ),
    )
    .orderBy(locations.name);
  return rows.map((r) => {
    const qty = toQty(r.qty);
    return {
      itemId: r.itemId,
      locationId: r.locationId,
      locationName: r.locationName,
      qty,
      low: isLow(qty, toQtyOrNull(r.reorderPoint)),
    };
  });
}

type CatalogSql = {
  item_id: string;
  name: string;
  asset_code: string;
  value_cents: string | null;
  primary_image_url: string | null;
  unit: string;
  reorder_point: string | null;
  reorder_qty: string | null;
  supplier: string | null;
  on_hand: string;
  outstanding: string;
  low_locations: string;
  stocked_locations: string;
};

/** Every consumable with its total on hand, what holders have out, and whether it is low. */
export async function listCatalog(opts: { q?: string; itemIds?: string[] } = {}) {
  const q = opts.q?.trim() ?? "";
  const res = await db.execute<CatalogSql>(sql`
    SELECT i.id AS item_id, i.name, i.asset_code, i.value_cents, i.primary_image_url,
           c.unit, c.reorder_point, c.reorder_qty, c.supplier,
           coalesce(l.on_hand, 0) AS on_hand,
           coalesce(l.low_locations, 0) AS low_locations,
           coalesce(l.stocked_locations, 0) AS stocked_locations,
           coalesce(h.outstanding, 0) AS outstanding
      FROM consumable_items c
      JOIN items i ON i.id = c.item_id
      LEFT JOIN LATERAL (
        SELECT sum(s.qty) AS on_hand,
               count(*) FILTER (WHERE c.reorder_point IS NOT NULL AND s.qty <= c.reorder_point) AS low_locations,
               count(*) AS stocked_locations
          FROM stock_levels s WHERE s.item_id = c.item_id
      ) l ON true
      LEFT JOIN LATERAL (
        SELECT sum(m.holder_delta) AS outstanding
          FROM stock_movements m
         WHERE m.item_id = c.item_id AND m.holder_entity_id IS NOT NULL
      ) h ON true
     WHERE (${q} = '' OR i.name ILIKE '%' || ${q} || '%' OR i.asset_code ILIKE '%' || ${q} || '%'
            OR coalesce(c.supplier, '') ILIKE '%' || ${q} || '%')
       ${opts.itemIds?.length ? sql`AND c.item_id IN (${sql.join(opts.itemIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
     ORDER BY i.name`);
  const rows = res.rows;
  const levels = await levelsFor(rows.map((r) => r.item_id));
  const byItem = new Map<string, LevelView[]>();
  for (const l of levels) byItem.set(l.itemId, [...(byItem.get(l.itemId) ?? []), l]);
  return rows.map((r) => {
    const reorderPoint = toQtyOrNull(r.reorder_point);
    const onHand = toQty(r.on_hand);
    const stocked = Number(r.stocked_locations);
    return {
      itemId: r.item_id,
      name: r.name,
      assetCode: r.asset_code,
      valueCents: r.value_cents === null ? null : Number(r.value_cents),
      imageUrl: r.primary_image_url,
      unit: r.unit,
      reorderPoint,
      reorderQty: toQtyOrNull(r.reorder_qty),
      supplier: r.supplier,
      onHand,
      outstanding: toQty(r.outstanding),
      // Low somewhere it is stocked, or tracked for reorder and stocked nowhere.
      low: Number(r.low_locations) > 0 || (reorderPoint !== null && stocked === 0),
      levels: byItem.get(r.item_id) ?? [],
    };
  });
}

/** Holders with a non-zero balance of one item, or of everything when no item is given. */
export async function holderBalances(opts: { itemId?: string; holderId?: string }) {
  const res = await db.execute<{
    holder_id: string;
    holder_name: string;
    item_id: string;
    item_name: string;
    unit: string | null;
    balance: string;
    value_cents: string | null;
  }>(sql`
    SELECT m.holder_entity_id AS holder_id, e.name AS holder_name, m.item_id, i.name AS item_name,
           c.unit, sum(m.holder_delta) AS balance, i.value_cents
      FROM stock_movements m
      JOIN entities e ON e.id = m.holder_entity_id
      JOIN items i ON i.id = m.item_id
      LEFT JOIN consumable_items c ON c.item_id = m.item_id
     WHERE m.holder_entity_id IS NOT NULL
       ${opts.itemId ? sql`AND m.item_id = ${opts.itemId}` : sql``}
       ${opts.holderId ? sql`AND m.holder_entity_id = ${opts.holderId}` : sql``}
     GROUP BY m.holder_entity_id, e.name, m.item_id, i.name, c.unit, i.value_cents
    HAVING sum(m.holder_delta) <> 0
     ORDER BY e.name, i.name`);
  return res.rows.map((r) => ({
    holderId: r.holder_id,
    holderName: r.holder_name,
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit ?? "each",
    balance: toQty(r.balance),
    valueCents: r.value_cents === null ? null : Number(r.value_cents),
  }));
}

export async function getConsumableDetail(itemId: string) {
  const [row] = await listCatalog({ itemIds: [itemId] });
  if (!row) {
    const [exists] = await db.select({ id: items.id }).from(items).where(eq(items.id, itemId)).limit(1);
    if (!exists) throw notFound("Item not found");
    throw notFound("That item is not tracked as a consumable.");
  }
  const [holders, movements] = await Promise.all([
    holderBalances({ itemId }),
    listMovements({ itemId, limit: 50 }),
  ]);
  return { ...row, holders, movements };
}

/** What a location holds: every consumable with a level there. */
export async function locationStock(locationId: string) {
  const names = await locationNames([locationId]).catch(() => {
    throw notFound("Location not found");
  });
  const levels = await levelsFor([], locationId);
  const catalog = levels.length ? await listCatalog({ itemIds: levels.map((l) => l.itemId) }) : [];
  const byId = new Map(catalog.map((c) => [c.itemId, c]));
  return {
    locationId,
    locationName: names.get(locationId)!,
    items: levels
      .filter((l) => byId.has(l.itemId))
      .map((l) => {
        const c = byId.get(l.itemId)!;
        return {
          itemId: l.itemId,
          name: c.name,
          assetCode: c.assetCode,
          unit: c.unit,
          qty: l.qty,
          reorderPoint: c.reorderPoint,
          low: l.low,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Compare every stored level with the sum of its movements. An empty list
 * means the two agree, which is the property every write path preserves.
 */
export async function checkIntegrity(itemIds?: string[]) {
  const scope = itemIds?.length
    ? sql`WHERE item_id IN (${sql.join(itemIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  const res = await db.execute<{ item_id: string; location_id: string; stored: string | null; moved: string | null }>(sql`
    WITH moved AS (
      SELECT item_id, loc AS location_id, sum(d) AS qty FROM (
        SELECT item_id, to_location_id AS loc, qty AS d FROM stock_movements WHERE to_location_id IS NOT NULL
        UNION ALL
        SELECT item_id, from_location_id, -qty FROM stock_movements WHERE from_location_id IS NOT NULL
      ) x ${scope} GROUP BY item_id, loc
    ), stored AS (
      SELECT item_id, location_id, qty FROM stock_levels ${scope}
    )
    SELECT coalesce(s.item_id, m.item_id) AS item_id, coalesce(s.location_id, m.location_id) AS location_id,
           s.qty AS stored, m.qty AS moved
      FROM stored s FULL JOIN moved m ON m.item_id = s.item_id AND m.location_id = s.location_id
     WHERE coalesce(s.qty, 0) <> coalesce(m.qty, 0)`);
  return res.rows.map((r) => ({
    itemId: r.item_id,
    locationId: r.location_id,
    stored: toQty(r.stored),
    fromMovements: toQty(r.moved),
  }));
}
