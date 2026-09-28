import type { OpsSettings } from "./model";
import type { PlaceIndex } from "./places";

/**
 * Storage analytics: how long things have been where they are, how often they
 * move, which places are full of things that never move, and which things
 * are likely to be asked for next. Pure; storageData.ts gathers the rows.
 *
 * A movement is any recorded change of place: a reader moving an asset
 * between zones, a move on file, a bulk move. Dwell is the time since the
 * asset arrived where it is now: from its tracked position when it has one,
 * otherwise from its last movement, otherwise from when it was added.
 */

export type AbcClass = "A" | "B" | "C";

export type StorageAsset = {
  itemId: string;
  name: string;
  code: string | null;
  category: string | null;
  /** Where it is now: the tracked zone when there is one, else the recorded place. */
  locationId: string | null;
  since: Date;
  source: "tracking" | "record";
  /** Movements inside the analytics window, newest first. */
  movements: Date[];
  /** Total movements inside the window (the list may be capped). */
  movementCount: number;
};

export type ZoneMove = { from: string | null; to: string | null; count: number };

export type StorageItem = {
  itemId: string;
  name: string;
  code: string | null;
  category: string | null;
  locationId: string | null;
  locationPath: string | null;
  since: string;
  source: "tracking" | "record";
  dwellDays: number;
  movements: number;
  movesPerMonth: number;
  lastMovedAt: string | null;
  /** Median gap between movements, when there are at least two. */
  medianIntervalDays: number | null;
  /** Last movement plus the median gap: when it is likely to be asked for next. */
  predictedNextAt: string | null;
  abc: AbcClass;
  longStored: boolean;
};

export type ZoneStat = {
  locationId: string;
  path: string;
  distanceToDockM: number | null;
  occupancy: number;
  avgDwellDays: number;
  maxDwellDays: number;
  longStored: number;
  movesIn: number;
  movesOut: number;
  /** Moves out over the window per asset held now. */
  turnover: number;
  abc: Record<AbcClass, number>;
};

export type StorageReport = {
  generatedAt: string;
  windowDays: number;
  longStoredDays: number;
  totals: { assets: number; movements: number; longStored: number } & Record<AbcClass, number>;
  zones: ZoneStat[];
  longStored: StorageItem[];
  topMovers: StorageItem[];
};

const DAY = 86_400_000;
const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * Pareto classes by movement count. Sorted by movements, most first, an asset
 * is A while the movements before it make up less than `a` of the total, B
 * while they make up less than `b`, and C after that. Assets that never moved
 * are always C, and ties are broken by id so the result is stable.
 */
