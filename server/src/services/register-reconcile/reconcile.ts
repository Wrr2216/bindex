import { and, asc, desc, eq, lt } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { companies } from "../../db/schema";
import {
  reconciliationResults,
  reconciliationRuns,
  registerImports,
  registerRows,
  type ReconcileClass,
  type ResultSnapshot,
} from "../../db/tables/register-reconcile";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { env } from "../../env";
import {
  buildKeyIndex,
  classify,
  CLASS_ORDER,
  itemKey,
  matchExact,
  unitKey,
  type ClassifiedResult,
  type Proposal,
  type RowInput,
  type Target,
} from "./classify";
import { compareRuns, type CompareInput } from "./compare";
import { normalizeEpc, normKey } from "./normalize";
import { loadLocationIndex } from "./store";

/** Trigram similarity a fuzzy proposal needs before it is shown at all. */
export const FUZZY_MIN_SCORE = 0.4;
/** Above this many unmatched rows, fuzzy proposals are skipped to keep a run quick. */
const FUZZY_MAX_ROWS = 20_000;

export type Scope = { companyId?: string | null; locationId?: string | null };

/**
 * Every physical item and tracked unit, with the keys a register could name
 * them by. Loaded whole in three queries: matching is global (a row naming
 * something outside the scope is still that thing), only "not in the
 * register" is limited to the scope.
 */
export async function loadTargets(scope: Scope): Promise<Map<string, Target>> {
  const companyId = scope.companyId ?? null;
  const locationId = scope.locationId ?? null;
  const subtree = (p: string) => `
    WITH RECURSIVE sub AS (
      SELECT id FROM locations WHERE id = ${p}::uuid
      UNION
      SELECT l.id FROM locations l JOIN sub s ON l.parent_id = s.id
    )`;
  const [itemsRes, unitsRes, idsRes] = await Promise.all([
    pool.query(
      `${subtree("$2")}
       SELECT i.id, i.name, i.model, i.asset_code, i.location_id, i.value_cents, i.flagged_missing,
              ($1::uuid IS NULL OR coalesce(i.company_id, l.company_id) = $1::uuid) AS company_ok,
              ($2::uuid IS NULL OR i.location_id IN (SELECT id FROM sub)) AS location_ok
         FROM items i
         LEFT JOIN locations l ON l.id = i.location_id
        WHERE i.category IS DISTINCT FROM 'Domain'`,
      [companyId, locationId],
    ),
    pool.query(
      `${subtree("$2")}
       SELECT u.id, u.item_id, u.asset_code, u.serial, u.label, u.status, u.value_cents,
              coalesce(u.location_id, i.location_id) AS location_id,
              ($1::uuid IS NULL OR coalesce(u.company_id, i.company_id, l.company_id) = $1::uuid) AS company_ok,
              ($2::uuid IS NULL OR coalesce(u.location_id, i.location_id) IN (SELECT id FROM sub)) AS location_ok
         FROM item_units u
         JOIN items i ON i.id = u.item_id
         LEFT JOIN locations l ON l.id = coalesce(u.location_id, i.location_id)
        WHERE i.category IS DISTINCT FROM 'Domain'`,
      [companyId, locationId],
    ),
    pool.query(
      `SELECT ii.item_id, ii.type, ii.value
         FROM item_identifiers ii
         JOIN items i ON i.id = ii.item_id
        WHERE ii.type IN ('asset_tag', 'serial', 'rfid') AND i.category IS DISTINCT FROM 'Domain'`,
    ),
  ]);

  const targets = new Map<string, Target>();
  for (const r of itemsRes.rows) {
    targets.set(itemKey(r.id), {
      key: itemKey(r.id),
      itemId: r.id,
      unitId: null,
      name: r.name,
      model: r.model,
      assetCode: r.asset_code,
      locationId: r.location_id,
      valueCents: r.value_cents == null ? null : Number(r.value_cents),
      flaggedMissing: r.flagged_missing,
      serials: [],
      assetTags: [],
      epcs: [],
      inScope: r.company_ok && r.location_ok,
      hasUnits: false,
    });
  }
  for (const r of idsRes.rows) {
    const t = targets.get(itemKey(r.item_id));
    if (!t) continue;
    if (r.type === "serial") t.serials.push(r.value);
    else if (r.type === "asset_tag") t.assetTags.push(r.value);
    else t.epcs.push(normalizeEpc(r.value) ?? r.value);
  }
  for (const r of unitsRes.rows) {
    const item = targets.get(itemKey(r.item_id));
    if (!item) continue;
    item.hasUnits = true;
    targets.set(unitKey(r.id), {
      key: unitKey(r.id),
      itemId: r.item_id,
      unitId: r.id,
      name: r.label ? `${item.name} (${r.label})` : item.name,
      model: item.model,
      assetCode: r.asset_code,
      locationId: r.location_id,
      valueCents: r.value_cents == null ? null : Number(r.value_cents),
      flaggedMissing: r.status === "missing" || item.flaggedMissing,
      serials: r.serial ? [r.serial] : [],
      assetTags: [],
      epcs: [],
      inScope: r.company_ok && r.location_ok,
      hasUnits: false,
    });
  }
  return targets;
}

