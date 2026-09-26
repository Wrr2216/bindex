import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { entities, itemUnits, items, jobItems, jobs, locations, shipments, type JobItem } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { locationCode } from "../../lib/codes";
import { logger } from "../../lib/logger";
import { parseManifestCsv } from "./csv";
import { resolveScanCodes } from "./resolve";
import { buildPlaceIndex, matchPlace, pathFromRoot, subtreeIds, type PlaceIndex } from "./places";
import { assertJobOpen, clean, loadJob, loadShipmentOnJob, type Actor, type Executor } from "./shared";
import type { ScanRef } from "./match";

/**
 * The manifest: which items (or units) a job moves, where each is going, and
 * how far it has got. Lines are added by code, by location subtree or from a
 * CSV move plan, and edited in bulk. Stage changes are in advance.ts.
 */

/**
 * Fields a line can be given when it is added, or set in bulk later.
 *
 * `floor` and `department` are the move plan's grouping: the floor the line is
 * going to, and the department it belongs to (which usually moves as a unit).
 * Where it came from is `originLocationId`, snapshotted when the line is added.
 */
export type LineFields = {
  shipmentId?: string | null;
  destinationLocationId?: string | null;
  destinationLabel?: string | null;
  /** Destination floor, as the move plan names it ("5", "Level 5"). */
  floor?: string | null;
  department?: string | null;
  crateNo?: string | null;
  notes?: string | null;
};

