import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { locations } from "../../db/schema";
import {
  reconciliationRuns,
  registerImports,
  registerLocationMap,
  registerRows,
  type ColumnMapping,
  type RegisterEdit,
  type RegisterField,
  type RegisterPreset,
} from "../../db/tables/register-reconcile";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { CsvError } from "./csv";
import { readRegisterFile } from "./file";
import { buildLocationIndex, type LocationIndex } from "./locationIndex";
import { normalizeLocationText } from "./normalize";
import {
  autoMap,
  dayFirstForLocale,
  detectPreset,
  FIELDS,
  normalizeRow,
  type NormalizedRow,
} from "./presets";

const CHUNK = 1000;

function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const FIELD_KEYS = new Set<string>(FIELDS.map((f) => f.key));

/** Column name for each normalised field, in register_rows. */
const COLUMN: Record<Exclude<RegisterField, "cost">, string> & { cost: string } = {
  assetTag: "asset_tag",
  serial: "serial",
  epc: "epc",
  bindexCode: "bindex_code",
  name: "name",
  model: "model",
  brand: "brand",
  category: "category",
  description: "description",
  locationText: "location_text",
  custodian: "custodian",
  cost: "cost_cents",
  purchaseDate: "purchase_date",
  quantity: "quantity",
};

function rowValues(n: NormalizedRow) {
  return {
    assetTag: n.assetTag,
    serial: n.serial,
    epc: n.epc,
    bindexCode: n.bindexCode,
    name: n.name,
    model: n.model,
    brand: n.brand,
    category: n.category,
    description: n.description,
    locationText: n.locationText,
    custodian: n.custodian,
    costCents: n.costCents,
    purchaseDate: n.purchaseDate,
    quantity: n.quantity,
    issues: n.issues,
  };
}

/** Changes copied into the register win over a re-read of the file. */
function applyEdits(n: NormalizedRow, edits: Record<string, RegisterEdit>): NormalizedRow {
  const out = { ...n };
  for (const [field, edit] of Object.entries(edits)) {
    if (field === "cost") out.costCents = edit.to == null ? null : Number(edit.to);
    else if (field in out && field !== "issues") (out as Record<string, unknown>)[field] = edit.to;
  }
  return out;
}

function validateMapping(mapping: ColumnMapping, headers: string[]): ColumnMapping {
  const known = new Set(headers);
  const clean: ColumnMapping = {};
  for (const [field, header] of Object.entries(mapping)) {
    if (!FIELD_KEYS.has(field)) throw badRequest(`Unknown register field "${field}".`);
    if (!header) continue;
    if (!known.has(header)) throw badRequest(`The file has no column called "${header}". Pick one of its headers.`);
    clean[field as RegisterField] = header;
  }
  return clean;
}

export async function dayFirst(): Promise<boolean> {
  return dayFirstForLocale((await getConfig()).locale);
}

export type CreateImportInput = {
  bytes: Buffer;
  name?: string;
  fileName?: string;
  preset?: RegisterPreset;
  userOid: string | null;
};

/**
 * Store an uploaded register. Nothing about items changes here: the file is
 * parsed, its columns guessed, and its rows kept for a person to check the
 * mapping before anything is compared or created.
 */
export async function createImport(input: CreateImportInput) {
  let table;
  try {
    table = await readRegisterFile(input.bytes);
  } catch (err) {
    if (err instanceof CsvError) throw badRequest(err.message);
    throw err;
  }
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const preset = input.preset ?? detectPreset(table.headers);
  const mapping = autoMap(table.headers, preset);
  const df = await dayFirst();
  const name =
    input.name?.trim() ||
    input.fileName?.replace(/\.(csv|xlsx|txt)$/i, "").trim() ||
    `Register ${new Date().toISOString().slice(0, 10)}`;

  const id = await db.transaction(async (tx) => {
    const [imp] = await tx
      .insert(registerImports)
      .values({
        name: name.slice(0, 200),
        sourcePreset: preset,
        fileName: input.fileName?.slice(0, 255) ?? null,
        fileFormat: table.format,
        fileSha256: sha256,
        rowCount: table.rows.length,
        headers: table.headers,
        columnMapping: mapping,
        createdBy: input.userOid,
      })
      .returning({ id: registerImports.id });
    for (const part of chunks(table.rows)) {
      await tx.insert(registerRows).values(
        part.map((r) => ({
          importId: imp!.id,
          rowNumber: r.rowNumber,
          raw: r.cells,
          ...rowValues(normalizeRow(r.cells, mapping, { dayFirst: df })),
        })),
      );
    }
    return imp!.id;
  });

  logger.info("register.import.created", {
    importId: id,
    rows: table.rows.length,
    format: table.format,
    preset,
    by: input.userOid,
  });
  return getImport(id);
}

