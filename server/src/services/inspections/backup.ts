import { eq, sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import type * as schema from "../../db/schema";
import { inspectionFindings, inspections } from "../../db/schema";

/** The database or the restore's open transaction. */
type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

/**
 * Inspections in the instance backup. services/backup.ts lists the tables and
 * calls these two functions, so the backup format stays in one place and the
 * knowledge of these tables stays here.
 *
 * Share links are left out, like API keys: they grant access. A restore keeps
 * the current links of every inspection that still exists afterwards. Photos
 * and signatures are T02's and are kept the same way T02 keeps them.
 */

export const INSPECTION_TABLES = ["inspections", "inspection_findings"] as const;
export type InspectionTable = (typeof INSPECTION_TABLES)[number];

export async function exportInspectionTables(): Promise<Record<InspectionTable, Record<string, unknown>[]>> {
  const [rows, findings] = await Promise.all([db.select().from(inspections), db.select().from(inspectionFindings)]);
  return { inspections: rows, inspection_findings: findings };
}

/**
 * Replace inspections with the snapshot's. Runs last in the restore
 * transaction, after the jobs, tasks and locations they point at are back.
 */
export async function restoreInspectionTables(
  tx: Executor,
  data: Record<InspectionTable, Record<string, unknown>[]>,
): Promise<void> {
  await tx.execute(sql`CREATE TEMP TABLE backup_kept_inspection_shares ON COMMIT DROP AS SELECT * FROM inspection_shares`);
  await tx.delete(inspections);

  // Both tables point at themselves (a post-inspection at its pre-inspection,
  // a finding at the one it was paired with), so rows go in without those
  // links and get them back once every row exists.
  const preLinks = new Map<string, string>();
  const rows = data.inspections.map((r) => {
    if (r.preInspectionId) preLinks.set(r.id as string, r.preInspectionId as string);
    return { ...r, preInspectionId: null };
  });
  for (let i = 0; i < rows.length; i += 500) await tx.insert(inspections).values(rows.slice(i, i + 500) as never);
  for (const [id, preId] of preLinks) {
    await tx.update(inspections).set({ preInspectionId: preId }).where(eq(inspections.id, id));
  }

  const pairLinks = new Map<string, string>();
  const findings = data.inspection_findings.map((r) => {
    if (r.pairedWithId) pairLinks.set(r.id as string, r.pairedWithId as string);
    return { ...r, pairedWithId: null };
  });
  for (let i = 0; i < findings.length; i += 500) {
    await tx.insert(inspectionFindings).values(findings.slice(i, i + 500) as never);
  }
  for (const [id, pairedWithId] of pairLinks) {
    await tx.update(inspectionFindings).set({ pairedWithId }).where(eq(inspectionFindings.id, id));
  }

  await tx.execute(sql`
    INSERT INTO inspection_shares
    SELECT k.* FROM backup_kept_inspection_shares k
    WHERE EXISTS (SELECT 1 FROM inspections i WHERE i.id = k.inspection_id)`);
}
