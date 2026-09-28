import { pool } from "../../db/client";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";

/** Rows per delete, so pruning a large backlog never holds one long lock. */
const BATCH = 50_000;

/**
 * Delete sightings older than the retention window, and sightings of items
 * that have since been deleted. Positions are not touched: they are the
 * latest state, not history.
 */
export async function pruneSightings(days = env.SIGHTINGS_RETENTION_DAYS): Promise<number> {
  let removed = 0;
  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
    for (;;) {
      const { rowCount } = await pool.query(
        `DELETE FROM sightings WHERE id IN (SELECT id FROM sightings WHERE observed_at < $1 LIMIT ${BATCH})`,
        [cutoff],
      );
      removed += rowCount ?? 0;
      if (!rowCount || rowCount < BATCH) break;
    }
  }
  // Sightings carry no foreign keys (see the migration), so a deleted item's
  // history is removed here rather than by a cascade.
  const { rowCount: orphans } = await pool.query(
    `DELETE FROM sightings s
      WHERE s.item_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = s.item_id)`,
  );
  return removed + (orphans ?? 0);
}

/** Prune once shortly after boot, then daily. */
export function startSightingsPrune(): void {
  const run = () =>
    pruneSightings()
      .then((removed) => {
        if (removed) logger.info("tracking.prune.done", { removed, retentionDays: env.SIGHTINGS_RETENTION_DAYS });
      })
      .catch((err) => logger.warn("tracking.prune.failed", { err: describeError(err) }));
  setTimeout(run, 60_000).unref();
  setInterval(run, 24 * 60 * 60_000).unref();
}
