import { pool } from "../../db/client";
import type { ConditionRating } from "../../db/tables/ai-condition";
import { badRequest, notFound } from "../../lib/errors";
import { actorFromOid, publish } from "../event-backbone";
import { resolveCode } from "../tracking";
import "./events";

/**
 * Condition sweeps: walk a location, scan each thing, photograph it, record
 * its condition, next. The sweep row holds the location and stage; progress is
 * the set of reports carrying the sweep's id, so it survives a closed tab and
 * two people can sweep the same floor at once.
 */

export type SweepStage = "before" | "after" | "inspection";

export type Sweep = {
  id: string;
  locationId: string | null;
  locationName: string | null;
  name: string | null;
  stage: SweepStage;
  status: "open" | "closed";
  startedBy: string | null;
  startedByName: string | null;
  startedAt: Date;
  closedAt: Date | null;
  /** Items expected here (at the location or anywhere inside it). */
  expected: number;
  /** Distinct items with a report in this sweep. */
  checked: number;
};

export type SweepItem = {
  itemId: string;
  name: string;
  assetCode: string;
  locationId: string | null;
  locationName: string | null;
  primaryImageUrl: string | null;
  /** This sweep's latest report on the item, if it has been checked. */
  report: { id: string; rating: ConditionRating | null; createdAt: Date } | null;
};

export type SweepDetail = Sweep & {
  items: SweepItem[];
  /** Checked during the sweep but recorded somewhere else. */
  extra: SweepItem[];
};

// Items in a location subtree. UNION, not UNION ALL, so a loop in the location
// tree cannot recurse forever. Domains are not physical and are left out.
const SUBTREE = `
  WITH RECURSIVE zone AS (
    SELECT id FROM locations WHERE id = $1
    UNION
    SELECT l.id FROM locations l JOIN zone z ON l.parent_id = z.id
  )`;

const MAX_ITEMS = 2000;

type SweepRow = {
  id: string;
  location_id: string | null;
  location_name: string | null;
  name: string | null;
  stage: SweepStage;
  status: "open" | "closed";
  started_by: string | null;
  started_by_name: string | null;
  started_at: Date;
  closed_at: Date | null;
  checked: number;
};

const SWEEP_SELECT = `
  SELECT s.id, s.location_id, l.name AS location_name, s.name, s.stage, s.status, s.started_by,
         us.name AS started_by_name, s.started_at, s.closed_at,
         (SELECT count(DISTINCT r.item_id)::int FROM condition_reports r WHERE r.sweep_id = s.id) AS checked
    FROM condition_sweeps s
    LEFT JOIN locations l ON l.id = s.location_id
    LEFT JOIN users us ON us.oid = s.started_by`;

async function expectedCount(locationId: string | null): Promise<number> {
  if (!locationId) return 0;
  const { rows } = await pool.query<{ n: number }>(
    `${SUBTREE} SELECT count(*)::int AS n FROM items
      WHERE location_id IN (SELECT id FROM zone) AND category IS DISTINCT FROM 'Domain'`,
    [locationId],
  );
  return rows[0]?.n ?? 0;
}

async function present(row: SweepRow): Promise<Sweep> {
  return {
    id: row.id,
    locationId: row.location_id,
    locationName: row.location_name,
    name: row.name,
    stage: row.stage,
    status: row.status,
    startedBy: row.started_by,
    startedByName: row.started_by_name,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    expected: await expectedCount(row.location_id),
    checked: row.checked,
  };
}

export async function startSweep(
  input: { locationId: string; stage?: SweepStage; name?: string | null },
  userOid: string | null,
): Promise<Sweep> {
  const { rows: loc } = await pool.query<{ name: string }>("SELECT name FROM locations WHERE id = $1", [input.locationId]);
  if (!loc[0]) throw notFound("That location no longer exists.");
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO condition_sweeps (location_id, name, stage, started_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.locationId, input.name?.trim() || null, input.stage ?? "inspection", userOid],
  );
  const sweep = (await getSweep(rows[0]!.id))!;
  await publish(
    "condition_sweep.started",
    { sweepId: sweep.id, locationId: sweep.locationId, locationName: sweep.locationName, stage: sweep.stage, expected: sweep.expected },
    { actor: actorFromOid(userOid), subject: { type: "condition_sweep", id: sweep.id } },
  );
  return sweep;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function getSweep(id: string): Promise<Sweep | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<SweepRow>(`${SWEEP_SELECT} WHERE s.id = $1`, [id]);
  return rows[0] ? present(rows[0]) : null;
}

export async function listSweeps(opts: { status?: "open" | "closed"; limit?: number } = {}): Promise<Sweep[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const { rows } = await pool.query<SweepRow>(
    `${SWEEP_SELECT} WHERE ($1::text IS NULL OR s.status = $1) ORDER BY s.started_at DESC LIMIT $2`,
    [opts.status ?? null, limit],
  );
  return Promise.all(rows.map(present));
}

type ItemRow = {
  item_id: string;
  name: string;
  asset_code: string;
  location_id: string | null;
  location_name: string | null;
  primary_image_url: string | null;
  report_id: string | null;
  rating: ConditionRating | null;
  reported_at: Date | null;
};

