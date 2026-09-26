import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { conditionReports, conditionSweeps, containerCaptures } from "../../db/tables/ai-condition";

/**
 * Condition records in the JSON backup (services/backup.ts calls these).
 *
 * The rows point at items, units and locations, which a restore deletes and
 * re-inserts, so the restore stages them in temporary tables first: from the
 * file when it has any, otherwise the ones already here (a file written before
 * this feature existed should not wipe them). Rows whose item or unit is not
 * in the restored data are dropped, as the foreign keys would have done.
 */

export const AI_CONDITION_DATE_FIELDS = {
  condition_sweeps: ["startedAt", "closedAt"],
  condition_reports: ["createdAt", "updatedAt"],
  container_captures: ["createdAt"],
};

type Tables = keyof typeof AI_CONDITION_DATE_FIELDS;
const TABLES: Tables[] = ["condition_sweeps", "condition_reports", "container_captures"];

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function aiConditionBackupRows(): Promise<Record<Tables, Record<string, unknown>[]>> {
  const [sweeps, reports, captures] = await Promise.all([
    db.select().from(conditionSweeps),
    db.select().from(conditionReports),
    db.select().from(containerCaptures),
  ]);
  return { condition_sweeps: sweeps, condition_reports: reports, container_captures: captures };
}

/** Before the restore deletes anything: set the current rows aside and clear the tables. */
export async function parkAiConditionRows(tx: Tx): Promise<void> {
  for (const t of TABLES) {
    await tx.execute(sql.raw(`CREATE TEMP TABLE backup_kept_${t} ON COMMIT DROP AS SELECT * FROM ${t}`));
  }
  // Children first; sweeps would otherwise lose their location when locations go.
  await tx.execute(sql`DELETE FROM condition_reports`);
  await tx.execute(sql`DELETE FROM container_captures`);
  await tx.execute(sql`DELETE FROM condition_sweeps`);
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const toColumns = (rows: Record<string, unknown>[]) =>
  rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [snake(k), v])));

/** After items, units and locations are back: put the condition rows back. */
export async function restoreAiConditionRows(tx: Tx, data: Record<Tables, Record<string, unknown>[]>): Promise<void> {
  if (TABLES.some((t) => data[t].length)) {
    for (const t of TABLES) {
      await tx.execute(sql.raw(`TRUNCATE backup_kept_${t}`));
      if (!data[t].length) continue;
      await tx.execute(
        sql`INSERT INTO ${sql.raw(`backup_kept_${t}`)}
            SELECT * FROM jsonb_populate_recordset(NULL::${sql.raw(t)}, ${JSON.stringify(toColumns(data[t]))}::jsonb)`,
      );
    }
  }
  await tx.execute(sql`
    UPDATE backup_kept_condition_sweeps k SET location_id = NULL
     WHERE location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = k.location_id)`);
  await tx.execute(sql`
    DELETE FROM backup_kept_condition_reports k
     WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = k.item_id)
        OR (k.unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM item_units u WHERE u.id = k.unit_id))`);
  await tx.execute(sql`
    UPDATE backup_kept_condition_reports k SET sweep_id = NULL
     WHERE sweep_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM backup_kept_condition_sweeps s WHERE s.id = k.sweep_id)`);
  await tx.execute(sql`
    DELETE FROM backup_kept_container_captures k WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = k.item_id)`);
  for (const t of TABLES) {
    await tx.execute(sql.raw(`INSERT INTO ${t} SELECT * FROM backup_kept_${t}`));
  }
}
