import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { crewCheckins, crewCredentialTypes, crewCredentials, crewWorkers } from "../../db/schema";
import type { Executor } from "./shared";

/**
 * Crew in the instance backup. services/backup.ts lists these tables and calls
 * the three functions below. Photos and credential documents are attachments,
 * which the JSON backup leaves out like every other file; a worker restored
 * onto a new instance keeps everything but the pictures.
 */

/** Parent-before-child order, which is also the insert order. Check-ins come after jobs. */
export const CREW_TABLES = ["crew_credential_types", "crew_workers", "crew_credentials", "crew_checkins"] as const;
export type CrewTable = (typeof CREW_TABLES)[number];

const TABLE = {
  crew_credential_types: crewCredentialTypes,
  crew_workers: crewWorkers,
  crew_credentials: crewCredentials,
  crew_checkins: crewCheckins,
} as const;

export async function exportCrewTables(): Promise<Record<CrewTable, Record<string, unknown>[]>> {
  const rows: Record<string, unknown>[][] = await Promise.all(CREW_TABLES.map((t) => db.select().from(TABLE[t])));
  const out = {} as Record<CrewTable, Record<string, unknown>[]>;
  CREW_TABLES.forEach((t, i) => {
    out[t] = rows[i]!;
  });
  return out;
}

/** A file written before crew existed has none of these tables. */
export const predatesCrew = (data: Record<CrewTable, unknown[]>): boolean => CREW_TABLES.every((t) => data[t].length === 0);

/**
 * Clear crew before a restore, which has to happen before jobs are cleared:
 * check-ins hold workers, and workers cannot be deleted while they do.
 *
 * Restoring a file from before crew existed keeps the workers, credentials
 * and types (the file never had them), and parks the check-ins until the jobs
 * are back, keeping those whose job still exists.
 */
export async function clearCrewTables(tx: Executor, opts: { keep: boolean }): Promise<void> {
  if (opts.keep) {
    await tx.execute(sql`CREATE TEMP TABLE backup_kept_crew_checkins ON COMMIT DROP AS SELECT * FROM crew_checkins`);
    await tx.delete(crewCheckins);
    return;
  }
  for (const t of [...CREW_TABLES].reverse()) await tx.delete(TABLE[t]);
}

export async function restoreCrewTables(
  tx: Executor,
  data: Record<CrewTable, Record<string, unknown>[]>,
  opts: { keep: boolean },
): Promise<void> {
  if (opts.keep) {
    await tx.execute(sql`
      INSERT INTO crew_checkins SELECT k.* FROM backup_kept_crew_checkins k
      WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.id = k.job_id)`);
    return;
  }
  for (const t of CREW_TABLES) {
    const rows = data[t];
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(TABLE[t]).values(rows.slice(i, i + 500) as never);
    }
  }
}