const FUZZY_SQL = `
  SELECT r.id AS row_id, c.item_id, c.score
    FROM unnest($1::uuid[], $2::text[], $3::text[]) AS r(id, name, model)
   CROSS JOIN LATERAL (
     SELECT i.id AS item_id,
            CASE WHEN r.model <> '' AND coalesce(i.model, '') <> ''
                 THEN (similarity(i.name, r.name) + similarity(i.model, r.model)) / 2
                 ELSE similarity(i.name, r.name) END AS score
       FROM (SELECT id, name, model, category FROM items WHERE name % r.name
             UNION
             SELECT id, name, model, category FROM items WHERE r.model <> '' AND model % r.model) i
      WHERE i.category IS DISTINCT FROM 'Domain'
      ORDER BY score DESC
      LIMIT 5
   ) c
   WHERE c.score >= $4
   ORDER BY r.id, c.score DESC`;

async function fuzzyChunk(rows: RowInput[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // `%` filters at this threshold, so the index hands back fewer rows to
    // score; nothing below FUZZY_MIN_SCORE would be shown anyway.
    await client.query(`SET LOCAL pg_trgm.similarity_threshold = ${FUZZY_MIN_SCORE}`);
    const res = await client.query<{ row_id: string; item_id: string; score: number }>(FUZZY_SQL, [
      rows.map((r) => r.id),
      rows.map((r) => r.name!),
      rows.map((r) => r.model ?? ""),
      FUZZY_MIN_SCORE,
    ]);
    await client.query("COMMIT");
    return res.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Best trigram match for each row nothing matched exactly, among items in
 * scope that no row claimed. The name and model are probed separately (a
 * UNION rather than an OR) so each uses its trigram index; the score is the
 * name similarity, averaged with the model similarity when both sides have a
 * model. Rows are split across a few connections, because each probe is
 * independent and a first run against a new register can have thousands.
 */
export async function fuzzyProposals(
  rows: RowInput[],
  candidates: Set<string>,
): Promise<Map<string, Proposal>> {
  const out = new Map<string, Proposal>();
  const wanted = rows.filter((r) => r.name && r.name.trim().length >= 3).slice(0, FUZZY_MAX_ROWS);
  if (!wanted.length || !candidates.size) return out;
  const parallel = Math.max(1, Math.min(4, env.DATABASE_POOL_MAX - 2));
  const size = Math.max(100, Math.ceil(wanted.length / parallel));
  const parts: RowInput[][] = [];
  for (let i = 0; i < wanted.length; i += size) parts.push(wanted.slice(i, i + size));
  const found = (await Promise.all(parts.map(fuzzyChunk))).flat();
  for (const r of found) {
    if (out.has(r.row_id) || !candidates.has(r.item_id)) continue;
    out.set(r.row_id, { itemId: r.item_id, score: Math.round(Number(r.score) * 100) / 100 });
  }
  return out;
}

async function scopeLabel(scope: Scope, pathOf: (id: string) => string | null): Promise<string> {
  const parts: string[] = [];
  if (scope.companyId) {
    const [c] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, scope.companyId)).limit(1);
    if (!c) throw notFound("That group no longer exists.");
    parts.push(c.name);
  }
  if (scope.locationId) {
    const path = pathOf(scope.locationId);
    if (!path) throw notFound("That location no longer exists.");
    parts.push(path);
  }
  return parts.join(" · ") || "Everything";
}

