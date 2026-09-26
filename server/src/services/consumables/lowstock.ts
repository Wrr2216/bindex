import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { notify, type Notification } from "../../lib/notify";
import { getConfig } from "../config";
import { dayKey, formatDigest, isDue, type LowStockRow } from "./digest";
import { toQty, toQtyOrNull } from "./ledger";

/**
 * Items at or below their reorder point, one row per location. An item with a
 * reorder point that is not stocked anywhere at all is listed once with no
 * location, since running out everywhere is the most urgent case of all.
 */
export async function listLowStock(): Promise<LowStockRow[]> {
  const res = await db.execute<{
    item_id: string;
    item_name: string;
    unit: string;
    location_id: string | null;
    location_name: string | null;
    qty: string | null;
    reorder_point: string;
    reorder_qty: string | null;
    supplier: string | null;
  }>(sql`
    SELECT c.item_id, i.name AS item_name, c.unit, s.location_id, l.name AS location_name,
           s.qty, c.reorder_point, c.reorder_qty, c.supplier
      FROM consumable_items c
      JOIN items i ON i.id = c.item_id
      JOIN stock_levels s ON s.item_id = c.item_id
      JOIN locations l ON l.id = s.location_id
     WHERE c.reorder_point IS NOT NULL AND s.qty <= c.reorder_point
    UNION ALL
    SELECT c.item_id, i.name, c.unit, NULL, NULL, NULL, c.reorder_point, c.reorder_qty, c.supplier
      FROM consumable_items c
      JOIN items i ON i.id = c.item_id
     WHERE c.reorder_point IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM stock_levels s WHERE s.item_id = c.item_id)
     ORDER BY 5 NULLS LAST, 2`);
  return res.rows.map((r) => ({
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit,
    locationId: r.location_id,
    locationName: r.location_name,
    qty: toQty(r.qty),
    reorderPoint: toQty(r.reorder_point),
    reorderQty: toQtyOrNull(r.reorder_qty),
    supplier: r.supplier,
  }));
}

export type DigestOutcome =
  | "disabled"
  | "feature_off"
  | "not_configured"
  | "not_yet"
  | "already_sent"
  | "nothing_low"
  | "sent"
  | "failed";

type DigestDeps = {
  now?: Date;
  hour?: number;
  send?: (n: Notification) => Promise<boolean>;
  /** Overrides the check for a configured notification destination. */
  configured?: boolean;
  /** Overrides the feature switch. */
  enabled?: boolean;
};

/**
 * Send the low-stock digest if today's has not gone out yet. Safe to call as
 * often as you like: the day is claimed with an insert before anything is
 * sent, so restarts and extra replicas cannot send it twice, and a delivery
 * that fails gives the claim back so the next check retries.
 */
export async function runLowStockDigest(deps: DigestDeps = {}): Promise<{ outcome: DigestOutcome; low: number }> {
  const now = deps.now ?? new Date();
  const hour = deps.hour ?? env.CONSUMABLES_DIGEST_HOUR;
  if (hour < 0) return { outcome: "disabled", low: 0 };
  const enabled = deps.enabled ?? (await getConfig()).features.consumables;
  if (!enabled) return { outcome: "feature_off", low: 0 };
  const configured = deps.configured ?? (env.pushoverConfigured || env.wazuhConfigured);
  if (!configured) return { outcome: "not_configured", low: 0 };
  if (!isDue(now, hour)) return { outcome: "not_yet", low: 0 };

  const day = dayKey(now);
  const claim = await db.execute<{ day: string }>(
    sql`INSERT INTO consumable_digest_runs (day) VALUES (${day}) ON CONFLICT (day) DO NOTHING RETURNING day`,
  );
  if (!claim.rows.length) return { outcome: "already_sent", low: 0 };

  let rows: LowStockRow[];
  try {
    rows = await listLowStock();
  } catch (err) {
    await db.execute(sql`DELETE FROM consumable_digest_runs WHERE day = ${day}`);
    throw err;
  }
  await db.execute(sql`UPDATE consumable_digest_runs SET low_count = ${rows.length} WHERE day = ${day}`);
  if (!rows.length) return { outcome: "nothing_low", low: 0 };

  let delivered = false;
  try {
    delivered = await (deps.send ?? notify)(formatDigest(rows));
  } catch (err) {
    logger.warn("consumables.low_stock_digest.send_error", { err: describeError(err) });
  }
  if (!delivered) {
    await db.execute(sql`DELETE FROM consumable_digest_runs WHERE day = ${day}`);
    logger.warn("consumables.low_stock_digest.failed", { day, low: rows.length });
    return { outcome: "failed", low: rows.length };
  }
  logger.info("consumables.low_stock_digest.sent", { day, low: rows.length });
  return { outcome: "sent", low: rows.length };
}

/**
 * Check hourly, so the digest goes out within the hour after
 * CONSUMABLES_DIGEST_HOUR and a server that was down at that hour still
 * sends it once it is back.
 */
export function startLowStockDigest(): void {
  if (env.CONSUMABLES_DIGEST_HOUR < 0) return;
  const run = () =>
    runLowStockDigest().catch((err) =>
      logger.warn("consumables.low_stock_digest.error", { err: describeError(err) }),
    );
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
  logger.info("consumables.low_stock_digest.scheduled", { hour: env.CONSUMABLES_DIGEST_HOUR });
}