export async function listImports() {
  const rows = await db
    .select({
      id: registerImports.id,
      name: registerImports.name,
      sourcePreset: registerImports.sourcePreset,
      fileName: registerImports.fileName,
      fileFormat: registerImports.fileFormat,
      rowCount: registerImports.rowCount,
      createdBy: registerImports.createdBy,
      createdAt: registerImports.createdAt,
      runCount: sql<number>`(SELECT count(*)::int FROM reconciliation_runs r WHERE r.import_id = ${registerImports.id})`,
      lastRunAt: sql<string | null>`(SELECT max(r.created_at) FROM reconciliation_runs r WHERE r.import_id = ${registerImports.id})`,
    })
    .from(registerImports)
    .orderBy(desc(registerImports.createdAt));
  return rows;
}

async function requireImport(id: string) {
  const [imp] = await db.select().from(registerImports).where(eq(registerImports.id, id)).limit(1);
  if (!imp) throw notFound("Register import not found");
  return imp;
}

/** An import with what a person needs to check its mapping. */
export async function getImport(id: string) {
  const imp = await requireImport(id);
  const { rows: coverageRows } = await pool.query(
    `SELECT ${Object.entries(COLUMN)
      .map(([field, col]) => `count(${col})::int AS "${field}"`)
      .join(", ")},
            count(*) FILTER (WHERE jsonb_array_length(issues) > 0)::int AS "rowsWithIssues",
            count(created_item_id)::int AS "createdItems"
       FROM register_rows WHERE import_id = $1`,
    [id],
  );
  const coverage = coverageRows[0] as Record<string, number>;
  const [sample, runs, sameFile] = await Promise.all([
    db
      .select()
      .from(registerRows)
      .where(eq(registerRows.importId, id))
      .orderBy(asc(registerRows.rowNumber))
      .limit(20),
    db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.importId, id))
      .orderBy(desc(reconciliationRuns.createdAt)),
    db
      .select({ id: registerImports.id, name: registerImports.name })
      .from(registerImports)
      .where(and(eq(registerImports.fileSha256, imp.fileSha256), sql`${registerImports.id} <> ${id}`))
      .limit(1),
  ]);
  const { rowsWithIssues, createdItems, ...fields } = coverage;
  return {
    ...imp,
    coverage: fields as Record<RegisterField, number>,
    rowsWithIssues: rowsWithIssues ?? 0,
    createdItems: createdItems ?? 0,
    sample,
    runs,
    sameFileAs: sameFile[0] ?? null,
  };
}

export type ImportPatch = { name?: string; preset?: RegisterPreset; mapping?: ColumnMapping };

/**
 * Rename, or change how columns are read. A mapping change re-reads every row
 * from its stored cells, then puts back anything a person already copied into
 * the register copy.
 */
export async function updateImport(id: string, patch: ImportPatch) {
  const imp = await requireImport(id);
  const preset = patch.preset ?? imp.sourcePreset;
  let mapping: ColumnMapping | null = null;
  if (patch.mapping) mapping = validateMapping(patch.mapping, imp.headers);
  else if (patch.preset && patch.preset !== imp.sourcePreset) mapping = autoMap(imp.headers, preset);

  await db.transaction(async (tx) => {
    await tx
      .update(registerImports)
      .set({
        name: patch.name?.trim().slice(0, 200) || imp.name,
        sourcePreset: preset,
        ...(mapping ? { columnMapping: mapping } : {}),
        updatedAt: new Date(),
      })
      .where(eq(registerImports.id, id));
    if (!mapping) return;

    const df = await dayFirst();
    const stored = await tx
      .select({ id: registerRows.id, raw: registerRows.raw, edits: registerRows.edits })
      .from(registerRows)
      .where(eq(registerRows.importId, id));
    for (const part of chunks(stored)) {
      const values = part.map((r) => {
        const n = applyEdits(normalizeRow(r.raw, mapping, { dayFirst: df }), r.edits);
        return {
          id: r.id,
          asset_tag: n.assetTag,
          serial: n.serial,
          epc: n.epc,
          bindex_code: n.bindexCode,
          name: n.name,
          model: n.model,
          brand: n.brand,
          category: n.category,
          description: n.description,
          location_text: n.locationText,
          custodian: n.custodian,
          cost_cents: n.costCents,
          purchase_date: n.purchaseDate,
          quantity: n.quantity,
          issues: n.issues,
        };
      });
      // One statement per thousand rows rather than one per row.
      await tx.execute(sql`
        UPDATE register_rows r SET
          asset_tag = x.asset_tag, serial = x.serial, epc = x.epc, bindex_code = x.bindex_code,
          name = x.name, model = x.model, brand = x.brand, category = x.category,
          description = x.description, location_text = x.location_text, custodian = x.custodian,
          cost_cents = x.cost_cents, purchase_date = x.purchase_date, quantity = x.quantity,
          issues = x.issues
        FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS x(
          id uuid, asset_tag text, serial text, epc text, bindex_code text, name text, model text,
          brand text, category text, description text, location_text text, custodian text,
          cost_cents bigint, purchase_date date, quantity integer, issues jsonb)
        WHERE r.id = x.id`);
    }
  });
  if (mapping) logger.info("register.import.remapped", { importId: id, preset });
  return getImport(id);
}