function snapshotFor(r: ClassifiedResult, targets: Map<string, Target>): ResultSnapshot {
  const snap: ResultSnapshot = {};
  const t = r.targetKey ? targets.get(r.targetKey) : undefined;
  if (t) {
    const item = targets.get(itemKey(t.itemId));
    snap.itemName = item?.name ?? t.name;
    snap.itemAssetCode = item?.assetCode ?? t.assetCode;
    if (t.unitId) snap.unitAssetCode = t.assetCode;
    snap.model = t.model;
    snap.serials = t.serials;
    snap.valueCents = t.valueCents;
    snap.flaggedMissing = t.flaggedMissing;
  }
  if (r.proposal) {
    const p = targets.get(itemKey(r.proposal.itemId));
    if (p) {
      snap.proposalName = p.name;
      snap.proposalAssetCode = p.assetCode;
    }
  }
  return snap;
}

const resultKey = (r: { rowId: string | null; itemId: string | null; unitId: string | null }) =>
  `${r.rowId ?? ""}|${r.itemId ?? ""}|${r.unitId ?? ""}`;

/**
 * Reconcile a stored register against this instance and save the run. Reads
 * only: nothing about any item changes until a person runs an action.
 */
export async function runReconciliation(importId: string, scope: Scope, userOid: string | null) {
  const started = Date.now();
  const [imp] = await db.select().from(registerImports).where(eq(registerImports.id, importId)).limit(1);
  if (!imp) throw notFound("Register import not found");

  const [stored, locIndex, targets] = await Promise.all([
    db.select().from(registerRows).where(eq(registerRows.importId, importId)).orderBy(asc(registerRows.rowNumber)),
    loadLocationIndex(),
    loadTargets(scope),
  ]);
  const label = await scopeLabel(scope, locIndex.path);

  const rows: RowInput[] = stored.map((r) => {
    const loc = locIndex.resolve(r.locationText);
    return {
      id: r.id,
      rowNumber: r.rowNumber,
      assetTag: r.assetTag,
      serial: r.serial,
      epc: r.epc,
      bindexCode: r.bindexCode,
      name: r.name,
      model: r.model,
      costCents: r.costCents,
      locationText: r.locationText,
      registerLocationId: loc.locationId,
      locationAmbiguous: loc.ambiguous,
    };
  });

  const matches = matchExact(rows, buildKeyIndex(targets.values()), targets);
  const claimed = new Set<string>();
  for (const m of matches.values()) {
    if (!m.targetKey) continue;
    claimed.add(m.targetKey);
    claimed.add(itemKey(targets.get(m.targetKey)!.itemId));
  }
  const candidates = new Set<string>();
  for (const t of targets.values()) {
    if (t.unitId === null && t.inScope && !claimed.has(t.key)) candidates.add(t.itemId);
  }
  const unmatched = rows.filter((r) => !matches.get(r.id)?.targetKey);
  const proposals = await fuzzyProposals(unmatched, candidates);
  const { results, counts } = classify(rows, matches, targets, proposals);

  // Ignored results stay ignored when the same register is run again, unless
  // something new is wrong with them.
  const [previous] = await db
    .select({ id: reconciliationRuns.id })
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.importId, importId))
    .orderBy(desc(reconciliationRuns.createdAt))
    .limit(1);
  const carried = new Map<string, { classes: string[]; note: string | null; by: string | null; at: Date | null }>();
  if (previous) {
    const ignored = await db
      .select()
      .from(reconciliationResults)
      .where(and(eq(reconciliationResults.runId, previous.id), eq(reconciliationResults.resolution, "ignored")));
    for (const r of ignored) {
      carried.set(resultKey(r), { classes: r.classes, note: r.resolutionNote, by: r.resolvedBy, at: r.resolvedAt });
    }
  }
  const keepIgnored = (r: ClassifiedResult) => {
    const was = carried.get(resultKey(r));
    return was && r.classes.every((c) => c === "matched" || was.classes.includes(c)) ? was : undefined;
  };

  const durationMs = Date.now() - started;
  const runId = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(reconciliationRuns)
      .values({
        importId,
        scopeCompanyId: scope.companyId ?? null,
        scopeLocationId: scope.locationId ?? null,
        scopeLabel: label,
        counts: { ...counts, ignored: carried.size ? results.filter((r) => keepIgnored(r)).length : 0 },
        durationMs,
        createdBy: userOid,
      })
      .returning({ id: reconciliationRuns.id });
    const values = results.map((r) => {
      const keep = keepIgnored(r);
      return {
        runId: run!.id,
        rowId: r.rowId,
        itemId: r.itemId,
        unitId: r.unitId,
        classes: r.classes,
        matchMethod: r.matchMethod,
        registerLocationId: r.registerLocationId,
        bindexLocationId: r.bindexLocationId,
        proposalItemId: r.proposal?.itemId ?? null,
        proposalScore: r.proposal?.score ?? null,
        conflicts: r.conflicts,
        notes: r.notes,
        snapshot: snapshotFor(r, targets),
        resolution: keep ? ("ignored" as const) : null,
        resolutionNote: keep?.note ?? null,
        resolvedBy: keep?.by ?? null,
        resolvedAt: keep?.at ?? null,
      };
    });
    for (let i = 0; i < values.length; i += 1000) {
      await tx.insert(reconciliationResults).values(values.slice(i, i + 1000));
    }
    return run!.id;
  });

  logger.info("register.reconcile.done", {
    importId,
    runId,
    rows: rows.length,
    results: results.length,
    durationMs: Date.now() - started,
    counts,
  });
  return getRun(runId);
}

