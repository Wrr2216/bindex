import { sql } from "drizzle-orm";
import {
  hvDeclarationLines,
  hvDeclarations,
  receiptLines,
  receipts,
  serviceRecords,
  servicePlans,
  valuationProfiles,
  valuations,
} from "../../db/tables/valuation";
import { db } from "../../db/client";

/**
 * This feature's part of the JSON backup, kept here so services/backup.ts
 * only gains a few calls. Receipt and declaration files and signatures are
 * attachments, which the backup leaves out like every other binary; they stay
 * in the database across a restore and are kept for every receipt and
 * declaration that exists afterwards.
 */

export const VALUATION_TABLES = [
  "valuations",
  "valuation_profiles",
  "service_plans",
  "service_records",
  "receipts",
  "receipt_lines",
  "hv_declarations",
  "hv_declaration_lines",
] as const;
export type ValuationTable = (typeof VALUATION_TABLES)[number];

/** Timestamp columns (not the plain dates, which stay strings) revived on import. */
export const VALUATION_DATE_FIELDS: Record<ValuationTable, string[]> = {
  valuations: ["createdAt"],
  valuation_profiles: ["usageReadAt", "createdAt", "updatedAt"],
  service_plans: ["startsAt", "lastDoneAt", "createdAt", "updatedAt"],
  service_records: ["doneAt", "createdAt"],
  receipts: ["createdAt", "updatedAt", "confirmedAt"],
  receipt_lines: [],
  hv_declarations: ["signedAt", "createdAt", "updatedAt"],
  hv_declaration_lines: [],
};

type Rows = Record<string, unknown>[];

export async function valuationBackupData(): Promise<Record<ValuationTable, Rows>> {
  const [v, p, sp, sr, r, rl, d, dl] = await Promise.all([
    db.select().from(valuations),
    db.select().from(valuationProfiles),
    db.select().from(servicePlans),
    db.select().from(serviceRecords),
    db.select().from(receipts),
    db.select().from(receiptLines),
    db.select().from(hvDeclarations),
    db.select().from(hvDeclarationLines),
  ]);
  return {
    valuations: v,
    valuation_profiles: p,
    service_plans: sp,
    service_records: sr,
    receipts: r,
    receipt_lines: rl,
    hv_declarations: d,
    hv_declaration_lines: dl,
  };
}

/**
 * Whether a backup file carries this feature's tables. Checked before the
 * file is parsed, which fills absent tables with empty lists: a file written
 * before this feature existed must leave its data alone, while a newer file
 * with empty lists means there was none.
 */
export function valuationTablesPresent(input: unknown): boolean {
  const data = (input as { data?: Record<string, unknown> } | null)?.data;
  return Boolean(data && VALUATION_TABLES.every((t) => Array.isArray(data[t])));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Item-scoped tables, which go with their items when a restore deletes them.
const ITEM_SCOPED = ["valuations", "valuation_profiles", "service_plans", "service_records"] as const;

/**
 * First step of a restore, before the core tables are cleared. With the
 * tables in the file, everything here is replaced; without them, the
 * item-scoped rows are set aside to be put back for items that survive.
 */
export async function beforeValuationRestore(tx: Tx, present: boolean): Promise<void> {
  if (present) {
    await tx.execute(sql`DELETE FROM hv_declaration_lines`);
    await tx.execute(sql`DELETE FROM hv_declarations`);
    await tx.execute(sql`DELETE FROM receipt_lines`);
    await tx.execute(sql`DELETE FROM receipts`);
    await tx.execute(sql`DELETE FROM service_records`);
    await tx.execute(sql`DELETE FROM service_plans`);
    await tx.execute(sql`DELETE FROM valuation_profiles`);
    await tx.execute(sql`DELETE FROM valuations`);
    return;
  }
  for (const t of ITEM_SCOPED) {
    await tx.execute(sql.raw(`CREATE TEMP TABLE backup_kept_${t} ON COMMIT DROP AS SELECT * FROM ${t}`));
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Last step of a restore, after items and units are back. */
export async function afterValuationRestore(tx: Tx, data: Record<string, Rows>, present: boolean): Promise<void> {
  if (!present) {
    // An older file: put back what belongs to items and units that still exist.
    for (const t of ITEM_SCOPED) {
      if (t === "service_records") {
        // The log outlives a plan that did not come back.
        await tx.execute(sql`UPDATE backup_kept_service_records k SET plan_id = NULL
                              WHERE plan_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_plans p WHERE p.id = k.plan_id)`);
      }
      await tx.execute(
        sql.raw(`INSERT INTO ${t} SELECT k.* FROM backup_kept_${t} k
                  WHERE EXISTS (SELECT 1 FROM items i WHERE i.id = k.item_id)
                    AND (k.unit_id IS NULL OR EXISTS (SELECT 1 FROM item_units u WHERE u.id = k.unit_id))`),
      );
    }
    return;
  }

  const itemIds = new Set(((await tx.execute(sql`SELECT id FROM items`)).rows as { id: string }[]).map((r) => r.id));
  const unitIds = new Set(((await tx.execute(sql`SELECT id FROM item_units`)).rows as { id: string }[]).map((r) => r.id));
  // A row about an item or unit the file does not have cannot be restored.
  const owned = (rows: Rows) => rows.filter((r) => itemIds.has(r.itemId as string) && (!r.unitId || unitIds.has(r.unitId as string)));

  const plans = owned(data.service_plans ?? []);
  const planIds = new Set(plans.map((p) => p.id as string));
  const records = owned(data.service_records ?? []).map((r) => (r.planId && !planIds.has(r.planId as string) ? { ...r, planId: null } : r));
  const receiptIds = new Set((data.receipts ?? []).map((r) => r.id as string));
  const declIds = new Set((data.hv_declarations ?? []).map((r) => r.id as string));

  const steps: [Parameters<Tx["insert"]>[0], Rows][] = [
    [valuations, owned(data.valuations ?? [])],
    [valuationProfiles, owned(data.valuation_profiles ?? [])],
    [servicePlans, plans],
    [serviceRecords, records],
    [receipts, data.receipts ?? []],
    [receiptLines, (data.receipt_lines ?? []).filter((l) => receiptIds.has(l.receiptId as string))],
    [hvDeclarations, data.hv_declarations ?? []],
    [hvDeclarationLines, (data.hv_declaration_lines ?? []).filter((l) => declIds.has(l.declarationId as string))],
  ];
  for (const [table, rows] of steps) {
    for (const part of chunk(rows, 500)) await tx.insert(table).values(part as never);
  }
  // New declarations continue after the highest restored number.
  await tx.execute(sql`
    SELECT setval('hv_declaration_code_seq',
                  greatest(coalesce((SELECT max(substring(code FROM 5)::bigint) FROM hv_declarations WHERE code ~ '^HVI-[0-9]+$'), 0), 1),
                  (SELECT count(*) > 0 FROM hv_declarations WHERE code ~ '^HVI-[0-9]+$'))`);
}
