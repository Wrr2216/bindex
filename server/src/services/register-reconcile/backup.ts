import { db } from "../../db/client";
import { itemUnits } from "../../db/schema";
import {
  reconciliationResults,
  reconciliationRuns,
  registerImports,
  registerLocationMap,
  registerRows,
} from "../../db/tables/register-reconcile";

/**
 * Registers, remembered location mappings and reconciliation runs in the JSON
 * backup. Kept here so the shared backup module only needs a line or two.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Rows = Record<string, unknown>[];

export const REGISTER_BACKUP_TABLES = [
  "register_imports",
  "register_rows",
  "register_location_map",
  "reconciliation_runs",
  "reconciliation_results",
] as const;

export const REGISTER_BACKUP_DATE_FIELDS = {
  register_imports: ["createdAt", "updatedAt"],
  register_rows: [],
  register_location_map: ["createdAt", "updatedAt"],
  reconciliation_runs: ["createdAt"],
  reconciliation_results: ["resolvedAt"],
};

export async function registerBackupData() {
  const [imports, rows, mapping, runs, results] = await Promise.all([
    db.select().from(registerImports),
    db.select().from(registerRows),
    db.select().from(registerLocationMap),
    db.select().from(reconciliationRuns),
    db.select().from(reconciliationResults),
  ]);
  return {
    register_imports: imports as Rows,
    register_rows: rows as Rows,
    register_location_map: mapping as Rows,
    reconciliation_runs: runs as Rows,
    reconciliation_results: results as Rows,
  };
}

/** Before the inventory is replaced, so no foreign key cascades into these. */
export async function clearRegisterTables(tx: Tx): Promise<void> {
  await tx.delete(reconciliationResults);
  await tx.delete(reconciliationRuns);
  await tx.delete(registerRows);
  await tx.delete(registerImports);
  await tx.delete(registerLocationMap);
}

function chunk<T>(arr: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * After the inventory is back. References to anything the snapshot does not
 * hold are dropped rather than failing the restore on a foreign key.
 */
export async function restoreRegisterTables(
  tx: Tx,
  d: Record<(typeof REGISTER_BACKUP_TABLES)[number] | "items" | "locations" | "companies", Rows>,
): Promise<void> {
  const itemIds = new Set(d.items.map((r) => r.id as string));
  const locationIds = new Set(d.locations.map((r) => r.id as string));
  const companyIds = new Set(d.companies.map((r) => r.id as string));
  const unitIds = new Set((await tx.select({ id: itemUnits.id }).from(itemUnits)).map((u) => u.id));
  const keep = (set: Set<string>, v: unknown) => (typeof v === "string" && set.has(v) ? v : null);

  const importIds = new Set(d.register_imports.map((r) => r.id as string));
  const rows: Rows = d.register_rows
    .filter((r) => importIds.has(r.importId as string))
    .map((r) => ({ ...r, createdItemId: keep(itemIds, r.createdItemId) }));
  const rowIds = new Set(rows.map((r) => r.id as string));
  const runs: Rows = d.reconciliation_runs
    .filter((r) => importIds.has(r.importId as string))
    .map((r) => ({
      ...r,
      scopeCompanyId: keep(companyIds, r.scopeCompanyId),
      scopeLocationId: keep(locationIds, r.scopeLocationId),
    }));
  const runIds = new Set(runs.map((r) => r.id as string));
  const results = d.reconciliation_results
    .filter((r) => runIds.has(r.runId as string))
    .map((r) => ({
      ...r,
      rowId: keep(rowIds, r.rowId),
      itemId: keep(itemIds, r.itemId),
      unitId: keep(unitIds, r.unitId),
    }));
  const mapping = d.register_location_map.filter((r) => locationIds.has(r.locationId as string));

  for (const part of chunk(d.register_imports)) await tx.insert(registerImports).values(part as never);
  for (const part of chunk(rows)) await tx.insert(registerRows).values(part as never);
  for (const part of chunk(mapping)) await tx.insert(registerLocationMap).values(part as never);
  for (const part of chunk(runs)) await tx.insert(reconciliationRuns).values(part as never);
  for (const part of chunk(results)) await tx.insert(reconciliationResults).values(part as never);
}
