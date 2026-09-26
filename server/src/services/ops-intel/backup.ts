import { inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { db } from "../../db/client";
import type * as schema from "../../db/schema";
import { locations, opsLocationProfiles } from "../../db/schema";

/** The database or an open transaction. */
type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

/**
 * Location profiles in the instance backup. Anomalies and runs are left out:
 * they are rebuilt by the next run, and every change to them is already in
 * the audit log. Thresholds live with the rest of the instance configuration,
 * which the backup does not carry either.
 */

export async function exportOpsIntelTables(): Promise<{ ops_location_profiles: Record<string, unknown>[] }> {
  return { ops_location_profiles: await db.select().from(opsLocationProfiles) };
}

/**
 * Put the snapshot's profiles back, after its locations. A file with none (one
 * written before this feature) leaves the current profiles alone, the way job
 * types are kept; the profiles have no foreign key, so the restore's location
 * wipe did not touch them either.
 */
export async function restoreOpsIntelTables(
  tx: Executor,
  data: { ops_location_profiles: Record<string, unknown>[] },
): Promise<void> {
  const rows = data.ops_location_profiles;
  if (!rows.length) return;
  await tx.delete(opsLocationProfiles);
  const ids = rows.map((r) => r.locationId as string).filter(Boolean);
  const present = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const found = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(inArray(locations.id, ids.slice(i, i + 500)));
    for (const f of found) present.add(f.id);
  }
  const kept = rows.filter((r) => present.has(r.locationId as string));
  for (let i = 0; i < kept.length; i += 500) {
    await tx.insert(opsLocationProfiles).values(kept.slice(i, i + 500) as never);
  }
}