export async function listRuns(importId?: string) {
  return db
    .select({
      id: reconciliationRuns.id,
      importId: reconciliationRuns.importId,
      importName: registerImports.name,
      scopeLabel: reconciliationRuns.scopeLabel,
      counts: reconciliationRuns.counts,
      durationMs: reconciliationRuns.durationMs,
      createdBy: reconciliationRuns.createdBy,
      createdAt: reconciliationRuns.createdAt,
    })
    .from(reconciliationRuns)
    .innerJoin(registerImports, eq(registerImports.id, reconciliationRuns.importId))
    .where(importId ? eq(reconciliationRuns.importId, importId) : undefined)
    .orderBy(desc(reconciliationRuns.createdAt))
    .limit(200);
}

/** A run with its counts as they were, and what is still open now. */
export async function getRun(runId: string) {
  const [run] = await db
    .select({
      run: reconciliationRuns,
      importName: registerImports.name,
      importRowCount: registerImports.rowCount,
    })
    .from(reconciliationRuns)
    .innerJoin(registerImports, eq(registerImports.id, reconciliationRuns.importId))
    .where(eq(reconciliationRuns.id, runId))
    .limit(1);
  if (!run) throw notFound("Reconciliation run not found");
  const { rows } = await pool.query(
    `SELECT c AS class,
            count(*)::int AS total,
            count(*) FILTER (WHERE resolution IS NULL)::int AS open,
            count(*) FILTER (WHERE resolution = 'resolved')::int AS resolved,
            count(*) FILTER (WHERE resolution = 'ignored')::int AS ignored
       FROM reconciliation_results, unnest(classes) AS c
      WHERE run_id = $1
      GROUP BY c`,
    [runId],
  );
  const status = Object.fromEntries(
    CLASS_ORDER.map((c) => [c, { total: 0, open: 0, resolved: 0, ignored: 0 }]),
  ) as Record<ReconcileClass, { total: number; open: number; resolved: number; ignored: number }>;
  for (const r of rows) status[r.class as ReconcileClass] = { total: r.total, open: r.open, resolved: r.resolved, ignored: r.ignored };
  const [prior] = await db
    .select({ id: reconciliationRuns.id })
    .from(reconciliationRuns)
    .where(and(eq(reconciliationRuns.importId, run.run.importId), lt(reconciliationRuns.createdAt, run.run.createdAt)))
    .orderBy(desc(reconciliationRuns.createdAt))
    .limit(1);
  return {
    ...run.run,
    importName: run.importName,
    importRowCount: run.importRowCount,
    status,
    previousRunId: prior?.id ?? null,
  };
}