export async function deleteImport(id: string) {
  const deleted = await db
    .delete(registerImports)
    .where(eq(registerImports.id, id))
    .returning({ id: registerImports.id });
  if (!deleted.length) throw notFound("Register import not found");
}

export async function listRows(
  importId: string,
  opts: { offset?: number; limit?: number; q?: string; issuesOnly?: boolean },
) {
  await requireImport(importId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q?.trim();
  const where = and(
    eq(registerRows.importId, importId),
    q
      ? sql`(${registerRows.assetTag} ILIKE ${`%${q}%`} OR ${registerRows.serial} ILIKE ${`%${q}%`}
             OR ${registerRows.name} ILIKE ${`%${q}%`} OR ${registerRows.model} ILIKE ${`%${q}%`}
             OR ${registerRows.locationText} ILIKE ${`%${q}%`})`
      : undefined,
    opts.issuesOnly ? sql`jsonb_array_length(${registerRows.issues}) > 0` : undefined,
  );
  const [rows, total] = await Promise.all([
    db.select().from(registerRows).where(where).orderBy(asc(registerRows.rowNumber)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(registerRows).where(where),
  ]);
  return { rows, total: total[0]?.n ?? 0, offset, limit };
}

// --- Locations ------------------------------------------------------------

export async function loadLocationIndex(): Promise<LocationIndex> {
  const [locs, mapping] = await Promise.all([
    db.select({ id: locations.id, name: locations.name, parentId: locations.parentId }).from(locations),
    db
      .select({ sourceText: registerLocationMap.sourceText, locationId: registerLocationMap.locationId })
      .from(registerLocationMap),
  ]);
  return buildLocationIndex(locs, mapping);
}

/** Every distinct location the register names, and where each one lands here. */
export async function importLocations(importId: string) {
  await requireImport(importId);
  const [counts, index] = await Promise.all([
    db
      .select({ text: registerRows.locationText, rows: sql<number>`count(*)::int` })
      .from(registerRows)
      .where(and(eq(registerRows.importId, importId), sql`${registerRows.locationText} IS NOT NULL`))
      .groupBy(registerRows.locationText)
      .orderBy(sql`count(*) DESC`, registerRows.locationText),
    loadLocationIndex(),
  ]);
  return counts.map((c) => {
    const r = index.resolve(c.text);
    return { text: c.text!, rows: c.rows, ...r, path: index.path(r.locationId) };
  });
}

export async function listLocationMappings() {
  const index = await loadLocationIndex();
  const rows = await db.select().from(registerLocationMap).orderBy(registerLocationMap.displayText);
  return rows.map((r) => ({ ...r, path: index.path(r.locationId) }));
}

/**
 * Remember where a register's location text belongs. A null location forgets
 * the mapping. Keyed by the normalised text, so "Bldg 7 > Rm 12" and
 * "bldg 7 / rm 12" share one entry.
 */
export async function setLocationMapping(text: string, locationId: string | null, userOid: string | null) {
  const key = normalizeLocationText(text);
  if (!key) throw badRequest("Give the register's location text to map.");
  if (locationId === null) {
    await db.delete(registerLocationMap).where(eq(registerLocationMap.sourceText, key));
    return null;
  }
  const [loc] = await db.select({ id: locations.id }).from(locations).where(eq(locations.id, locationId)).limit(1);
  if (!loc) throw notFound("Location not found");
  const now = new Date();
  const [row] = await db
    .insert(registerLocationMap)
    .values({ sourceText: key, displayText: text.trim().slice(0, 500), locationId, createdBy: userOid })
    .onConflictDoUpdate({
      target: registerLocationMap.sourceText,
      set: { locationId, displayText: text.trim().slice(0, 500), updatedAt: now },
    })
    .returning();
  return row!;
}