const itemView = (r: ItemRow): SweepItem => ({
  itemId: r.item_id,
  name: r.name,
  assetCode: r.asset_code,
  locationId: r.location_id,
  locationName: r.location_name,
  primaryImageUrl: r.primary_image_url,
  report: r.report_id ? { id: r.report_id, rating: r.rating, createdAt: r.reported_at! } : null,
});

/** The sweep with what is expected at its location and what has been checked. */
export async function getSweepDetail(id: string): Promise<SweepDetail> {
  const sweep = await getSweep(id);
  if (!sweep) throw notFound("Condition sweep not found.");
  const latest = `
    LEFT JOIN LATERAL (
      SELECT r.id AS report_id, r.rating, r.created_at AS reported_at FROM condition_reports r
       WHERE r.sweep_id = $2 AND r.item_id = i.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1
    ) rep ON true
    LEFT JOIN locations l ON l.id = i.location_id`;
  const cols = `i.id AS item_id, i.name, i.asset_code, i.location_id, l.name AS location_name,
                i.primary_image_url, rep.report_id, rep.rating, rep.reported_at`;
  const [expected, extra] = await Promise.all([
    sweep.locationId
      ? pool.query<ItemRow>(
          `${SUBTREE} SELECT ${cols} FROM items i ${latest}
            WHERE i.location_id IN (SELECT id FROM zone) AND i.category IS DISTINCT FROM 'Domain'
            ORDER BY l.name NULLS FIRST, i.name LIMIT ${MAX_ITEMS}`,
          [sweep.locationId, id],
        )
      : Promise.resolve({ rows: [] as ItemRow[] }),
    pool.query<ItemRow>(
      `SELECT ${cols} FROM items i ${latest.replace("$2", "$1")}
        WHERE i.id IN (SELECT item_id FROM condition_reports WHERE sweep_id = $1)
        ORDER BY i.name`,
      [id],
    ),
  ]);
  const inPlace = new Set(expected.rows.map((r) => r.item_id));
  return {
    ...sweep,
    items: expected.rows.map(itemView),
    extra: extra.rows.filter((r) => !inPlace.has(r.item_id)).map(itemView),
  };
}

export type SweepScan = {
  itemId: string;
  unitId: string | null;
  name: string;
  assetCode: string;
  primaryImageUrl: string | null;
  locationName: string | null;
  /** Whether the item is recorded at the sweep's location (or inside it). */
  expected: boolean;
  /** This sweep's latest report on it, when it has already been checked. */
  report: { id: string; rating: ConditionRating | null; createdAt: Date } | null;
};

const DEEP_LINK = /\/items\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

/**
 * Resolve a scanned code during a sweep. Uses the hardware resolver on
 * purpose: a sweep scans every item once, and each scan should not also land
 * in the item's history as "scanned".
 */
export async function resolveSweepScan(id: string, rawCode: string): Promise<SweepScan> {
  const sweep = await getSweep(id);
  if (!sweep) throw notFound("Condition sweep not found.");
  const code = rawCode.trim();
  if (!code) throw badRequest("Scan a code.");
  const link = DEEP_LINK.exec(code);
  const asset = link ? { itemId: link[1]!.toLowerCase(), unitId: null } : await resolveCode(code);
  if (!asset) throw notFound(`Nothing is recorded with the code "${code.slice(0, 60)}". Pick the item from the list instead.`);

  const { rows } = await pool.query<ItemRow & { in_zone: boolean }>(
    `${SUBTREE}
     SELECT i.id AS item_id, i.name, i.asset_code, i.location_id, l.name AS location_name, i.primary_image_url,
            rep.report_id, rep.rating, rep.reported_at,
            (i.location_id IS NOT NULL AND i.location_id IN (SELECT id FROM zone)) AS in_zone
       FROM items i
       LEFT JOIN LATERAL (
         SELECT r.id AS report_id, r.rating, r.created_at AS reported_at FROM condition_reports r
          WHERE r.sweep_id = $2 AND r.item_id = i.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1
       ) rep ON true
       LEFT JOIN locations l ON l.id = i.location_id
      WHERE i.id = $3`,
    [sweep.locationId, id, asset.itemId],
  );
  const row = rows[0];
  if (!row) throw notFound("That item no longer exists.");
  const view = itemView(row);
  return {
    itemId: view.itemId,
    unitId: asset.unitId,
    name: view.name,
    assetCode: view.assetCode,
    primaryImageUrl: view.primaryImageUrl,
    locationName: view.locationName,
    expected: row.in_zone,
    report: view.report,
  };
}

export async function closeSweep(id: string, userOid: string | null): Promise<Sweep> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE condition_sweeps SET status = 'closed', closed_by = $2, closed_at = now()
      WHERE id = $1 AND status = 'open' RETURNING id`,
    [id, userOid],
  );
  const sweep = await getSweep(id);
  if (!sweep) throw notFound("Condition sweep not found.");
  if (rows[0]) {
    await publish(
      "condition_sweep.closed",
      {
        sweepId: id,
        locationId: sweep.locationId,
        locationName: sweep.locationName,
        stage: sweep.stage,
        expected: sweep.expected,
        checked: sweep.checked,
      },
      { actor: actorFromOid(userOid), subject: { type: "condition_sweep", id } },
    );
  }
  return sweep;
}