export async function deleteRun(runId: string) {
  const deleted = await db.delete(reconciliationRuns).where(eq(reconciliationRuns.id, runId)).returning({ id: reconciliationRuns.id });
  if (!deleted.length) throw notFound("Reconciliation run not found");
}

export type ResultFilter = {
  cls?: ReconcileClass;
  status?: "open" | "resolved" | "ignored" | "all";
  q?: string;
  offset?: number;
  limit?: number;
  ids?: string[];
};

export type ResultView = Awaited<ReturnType<typeof listResults>>["results"][number];

/** Results joined to the register row, the asset as it is now, and location paths. */
export async function listResults(runId: string, f: ResultFilter = {}) {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 100_000);
  const offset = Math.max(f.offset ?? 0, 0);
  const params: unknown[] = [runId];
  const where: string[] = ["res.run_id = $1"];
  if (f.cls) {
    params.push(f.cls);
    where.push(`$${params.length} = ANY(res.classes)`);
  }
  if (f.status === "open") where.push("res.resolution IS NULL");
  else if (f.status === "resolved") where.push("res.resolution = 'resolved'");
  else if (f.status === "ignored") where.push("res.resolution = 'ignored'");
  if (f.ids) {
    params.push(f.ids);
    where.push(`res.id = ANY($${params.length}::uuid[])`);
  }
  const q = f.q?.trim();
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(rr.asset_tag ILIKE ${p} OR rr.serial ILIKE ${p} OR rr.name ILIKE ${p} OR rr.model ILIKE ${p}
               OR i.name ILIKE ${p} OR i.asset_code ILIKE ${p} OR u.asset_code ILIKE ${p})`);
  }
  const whereSql = where.join(" AND ");
  const from = `
    FROM reconciliation_results res
    LEFT JOIN register_rows rr ON rr.id = res.row_id
    LEFT JOIN items i ON i.id = res.item_id
    LEFT JOIN item_units u ON u.id = res.unit_id
    LEFT JOIN items p ON p.id = res.proposal_item_id`;
  const [page, total, locIndex] = await Promise.all([
    pool.query(
      `SELECT res.*,
              rr.row_number, rr.asset_tag, rr.serial, rr.epc, rr.bindex_code, rr.name AS row_name,
              rr.model AS row_model, rr.brand AS row_brand, rr.location_text, rr.custodian,
              rr.cost_cents, rr.purchase_date, rr.created_item_id, rr.edits,
              i.name AS item_name, i.asset_code AS item_asset_code, i.model AS item_model,
              i.flagged_missing AS item_flagged_missing,
              coalesce(u.location_id, i.location_id) AS current_location_id,
              u.asset_code AS unit_asset_code, u.label AS unit_label,
              p.name AS proposal_name, p.asset_code AS proposal_asset_code
         ${from}
        WHERE ${whereSql}
        ORDER BY rr.row_number NULLS LAST, i.name, u.asset_code
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    pool.query(`SELECT count(*)::int AS n ${from} WHERE ${whereSql}`, params),
    loadLocationIndex(),
  ]);

  const results = page.rows.map((r) => {
    const snap = r.snapshot as ResultSnapshot;
    return {
      id: r.id as string,
      classes: r.classes as ReconcileClass[],
      matchMethod: r.match_method as string | null,
      conflicts: r.conflicts as { field: string; register: string | null; bindex: string | null }[],
      notes: r.notes as string[],
      resolution: r.resolution as "resolved" | "ignored" | null,
      resolutionNote: r.resolution_note as string | null,
      resolvedBy: r.resolved_by as string | null,
      resolvedAt: r.resolved_at as Date | null,
      row: r.row_id
        ? {
            id: r.row_id as string,
            rowNumber: r.row_number as number,
            assetTag: r.asset_tag as string | null,
            serial: r.serial as string | null,
            epc: r.epc as string | null,
            bindexCode: r.bindex_code as string | null,
            name: r.row_name as string | null,
            model: r.row_model as string | null,
            brand: r.row_brand as string | null,
            locationText: r.location_text as string | null,
            custodian: r.custodian as string | null,
            costCents: r.cost_cents == null ? null : Number(r.cost_cents),
            purchaseDate: r.purchase_date as string | null,
            createdItemId: r.created_item_id as string | null,
            edits: r.edits as Record<string, unknown>,
          }
        : null,
      registerLocation: r.register_location_id
        ? { id: r.register_location_id as string, path: locIndex.path(r.register_location_id) }
        : null,
      asset: r.item_id
        ? {
            itemId: r.item_id as string,
            unitId: r.unit_id as string | null,
            name: (r.item_name as string | null) ?? snap.itemName ?? null,
            assetCode: (r.unit_asset_code as string | null) ?? (r.item_asset_code as string | null) ?? snap.unitAssetCode ?? snap.itemAssetCode ?? null,
            unitLabel: r.unit_label as string | null,
            model: r.item_model as string | null,
            flaggedMissing: r.item_flagged_missing as boolean | null,
            exists: r.item_name != null,
            locationAtRun: r.bindex_location_id
              ? { id: r.bindex_location_id as string, path: locIndex.path(r.bindex_location_id) }
              : null,
            location: r.current_location_id
              ? { id: r.current_location_id as string, path: locIndex.path(r.current_location_id) }
              : null,
          }
        : null,
      proposal: r.proposal_item_id
        ? {
            itemId: r.proposal_item_id as string,
            score: Number(r.proposal_score),
            name: (r.proposal_name as string | null) ?? snap.proposalName ?? null,
            assetCode: (r.proposal_asset_code as string | null) ?? snap.proposalAssetCode ?? null,
          }
        : null,
      snapshot: snap,
    };
  });
  return { results, total: total.rows[0]?.n ?? 0, offset, limit };
}

