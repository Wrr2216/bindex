import { pool } from "../../db/client";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";

/**
 * Geofence crossings are location history, so they are kept exactly as long
 * as sightings (SIGHTINGS_RETENTION_DAYS). Each one is also in the audit log,
 * which keeps everything; this only trims the table the map screens read.
 */
export async function pruneGeofenceEvents(days = env.SIGHTINGS_RETENTION_DAYS): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
  let removed = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM geofence_events WHERE id IN (SELECT id FROM geofence_events WHERE occurred_at < $1 LIMIT 50000)`,
      [cutoff],
    );
    removed += rowCount ?? 0;
    if (!rowCount || rowCount < 50_000) break;
  }
  return removed;
}

/** Once shortly after boot, then daily, alongside the sightings prune. */
export function startGpsPrune(): void {
  const run = () =>
    pruneGeofenceEvents()
      .then((removed) => {
        if (removed) logger.info("gps.prune.done", { removed, retentionDays: env.SIGHTINGS_RETENTION_DAYS });
      })
      .catch((err) => logger.warn("gps.prune.failed", { err: describeError(err) }));
  setTimeout(run, 90_000).unref();
  setInterval(run, 24 * 60 * 60_000).unref();
}
