import { pool } from "../../db/client";
import { containerLocations, loadPlaces } from "./gather";
import { getSettings } from "./settings";
import { analyzeStorage, distanceOf, type StorageAsset, type StorageItem, type StorageReport, type ZoneMove } from "./storage";
import { suggestSlotting, type SlottingResult } from "./slotting";

/**
 * Reads what storage analytics and slotting need, and caches the result for a
 * minute: the queries walk the item history, and the Insights page asks for
 * the report, the item list and the slotting suggestions in quick succession.
 */

const DAY = 86_400_000;
const CACHE_MS = 60_000;

// Movements recorded in item history. A tracking move is its own action; a
// move on file is an update whose only changed fields are the place (an edit
// form that saves every field is not a move); a bulk move lists its items.
const MOVES_SQL = `
  SELECT e.item_id, e.created_at
    FROM item_events e
   WHERE e.item_id IS NOT NULL
     AND (e.action = 'moved'
          OR (e.action = 'updated'
              AND jsonb_typeof(e.detail->'fields') = 'array'
              AND e.detail->'fields' ?| ARRAY['locationId', 'parentItemId']
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.detail->'fields') AS f(x)
                               WHERE f.x NOT IN ('locationId', 'parentItemId'))))
  UNION ALL
  SELECT x.id::uuid, e.created_at
    FROM item_events e
   CROSS JOIN LATERAL jsonb_array_elements_text(
     CASE WHEN jsonb_typeof(e.detail->'ids') = 'array' THEN e.detail->'ids' ELSE '[]'::jsonb END) AS x(id)
   WHERE e.item_id IS NULL AND e.action = 'updated'
     AND jsonb_typeof(e.detail->'set') = 'object' AND e.detail->'set' ? 'locationId'
     AND x.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

async function loadAssets(now: Date, windowDays: number): Promise<StorageAsset[]> {
  const since = new Date(now.getTime() - windowDays * DAY);
  const { rows } = await pool.query(
    `WITH moves AS (${MOVES_SQL}),
     agg AS (
       SELECT item_id,
              count(*) FILTER (WHERE created_at >= $1)::int AS n,
              max(created_at) AS last_at,
              (array_agg(created_at ORDER BY created_at DESC) FILTER (WHERE created_at >= $1))[1:50] AS recent
         FROM moves GROUP BY item_id
     )
     SELECT i.id, i.name, i.asset_code, i.category, i.location_id, i.parent_item_id, i.created_at,
            p.location_id AS zone_id, p.entered_at,
            coalesce(a.n, 0) AS n, a.last_at, a.recent
       FROM items i
       LEFT JOIN asset_positions p ON p.item_id = i.id AND p.unit_id IS NULL
       LEFT JOIN agg a ON a.item_id = i.id
      WHERE i.status = 'active' AND i.category IS DISTINCT FROM 'Domain'`,
    [since],
  );
  const inContainers = rows
    .filter((r) => r.location_id == null && r.zone_id == null && r.parent_item_id != null)
    .map((r) => r.id as string);
  const containerLoc = await containerLocations(inContainers);

  const out: StorageAsset[] = [];
  for (const r of rows) {
    const tracked = r.zone_id != null && r.entered_at != null;
    const locationId: string | null = tracked ? r.zone_id : (r.location_id ?? containerLoc.get(r.id) ?? null);
    if (!locationId) continue;
    const since = tracked
      ? new Date(r.entered_at)
      : r.last_at
        ? new Date(r.last_at)
        : new Date(r.created_at);
    out.push({
      itemId: r.id,
      name: r.name,
      code: r.asset_code ?? null,
      category: r.category ?? null,
      locationId,
      since,
      source: tracked ? "tracking" : "record",
      movements: ((r.recent as (string | Date)[] | null) ?? []).map((d) => new Date(d)),
      movementCount: Number(r.n),
    });
  }
  return out;
}

async function loadZoneMoves(now: Date, windowDays: number): Promise<ZoneMove[]> {
  const since = new Date(now.getTime() - windowDays * DAY);
  const { rows } = await pool.query(
    `SELECT e.detail->>'from' AS from_id, e.detail->>'to' AS to_id, count(*)::int AS n
       FROM item_events e
      WHERE e.action = 'moved' AND e.created_at >= $1
      GROUP BY 1, 2`,
    [since],
  );
  return rows.map((r) => ({ from: r.from_id ?? null, to: r.to_id ?? null, count: Number(r.n) }));
}

type Analysis = {
  at: number;
  report: StorageReport;
  items: StorageItem[];
  slotting: SlottingResult;
};

let cached: Analysis | null = null;
let pending: Promise<Analysis> | null = null;

async function analyze(): Promise<Analysis> {
  const now = new Date();
  const settings = await getSettings();
  const [assets, zoneMoves, { places, distances }] = await Promise.all([
    loadAssets(now, settings.storage.windowDays),
    loadZoneMoves(now, settings.storage.windowDays),
    loadPlaces(),
  ]);
  const { report, items } = analyzeStorage({ assets, zoneMoves, places, distances, settings, now });
  const slotting = suggestSlotting(items, (id) => distanceOf(places, distances, id), settings);
  return { at: Date.now(), report, items, slotting };
}

/** The analysis, at most a minute old. `fresh` recomputes it. */
export async function storageAnalysis(fresh = false): Promise<Analysis> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached;
  // One computation at a time, shared by everyone waiting for it.
  pending ??= analyze().finally(() => {
    pending = null;
  });
  cached = await pending;
  return cached;
}

/** Forget the cached analysis, after thresholds or profiles change. */
export function invalidateStorage(): void {
  cached = null;
}

export type StorageItemFilters = {
  abc?: "A" | "B" | "C";
  locationId?: string;
  longStored?: boolean;
  q?: string;
  sort?: "dwell" | "movements" | "next";
  limit?: number;
  offset?: number;
};

export async function listStorageItems(f: StorageItemFilters): Promise<{ items: StorageItem[]; total: number }> {
  const { items } = await storageAnalysis();
  const q = f.q?.toLowerCase();
  let list = items.filter(
    (i) =>
      (!f.abc || i.abc === f.abc) &&
      (!f.locationId || i.locationId === f.locationId) &&
      (f.longStored === undefined || i.longStored === f.longStored) &&
      (!q || i.name.toLowerCase().includes(q) || (i.code ?? "").toLowerCase().includes(q)),
  );
  const by = f.sort ?? "dwell";
  list = [...list].sort((x, y) => {
    if (by === "movements") return y.movements - x.movements || x.itemId.localeCompare(y.itemId);
    if (by === "next") {
      const a = x.predictedNextAt ?? "9999";
      const b = y.predictedNextAt ?? "9999";
      return a.localeCompare(b) || x.itemId.localeCompare(y.itemId);
    }
    return y.dwellDays - x.dwellDays || x.itemId.localeCompare(y.itemId);
  });
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  return { items: list.slice(offset, offset + limit), total: list.length };
}