/** Pair two runs' results and report what changed from the older to the newer. */
export async function compareRunPair(runId: string, otherId: string) {
  if (runId === otherId) throw badRequest("Pick a different run to compare with.");
  const [a, b] = await Promise.all([getRun(runId), getRun(otherId)]);
  const [older, newer] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
  // A register row is identified by its register key (with a counter for
  // repeats), so it pairs with itself across runs and across re-uploads of the
  // same register whether or not it matched; an asset no row claimed is
  // identified by the asset.
  const load = async (id: string): Promise<CompareInput[]> => {
    const { results } = await listResults(id, { status: "all", limit: 100_000 });
    const seen = new Map<string, number>();
    return results.map((r) => {
      if (r.row) {
        const reg =
          normKey(r.row.assetTag) ?? normKey(r.row.serial) ?? r.row.epc ?? normKey(r.row.bindexCode) ??
          normKey(r.row.name) ?? `#${r.row.rowNumber}`;
        const n = (seen.get(reg) ?? 0) + 1;
        seen.set(reg, n);
        const what = r.row.assetTag ?? r.row.serial ?? r.row.name ?? r.row.model ?? "";
        return {
          key: `row:${reg}:${n}`,
          label: `Row ${r.row.rowNumber}: ${what}`.trim(),
          classes: r.classes,
          ignored: r.resolution === "ignored",
        };
      }
      return {
        key: r.asset?.unitId ? unitKey(r.asset.unitId) : itemKey(r.asset?.itemId ?? r.id),
        label: `${r.asset?.assetCode ?? ""} ${r.asset?.name ?? ""}`.trim(),
        classes: r.classes,
        ignored: r.resolution === "ignored",
      };
    });
  };
  const [before, after] = await Promise.all([load(older.id), load(newer.id)]);
  return {
    before: { id: older.id, createdAt: older.createdAt, importName: older.importName, scopeLabel: older.scopeLabel },
    after: { id: newer.id, createdAt: newer.createdAt, importName: newer.importName, scopeLabel: newer.scopeLabel },
    ...compareRuns(before, after),
  };
}
