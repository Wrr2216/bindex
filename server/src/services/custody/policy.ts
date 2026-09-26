import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { custodyControls, custodyTransferItems, custodyTransfers, items, jobItems } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { actorFromOid, publish } from "../event-backbone";
import { registerStageGuard, type StageGuardContext } from "../jobs-core";
import { GUARDED_STAGES } from "./model";
import { custodyVetoes, type Control, type Coverage } from "./rules";
import type { Actor } from "./transfers";

/**
 * The sensitive-item policy. An item is custody-controlled when it, or a
 * container it is packed in (at any depth), is marked. A controlled item
 * cannot reach delivered or placed on a job without a completed delivery
 * transfer that covers it; the check is a jobs stage guard, so it holds for
 * every way a line moves: scans, readers, ticking rows, portals.
 */

/**
 * Which of `itemIds` are controlled, and by what. One recursive query walks
 * each item's container chain.
 */
export async function controlsFor(itemIds: readonly string[]): Promise<Map<string, Control>> {
  const out = new Map<string, Control>();
  const ids = [...new Set(itemIds)];
  if (!ids.length) return out;
  const { rows } = await pool.query<{ start_id: string; start_code: string; by_id: string; by_code: string; depth: number }>(
    `WITH RECURSIVE up(start_id, id, depth) AS (
       SELECT id, id, 0 FROM items WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT up.start_id, i.parent_item_id, up.depth + 1
         FROM up JOIN items i ON i.id = up.id
        WHERE i.parent_item_id IS NOT NULL AND up.depth < 20
     )
     SELECT DISTINCT ON (up.start_id)
            up.start_id, s.asset_code AS start_code, c.item_id AS by_id, b.asset_code AS by_code, up.depth
       FROM up
       JOIN custody_controls c ON c.item_id = up.id
       JOIN items s ON s.id = up.start_id
       JOIN items b ON b.id = c.item_id
      ORDER BY up.start_id, up.depth`,
    [ids],
  );
  for (const r of rows) {
    out.set(r.start_id, { assetCode: r.start_code, container: r.depth > 0 ? r.by_code : null });
  }
  return out;
}

export async function getControl(itemId: string) {
  const [own] = await db.select().from(custodyControls).where(eq(custodyControls.itemId, itemId)).limit(1);
  const effective = (await controlsFor([itemId])).get(itemId) ?? null;
  return { own: own ?? null, effective };
}

/** Mark or unmark an item (or container) as custody-controlled. Published either way. */
export async function setControl(itemId: string, controlled: boolean, reason: string | null, actor: Actor) {
  const [item] = await db.select({ id: items.id, assetCode: items.assetCode, name: items.name }).from(items).where(eq(items.id, itemId)).limit(1);
  if (!item) throw notFound("Item not found");
  const [before] = await db.select().from(custodyControls).where(eq(custodyControls.itemId, itemId)).limit(1);
  if (controlled) {
    const r = reason?.trim().slice(0, 500) || null;
    await db
      .insert(custodyControls)
      .values({ itemId, reason: r, setBy: actor.userOid })
      .onConflictDoUpdate({ target: custodyControls.itemId, set: { reason: r } });
  } else {
    await db.delete(custodyControls).where(eq(custodyControls.itemId, itemId));
  }
  if (Boolean(before) !== controlled || (controlled && before?.reason !== (reason?.trim() || null))) {
    await publish(
      "custody.control_changed",
      { assetCode: item.assetCode, name: item.name, controlled, reason: reason?.trim() || null, previouslyControlled: Boolean(before) },
      { actor: actorFromOid(actor.userOid, actor.name), subject: { type: "item", id: itemId } },
    );
    logger.info("custody.control.changed", { itemId, controlled });
  }
  return getControl(itemId);
}

/** The guard itself, exported so tests can call it with a context of their own. */
export async function custodyGuard(ctx: StageGuardContext) {
  if (!GUARDED_STAGES.has(ctx.stage) || !ctx.lines.length) return [];
  // With the feature off its screens are gone, so there would be no way to
  // record the transfer the guard asks for.
  if (!(await getConfig()).features.custody) return [];
  const controls = await controlsFor(ctx.lines.map((l) => l.itemId));
  if (!controls.size) return [];

  const controlled = ctx.lines.filter((l) => controls.has(l.itemId));
  const itemIds = [...new Set(controlled.map((l) => l.itemId))];
  const [added, coverage] = await Promise.all([
    db
      .select({ id: jobItems.id, createdAt: jobItems.createdAt })
      .from(jobItems)
      .where(inArray(jobItems.id, controlled.map((l) => l.jobItemId))),
    db
      .select({
        itemId: custodyTransferItems.itemId,
        unitId: custodyTransferItems.unitId,
        outcome: custodyTransferItems.outcome,
        jobId: custodyTransfers.jobId,
        completedAt: custodyTransfers.completedAt,
      })
      .from(custodyTransferItems)
      .innerJoin(custodyTransfers, eq(custodyTransferItems.transferId, custodyTransfers.id))
      .where(
        and(
          inArray(custodyTransferItems.itemId, itemIds),
          eq(custodyTransfers.status, "completed"),
          eq(custodyTransfers.purpose, "delivery"),
        ),
      ),
  ]);
  const addedAt = new Map(added.map((a) => [a.id, a.createdAt]));
  return custodyVetoes(
    ctx.stage,
    ctx.jobId,
    controlled.map((l) => ({
      jobItemId: l.jobItemId,
      itemId: l.itemId,
      unitId: l.unitId,
      addedAt: addedAt.get(l.jobItemId) ?? new Date(0),
    })),
    controls,
    coverage.map((c): Coverage => ({ ...c, completedAt: c.completedAt ?? new Date(0) })),
  );
}

let registered = false;

/** Called once when the feature's module loads. */
export function registerCustodyGuard(): void {
  if (registered) return;
  registered = true;
  registerStageGuard("custody", custodyGuard);
}