export type LineFilters = {
  stage?: string;
  /** A shipment id, or "none" for lines not on a shipment. */
  shipmentId?: string;
  floor?: string;
  department?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

const origin = alias(locations, "origin");
const destination = alias(locations, "destination");

/** A manifest line with the names the table and the documents print. */
export function lineSelection() {
  return {
    id: jobItems.id,
    jobId: jobItems.jobId,
    itemId: jobItems.itemId,
    unitId: jobItems.unitId,
    shipmentId: jobItems.shipmentId,
    stage: jobItems.stage,
    stageAt: jobItems.stageAt,
    stageBy: jobItems.stageBy,
    originLocationId: jobItems.originLocationId,
    destinationLocationId: jobItems.destinationLocationId,
    destinationLabel: jobItems.destinationLabel,
    floor: jobItems.floor,
    department: jobItems.department,
    crateNo: jobItems.crateNo,
    notes: jobItems.notes,
    metadata: jobItems.metadata,
    itemName: items.name,
    itemBrand: items.brand,
    itemModel: items.model,
    assetCode: items.assetCode,
    unitCode: itemUnits.assetCode,
    unitLabel: itemUnits.label,
    unitSerial: itemUnits.serial,
    originName: origin.name,
    destinationName: destination.name,
    shipmentCode: shipments.code,
    shipmentName: shipments.name,
  };
}

export type ManifestLine = Awaited<ReturnType<typeof selectLines>>[number];

export function selectLines(where: SQL | undefined, ex: Executor = db) {
  return ex
    .select(lineSelection())
    .from(jobItems)
    .innerJoin(items, eq(jobItems.itemId, items.id))
    .leftJoin(itemUnits, eq(jobItems.unitId, itemUnits.id))
    .leftJoin(origin, eq(jobItems.originLocationId, origin.id))
    .leftJoin(destination, eq(jobItems.destinationLocationId, destination.id))
    .leftJoin(shipments, eq(jobItems.shipmentId, shipments.id))
    .where(where);
}

function filterWhere(jobId: string, f: LineFilters): SQL | undefined {
  const q = f.q?.trim();
  return and(
    eq(jobItems.jobId, jobId),
    f.stage ? eq(jobItems.stage, f.stage) : undefined,
    f.shipmentId === "none" ? isNull(jobItems.shipmentId) : f.shipmentId ? eq(jobItems.shipmentId, f.shipmentId) : undefined,
    f.floor ? eq(jobItems.floor, f.floor) : undefined,
    f.department ? eq(jobItems.department, f.department) : undefined,
    q
      ? or(
          ilike(items.name, `%${q}%`),
          ilike(items.assetCode, `%${q}%`),
          ilike(itemUnits.assetCode, `%${q}%`),
          ilike(itemUnits.serial, `%${q}%`),
          ilike(jobItems.crateNo, `%${q}%`),
          ilike(jobItems.destinationLabel, `%${q}%`),
        )
      : undefined,
  );
}

/** Natural order for a manifest: floor, department, destination, then item. */
const manifestOrder = [
  asc(jobItems.floor),
  asc(jobItems.department),
  asc(jobItems.destinationLabel),
  asc(items.name),
  asc(itemUnits.assetCode),
];

export async function listJobItems(jobId: string, filters: LineFilters = {}) {
  const limit = Math.min(Math.max(filters.limit ?? 5000, 1), 10000);
  const offset = Math.max(filters.offset ?? 0, 0);
  const where = filterWhere(jobId, filters);
  const [lines, [{ total } = { total: 0 }]] = await Promise.all([
    selectLines(where).orderBy(...manifestOrder).limit(limit).offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(jobItems)
      .innerJoin(items, eq(jobItems.itemId, items.id))
      .leftJoin(itemUnits, eq(jobItems.unitId, itemUnits.id))
      .where(where),
  ]);
  return { lines, total };
}

/** Every job line an item (or its units) is on, newest job first. */
export function jobLinesForItem(itemId: string) {
  return db
    .select({
      id: jobItems.id,
      jobId: jobItems.jobId,
      jobCode: jobs.code,
      jobName: jobs.name,
      jobStatus: jobs.status,
      unitId: jobItems.unitId,
      stage: jobItems.stage,
      stageAt: jobItems.stageAt,
      shipmentId: jobItems.shipmentId,
      destinationLocationId: jobItems.destinationLocationId,
      destinationLabel: jobItems.destinationLabel,
    })
    .from(jobItems)
    .innerJoin(jobs, eq(jobItems.jobId, jobs.id))
    .where(eq(jobItems.itemId, itemId))
    .orderBy(desc(jobs.createdAt));
}

// --- Adding lines -------------------------------------------------------------

type NewLine = typeof jobItems.$inferInsert;

const lineKey = (itemId: string, unitId: string | null | undefined) => `${itemId}:${unitId ?? ""}`;

/** Insert lines, skipping any already on the job. Returns the ones added. */
async function insertLines(ex: Executor, rows: NewLine[]): Promise<JobItem[]> {
  const added: JobItem[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    if (!part.length) continue;
    added.push(...(await ex.insert(jobItems).values(part).onConflictDoNothing().returning()));
  }
  return added;
}

async function existingKeys(ex: Executor, jobId: string, itemIds: string[]): Promise<Map<string, JobItem>> {
  const out = new Map<string, JobItem>();
  if (!itemIds.length) return out;
  const rows = await ex
    .select()
    .from(jobItems)
    .where(and(eq(jobItems.jobId, jobId), inArray(jobItems.itemId, [...new Set(itemIds)])));
  for (const r of rows) out.set(lineKey(r.itemId, r.unitId), r);
  return out;
}

/** Where each item and unit is now, to snapshot as the line's origin. */
async function currentLocations(refs: ScanRef[]): Promise<Map<string, string | null>> {
  const itemIds = [...new Set(refs.map((r) => r.itemId))];
  const unitIds = [...new Set(refs.flatMap((r) => (r.unitId ? [r.unitId] : [])))];
  const [itemRows, unitRows] = await Promise.all([
    itemIds.length
      ? db.select({ id: items.id, locationId: items.locationId }).from(items).where(inArray(items.id, itemIds))
      : [],
    unitIds.length
      ? db
          .select({ id: itemUnits.id, itemId: itemUnits.itemId, locationId: itemUnits.locationId })
          .from(itemUnits)
          .where(inArray(itemUnits.id, unitIds))
      : [],
  ]);
  const itemLoc = new Map(itemRows.map((r) => [r.id, r.locationId]));
  const out = new Map<string, string | null>();
  for (const id of itemIds) out.set(lineKey(id, null), itemLoc.get(id) ?? null);
  for (const u of unitRows) out.set(lineKey(u.itemId, u.id), u.locationId ?? itemLoc.get(u.itemId) ?? null);
  return out;
}

async function checkFields(jobId: string, fields: LineFields): Promise<void> {
  if (fields.shipmentId) await loadShipmentOnJob(jobId, fields.shipmentId);
}

const fieldValues = (fields: LineFields): Partial<NewLine> => {
  const out: Partial<NewLine> = {};
  if (fields.shipmentId !== undefined) out.shipmentId = fields.shipmentId;
  if (fields.destinationLocationId !== undefined) out.destinationLocationId = fields.destinationLocationId;
  if (fields.destinationLabel !== undefined) out.destinationLabel = clean(fields.destinationLabel);
  if (fields.floor !== undefined) out.floor = clean(fields.floor);
  if (fields.department !== undefined) out.department = clean(fields.department);
  if (fields.crateNo !== undefined) out.crateNo = clean(fields.crateNo);
  if (fields.notes !== undefined) out.notes = clean(fields.notes);
  return out;
};

export type AddByCodesResult = {
  added: number;
  /** Codes whose item or unit was already on the job. */
  alreadyOnJob: string[];
  /** Codes that name nothing. */
  unknown: string[];
  /** Product codes shared by several items; scan the item's own code instead. */
  ambiguous: string[];
};

/**
 * Add items by scanned or typed codes (asset codes, unit codes, serials, tags).
 * A unit code adds that unit; an item code adds the whole item.
 */
export async function addItemsByCodes(
  jobId: string,
  codes: string[],
  fields: LineFields,
  actor: Actor,
): Promise<AddByCodesResult> {
  const job = await loadJob(jobId);
  assertJobOpen(job);
  await checkFields(jobId, fields);
  const resolved = await resolveScanCodes(codes);
  const result: AddByCodesResult = { added: 0, alreadyOnJob: [], unknown: [], ambiguous: [] };
  const wanted = new Map<string, { code: string; ref: ScanRef }>();
  for (const raw of codes) {
    const code = raw.trim();
    if (!code) continue;
    const refs = resolved.get(code) ?? [];
    if (refs.length === 0) {
      if (!result.unknown.includes(code)) result.unknown.push(code);
      continue;
    }
    const ref = refs.find((r) => r.unitId) ?? (refs.length === 1 ? refs[0]! : null);
    if (!ref) {
      if (!result.ambiguous.includes(code)) result.ambiguous.push(code);
      continue;
    }
    const key = lineKey(ref.itemId, ref.unitId);
    if (!wanted.has(key)) wanted.set(key, { code, ref });
  }

  const refs = [...wanted.values()].map((w) => w.ref);
  const [existing, origins] = await Promise.all([
    existingKeys(db, jobId, refs.map((r) => r.itemId)),
    currentLocations(refs),
  ]);
  const rows: NewLine[] = [];
  for (const [key, { code, ref }] of wanted) {
    // The whole item on the job already covers each of its units.
    if (existing.has(key) || (ref.unitId && existing.has(lineKey(ref.itemId, null)))) {
      result.alreadyOnJob.push(code);
      continue;
    }
    rows.push({
      jobId,
      itemId: ref.itemId,
      unitId: ref.unitId,
      originLocationId: origins.get(key) ?? null,
      stageBy: actor.name ?? actor.userOid,
      ...fieldValues(fields),
    });
  }
  result.added = (await insertLines(db, rows)).length;
  logger.info("jobs.manifest.add_codes", { jobId, added: result.added, unknown: result.unknown.length });
  return result;
}

export type SubtreeOptions = LineFields & {
  /** Also add items packed inside container items found there. Default true. */
  includeContents?: boolean;
  /** One line per tracked unit rather than one per item. Default true. */
  perUnit?: boolean;
  /**
   * Which level of the location tree, counted from the chosen location (0) down,
   * names each line's department. Default 1: choose a floor whose rooms or areas
   * are departments. Null leaves it to the item's holder when that holder is a
   * department, and otherwise blank. An explicit `department` wins.
   */
  departmentLevel?: number | null;
  /**
   * The same for the floor. Off by default, because the floor on a line is
   * where it is going, and a move plan (CSV or bulk edit) usually sets it. Set
   * 0 for a like-for-like move where floor 3 goes to floor 3.
   */
  floorLevel?: number | null;
};

export async function loadPlaceIndex(): Promise<PlaceIndex> {
  const rows = await db
    .select({ id: locations.id, name: locations.name, parentId: locations.parentId })
    .from(locations);
  return buildPlaceIndex(rows, locationCode);
}

/**
 * Add everything under a location ("everything on floor 3"): items there or in
 * any location beneath it, items packed inside containers found there, and
 * tracked units wherever they individually sit within the subtree. Domains and
 * other digital items are skipped.
 */
export async function addItemsFromLocation(
  jobId: string,
  rootLocationId: string,
  opts: SubtreeOptions,
  actor: Actor,
): Promise<{ added: number; alreadyOnJob: number; found: number }> {
  const job = await loadJob(jobId);
  assertJobOpen(job);
  await checkFields(jobId, opts);
  const index = await loadPlaceIndex();
  if (!index.byId.has(rootLocationId)) throw notFound("Location not found");
  const ids = subtreeIds(rootLocationId, index);
  const includeContents = opts.includeContents !== false;
  const perUnit = opts.perUnit !== false;

  // Each item with the location it is effectively at: its own, or for
  // something packed inside a container item, the container's.
  const found = await db.execute<{ id: string; loc: string; department: string | null }>(sql`
    WITH RECURSIVE tree AS (
      SELECT i.id, i.location_id AS loc FROM items i
       WHERE i.location_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      UNION
      SELECT c.id, t.loc FROM items c JOIN tree t ON c.parent_item_id = t.id
       WHERE ${includeContents ? sql`true` : sql`false`}
    )
    SELECT DISTINCT ON (t.id) t.id, t.loc,
           CASE WHEN e.kind = 'department' THEN e.name END AS department
      FROM tree t
      JOIN items i ON i.id = t.id
      LEFT JOIN entities e ON e.id = i.utilized_by_entity_id
     WHERE i.category IS DISTINCT FROM 'Domain'
     ORDER BY t.id`);
  const inTree = new Map(found.rows.map((r) => [r.id, r]));
  const subtree = new Set(ids);

  // Units sit wherever they individually are, falling back to their item's
  // place when they have none of their own.
  const unitRows = perUnit
    ? await db
        .select({
          id: itemUnits.id,
          itemId: itemUnits.itemId,
          locationId: itemUnits.locationId,
          entityKind: entities.kind,
          entityName: entities.name,
          category: items.category,
        })
        .from(itemUnits)
        .innerJoin(items, eq(itemUnits.itemId, items.id))
        .leftJoin(entities, eq(itemUnits.utilizedByEntityId, entities.id))
        .where(
          or(
            ids.length ? inArray(itemUnits.locationId, ids) : undefined,
            inTree.size ? and(isNull(itemUnits.locationId), inArray(itemUnits.itemId, [...inTree.keys()])) : undefined,
          ),
        )
    : [];

  const withUnits = new Set(
    perUnit && inTree.size
      ? (
          await db
            .selectDistinct({ itemId: itemUnits.itemId })
            .from(itemUnits)
            .where(inArray(itemUnits.itemId, [...inTree.keys()]))
        ).map((r) => r.itemId)
      : [],
  );

  const name = (locId: string | null, level: number | null | undefined, fallback: number | null) => {
    const at = level === undefined ? fallback : level;
    if (at === null || !locId) return null;
    return pathFromRoot(locId, rootLocationId, index)[at] ?? null;
  };
  // The location tree is what the person chose to add from, so it names the
  // department first; a department holder only fills in where it has no name.
  const describe = (locId: string | null, holderDepartment: string | null) => ({
    floor: opts.floor !== undefined ? clean(opts.floor) : name(locId, opts.floorLevel, null),
    department:
      opts.department !== undefined
        ? clean(opts.department)
        : (name(locId, opts.departmentLevel, 1) ?? holderDepartment),
  });

  const rows: NewLine[] = [];
  const base = { jobId, stageBy: actor.name ?? actor.userOid, ...fieldValues(opts) };
  for (const [itemId, r] of inTree) {
    if (withUnits.has(itemId)) continue;
    rows.push({ ...base, itemId, unitId: null, originLocationId: r.loc, ...describe(r.loc, r.department) });
  }
  for (const u of unitRows) {
    if (u.category === "Domain") continue;
    const loc = u.locationId ?? inTree.get(u.itemId)?.loc ?? null;
    if (!loc || !subtree.has(loc)) continue;
    const dept = u.entityKind === "department" ? u.entityName : (inTree.get(u.itemId)?.department ?? null);
    rows.push({ ...base, itemId: u.itemId, unitId: u.id, originLocationId: loc, ...describe(loc, dept) });
  }

  const added = await insertLines(db, rows);
  logger.info("jobs.manifest.add_subtree", { jobId, rootLocationId, found: rows.length, added: added.length });
  return { added: added.length, alreadyOnJob: rows.length - added.length, found: rows.length };
}

// --- CSV --------------------------------------------------------------------------

export type CsvImportResult = {
  added: number;
  updated: number;
  /** Department rows and how many lines each one set. */
  departments: { department: string; lines: number }[];
  unknownCodes: { line: number; code: string }[];
  ambiguousCodes: { line: number; code: string }[];
  /** Codes not on the job, when adding was turned off. */
  notOnJob: { line: number; code: string }[];
  /** Destinations that did not match a location; the text was kept as the destination label. */
  unmatchedDestinations: { line: number; value: string; reason: "unknown" | "ambiguous" }[];
  errors: { line: number; message: string }[];
};

/**
 * Apply a move-plan CSV to a job (format in csv.ts). Rows with a code add or
 * update that line; rows with only a department set every line in it. All or
 * nothing: the rows are applied in one transaction.
 */
export async function importManifestCsv(
  jobId: string,
  text: string,
  opts: { addMissing?: boolean } & Pick<LineFields, "shipmentId">,
  actor: Actor,
): Promise<CsvImportResult> {
  const job = await loadJob(jobId);
  assertJobOpen(job);
  await checkFields(jobId, opts);
  const addMissing = opts.addMissing !== false;
  const parsed = parseManifestCsv(text);
  const result: CsvImportResult = {
    added: 0,
    updated: 0,
    departments: [],
    unknownCodes: [],
    ambiguousCodes: [],
    notOnJob: [],
    unmatchedDestinations: [],
    errors: [...parsed.errors],
  };
  if (parsed.rows.length === 0) return result;

  const index = await loadPlaceIndex();
  const resolved = await resolveScanCodes(parsed.rows.flatMap((r) => (r.code ? [r.code] : [])));

  /** The columns a row sets. Blank cells leave the line as it is. */
  const rowFields = (row: (typeof parsed.rows)[number]): Partial<NewLine> => {
    const set: Partial<NewLine> = {};
    if (row.destination) {
      const m = matchPlace(row.destination, index);
      if (m.ok) set.destinationLocationId = m.id;
      else {
        result.unmatchedDestinations.push({ line: row.line, value: row.destination, reason: m.reason });
        if (!row.desk) set.destinationLabel = row.destination;
      }
    }
    if (row.desk) set.destinationLabel = row.desk;
    if (row.floor) set.floor = row.floor;
    if (row.department && row.code) set.department = row.department;
    if (row.crate) set.crateNo = row.crate;
    if (row.notes) set.notes = row.notes;
    return set;
  };

  const codeRows = parsed.rows.filter((r) => r.code);
  const refs = new Map<number, ScanRef>();
  for (const row of codeRows) {
    const found = resolved.get(row.code!) ?? [];
    const ref = found.find((r) => r.unitId) ?? (found.length === 1 ? found[0]! : null);
    if (found.length === 0) result.unknownCodes.push({ line: row.line, code: row.code! });
    else if (!ref) result.ambiguousCodes.push({ line: row.line, code: row.code! });
    else refs.set(row.line, ref);
  }
  const origins = await currentLocations([...refs.values()]);

  await db.transaction(async (tx) => {
    const existing = await existingKeys(tx, jobId, [...refs.values()].map((r) => r.itemId));
    const now = new Date();
    for (const row of codeRows) {
      const ref = refs.get(row.line);
      if (!ref) continue;
      const key = lineKey(ref.itemId, ref.unitId);
      const set = rowFields(row);
      // A unit listed on a plan whose job holds the whole item updates that line.
      const line = existing.get(key) ?? (ref.unitId ? existing.get(lineKey(ref.itemId, null)) : undefined);
      if (line) {
        if (Object.keys(set).length) {
          await tx.update(jobItems).set({ ...set, updatedAt: now }).where(eq(jobItems.id, line.id));
          result.updated += 1;
        }
        continue;
      }
      if (!addMissing) {
        result.notOnJob.push({ line: row.line, code: row.code! });
        continue;
      }
      const [added] = await insertLines(tx, [
        {
          jobId,
          itemId: ref.itemId,
          unitId: ref.unitId,
          originLocationId: origins.get(key) ?? null,
          shipmentId: opts.shipmentId ?? null,
          stageBy: actor.name ?? actor.userOid,
          ...set,
        },
      ]);
      if (added) {
        existing.set(key, added);
        result.added += 1;
      }
    }

    for (const row of parsed.rows.filter((r) => !r.code)) {
      const set = rowFields(row);
      const changed = await tx
        .update(jobItems)
        .set({ ...set, updatedAt: now })
        .where(and(eq(jobItems.jobId, jobId), sql`lower(${jobItems.department}) = lower(${row.department})`))
        .returning({ id: jobItems.id });
      result.departments.push({ department: row.department!, lines: changed.length });
      result.updated += changed.length;
    }
  });
  logger.info("jobs.manifest.csv", {
    jobId,
    added: result.added,
    updated: result.updated,
    errors: result.errors.length,
  });
  return result;
}

// --- Editing and removing -------------------------------------------------------

/** Set the same fields on many lines: bulk destination, crate or shipment assignment. */
export async function updateJobItems(
  jobId: string,
  ids: string[],
  fields: LineFields,
): Promise<{ updated: number }> {
  await loadJob(jobId);
  if (!ids.length) return { updated: 0 };
  await checkFields(jobId, fields);
  const set = fieldValues(fields);
  if (Object.keys(set).length === 0) throw badRequest("Nothing to change. Pick a field to set.");
  const rows = await db
    .update(jobItems)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(jobItems.jobId, jobId), inArray(jobItems.id, ids)))
    .returning({ id: jobItems.id });
  return { updated: rows.length };
}

export async function removeJobItems(jobId: string, ids: string[]): Promise<{ removed: number }> {
  const job = await loadJob(jobId);
  assertJobOpen(job);
  if (!ids.length) return { removed: 0 };
  const rows = await db
    .delete(jobItems)
    .where(and(eq(jobItems.jobId, jobId), inArray(jobItems.id, ids)))
    .returning({ id: jobItems.id });
  logger.info("jobs.manifest.remove", { jobId, removed: rows.length });
  return { removed: rows.length };
}

/** Distinct floors and departments on a job, for filter pickers. */
export async function manifestFacets(jobId: string) {
  const rows = await db
    .selectDistinct({ floor: jobItems.floor, department: jobItems.department })
    .from(jobItems)
    .where(eq(jobItems.jobId, jobId));
  const sort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  return {
    floors: [...new Set(rows.flatMap((r) => (r.floor ? [r.floor] : [])))].sort(sort),
    departments: [...new Set(rows.flatMap((r) => (r.department ? [r.department] : [])))].sort(sort),
  };
}