export function classifyAbc(
  counts: { id: string; movements: number }[],
  a: number,
  b: number,
): Map<string, AbcClass> {
  const sorted = [...counts].sort((x, y) => y.movements - x.movements || x.id.localeCompare(y.id));
  const total = sorted.reduce((s, x) => s + x.movements, 0);
  const out = new Map<string, AbcClass>();
  let before = 0;
  for (const x of sorted) {
    if (x.movements <= 0 || total === 0) out.set(x.id, "C");
    else {
      const share = before / total;
      out.set(x.id, share < a ? "A" : share < b ? "B" : "C");
    }
    before += x.movements;
  }
  return out;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The next likely movement: the last one plus the median gap between the
 * ones in the window. Needs two movements; one gives no rhythm to go by.
 */
export function predictNext(movements: Date[]): { medianIntervalDays: number | null; predictedNextAt: Date | null } {
  const times = movements.map((d) => d.getTime()).sort((x, y) => x - y);
  if (times.length < 2) return { medianIntervalDays: null, predictedNextAt: null };
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  const gap = median(gaps)!;
  return { medianIntervalDays: round(gap / DAY, 2), predictedNextAt: new Date(times[times.length - 1]! + gap) };
}

export function analyzeStorage(input: {
  assets: StorageAsset[];
  zoneMoves: ZoneMove[];
  places: PlaceIndex;
  distances: Map<string, number>;
  settings: OpsSettings;
  now: Date;
}): { report: StorageReport; items: StorageItem[] } {
  const { assets, places, settings, now } = input;
  const { windowDays, longStoredDays, abcA, abcB } = settings.storage;
  const classes = classifyAbc(
    assets.map((a) => ({ id: a.itemId, movements: a.movementCount })),
    abcA,
    abcB,
  );

  const items: StorageItem[] = assets.map((a) => {
    const dwellDays = Math.max(0, (now.getTime() - a.since.getTime()) / DAY);
    const { medianIntervalDays, predictedNextAt } = predictNext(a.movements);
    const last = a.movements.length ? Math.max(...a.movements.map((d) => d.getTime())) : null;
    return {
      itemId: a.itemId,
      name: a.name,
      code: a.code,
      category: a.category,
      locationId: a.locationId,
      locationPath: places.path(a.locationId),
      since: a.since.toISOString(),
      source: a.source,
      dwellDays: round(dwellDays),
      movements: a.movementCount,
      movesPerMonth: round((a.movementCount / windowDays) * 30, 2),
      lastMovedAt: last === null ? null : new Date(last).toISOString(),
      medianIntervalDays,
      predictedNextAt: predictedNextAt?.toISOString() ?? null,
      abc: classes.get(a.itemId) ?? "C",
      longStored: dwellDays >= longStoredDays,
    };
  });

  const zones = new Map<string, ZoneStat & { dwellSum: number }>();
  const zone = (id: string) => {
    let z = zones.get(id);
    if (!z) {
      z = {
        locationId: id,
        path: places.path(id) ?? id,
        distanceToDockM: distanceOf(places, input.distances, id),
        occupancy: 0,
        avgDwellDays: 0,
        maxDwellDays: 0,
        longStored: 0,
        movesIn: 0,
        movesOut: 0,
        turnover: 0,
        abc: { A: 0, B: 0, C: 0 },
        dwellSum: 0,
      };
      zones.set(id, z);
    }
    return z;
  };
  for (const it of items) {
    if (!it.locationId || !places.has(it.locationId)) continue;
    const z = zone(it.locationId);
    z.occupancy += 1;
    z.dwellSum += it.dwellDays;
    z.maxDwellDays = Math.max(z.maxDwellDays, it.dwellDays);
    if (it.longStored) z.longStored += 1;
    z.abc[it.abc] += 1;
  }
  for (const m of input.zoneMoves) {
    if (m.to && places.has(m.to)) zone(m.to).movesIn += m.count;
    if (m.from && places.has(m.from)) zone(m.from).movesOut += m.count;
  }
  const zoneStats: ZoneStat[] = [...zones.values()]
    .map(({ dwellSum, ...z }) => ({
      ...z,
      avgDwellDays: z.occupancy ? round(dwellSum / z.occupancy) : 0,
      maxDwellDays: round(z.maxDwellDays),
      turnover: round(z.movesOut / Math.max(1, z.occupancy), 2),
    }))
    .sort((x, y) => y.occupancy - x.occupancy || x.path.localeCompare(y.path));

  const longStored = items
    .filter((i) => i.longStored)
    .sort((x, y) => y.dwellDays - x.dwellDays || x.itemId.localeCompare(y.itemId));
  const topMovers = items
    .filter((i) => i.movements > 0)
    .sort((x, y) => y.movements - x.movements || x.itemId.localeCompare(y.itemId));

  const count = (c: AbcClass) => items.filter((i) => i.abc === c).length;
  return {
    items,
    report: {
      generatedAt: now.toISOString(),
      windowDays,
      longStoredDays,
      totals: {
        assets: items.length,
        movements: items.reduce((s, i) => s + i.movements, 0),
        longStored: longStored.length,
        A: count("A"),
        B: count("B"),
        C: count("C"),
      },
      zones: zoneStats,
      longStored: longStored.slice(0, 100),
      topMovers: topMovers.slice(0, 25),
    },
  };
}

/** A shelf inside an aisle is as far from the dock as the aisle, unless it says otherwise. */
export function distanceOf(places: PlaceIndex, distances: Map<string, number>, id: string | null): number | null {
  for (const x of places.lineage(id)) {
    const d = distances.get(x);
    if (d !== undefined) return d;
  }
  return null;
}
