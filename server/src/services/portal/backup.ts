import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { portalGrants, portalNotes } from "../../db/schema";
import type { Executor } from "../jobs-core/shared";

/**
 * Portal links and crew notes in the instance backup. services/backup.ts
 * lists the tables and calls these, as it does for jobs.
 *
 * Link tokens are secrets and stay out of the file, like device tokens. On a
 * restore, a grant that still exists keeps its current token, and stays
 * revoked (or expires sooner) if that happened after the file was written: a
 * restore must never bring a revoked link back. A grant that exists only in
 * the file comes back without a link until someone reissues it. Codes,
 * browser passes and the notification log are not backed up.
 */

export const PORTAL_TABLES = ["portal_grants", "portal_notes"] as const;
export type PortalTable = (typeof PORTAL_TABLES)[number];

export async function exportPortalTables(): Promise<Record<PortalTable, Record<string, unknown>[]>> {
  const [grants, notes] = await Promise.all([
    db
      .select()
      .from(portalGrants)
      .then((rows) => rows.map(({ tokenHash: _h, tokenLast4: _l, ...g }) => g)),
    db.select().from(portalNotes),
  ]);
  return { portal_grants: grants, portal_notes: notes };
}

/**
 * Park the secrets and revocations of the current grants. Call before jobs are
 * cleared: deleting a job deletes its grants.
 */
export async function keepPortalSecrets(tx: Executor): Promise<void> {
  await tx.execute(sql`
    CREATE TEMP TABLE backup_kept_portal ON COMMIT DROP AS
    SELECT id, token_hash, token_last4, revoked_at, revoked_by, expires_at FROM portal_grants`);
}

const TARGET_EXISTS = sql`(
  (g.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM projects p WHERE p.id = g.project_id))
  OR (g.job_id IS NOT NULL AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = g.job_id))
  OR (g.shipment_id IS NOT NULL AND EXISTS (SELECT 1 FROM shipments s WHERE s.id = g.shipment_id)))`;

const toSnake = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      v instanceof Date ? v.toISOString() : v,
    ]),
  );

const STAGING = {
  portal_grants: { temp: sql.raw("backup_portal_grants"), like: sql.raw("portal_grants") },
  portal_notes: { temp: sql.raw("backup_portal_notes"), like: sql.raw("portal_notes") },
} as const;

/** Stage rows in a temp table shaped like the real one, through JSON, 500 at a time. */
async function stage(tx: Executor, table: PortalTable, rows: Record<string, unknown>[]): Promise<void> {
  const { temp, like } = STAGING[table];
  await tx.execute(sql`CREATE TEMP TABLE ${temp} (LIKE ${like}) ON COMMIT DROP`);
  for (let i = 0; i < rows.length; i += 500) {
    const json = JSON.stringify(rows.slice(i, i + 500).map(toSnake));
    await tx.execute(sql`INSERT INTO ${temp} SELECT * FROM json_populate_recordset(NULL::${like}, ${json}::json)`);
  }
}

/**
 * After jobs are restored: put the file's grants and notes back. Both are
 * staged first, so a grant whose project, job or shipment is not in the
 * snapshot (or a note whose line is not) is dropped rather than failing the
 * whole restore on a foreign key.
 */
export async function restorePortalTables(
  tx: Executor,
  data: Record<PortalTable, Record<string, unknown>[]>,
): Promise<void> {
  await tx.delete(portalNotes);
  await tx.delete(portalGrants);
  // A token in the file did not come from this server's export; never trust one.
  const grants = data.portal_grants.map(({ tokenHash: _h, tokenLast4: _l, ...g }) => ({
    ...g,
    tokenHash: null,
    tokenLast4: null,
  }));
  if (grants.length) {
    await stage(tx, "portal_grants", grants);
    await tx.execute(sql`INSERT INTO portal_grants SELECT g.* FROM backup_portal_grants g WHERE ${TARGET_EXISTS}`);
    await tx.execute(sql`
      UPDATE portal_grants g
         SET token_hash = k.token_hash,
             token_last4 = k.token_last4,
             revoked_at = COALESCE(k.revoked_at, g.revoked_at),
             revoked_by = COALESCE(k.revoked_by, g.revoked_by),
             expires_at = LEAST(k.expires_at, g.expires_at)
        FROM backup_kept_portal k
       WHERE k.id = g.id`);
  }
  if (data.portal_notes.length) {
    await stage(tx, "portal_notes", data.portal_notes);
    await tx.execute(sql`
      INSERT INTO portal_notes (id, grant_id, author, job_id, job_item_id, item_id, unit_id, condition, body, created_at)
      SELECT n.id, CASE WHEN EXISTS (SELECT 1 FROM portal_grants g WHERE g.id = n.grant_id) THEN n.grant_id END,
             n.author, n.job_id, n.job_item_id, n.item_id,
             CASE WHEN EXISTS (SELECT 1 FROM item_units u WHERE u.id = n.unit_id) THEN n.unit_id END,
             n.condition, n.body, n.created_at
        FROM backup_portal_notes n
       WHERE EXISTS (SELECT 1 FROM job_items ji WHERE ji.id = n.job_item_id)
         AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = n.job_id)
         AND EXISTS (SELECT 1 FROM items i WHERE i.id = n.item_id)`);
  }
}
