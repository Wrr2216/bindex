import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

/** Dwell time, ABC classes, retrieval prediction, zone statistics and slotting. Pure. */

process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Storage = typeof import("../src/services/ops-intel/storage");
type Slotting = typeof import("../src/services/ops-intel/slotting");
type Model = typeof import("../src/services/ops-intel/model");
type Places = typeof import("../src/services/ops-intel/places");
type StorageAsset = import("../src/services/ops-intel/storage").StorageAsset;

let storage: Storage;
let slotting: Slotting;
let model: Model;
let PlaceIndex: Places["PlaceIndex"];

before(async () => {
  storage = await import("../src/services/ops-intel/storage");
  slotting = await import("../src/services/ops-intel/slotting");
  model = await import("../src/services/ops-intel/model");
  ({ PlaceIndex } = await import("../src/services/ops-intel/places"));
});

const NOW = new Date("2026-09-26T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

describe("classifyAbc", () => {
  it("gives A to the records behind the first 80% of movements, B to the next 15%, C to the rest", () => {
    const counts = [
      { id: "a", movements: 50 },
      { id: "b", movements: 30 },
      { id: "c", movements: 10 },
      { id: "d", movements: 6 },
      { id: "e", movements: 4 },
      { id: "f", movements: 0 },
    ];
    const cls = storage.classifyAbc(counts, 0.8, 0.95);
    // Before each: a 0%, b 50%, c 80%, d 90%, e 96%.
    assert.deepEqual(
      ["a", "b", "c", "d", "e", "f"].map((id) => cls.get(id)),
      ["A", "A", "B", "B", "C", "C"],
    );
  });

  it("puts everything in C when nothing moved, and breaks ties by id", () => {
    const none = storage.classifyAbc([{ id: "x", movements: 0 }, { id: "y", movements: 0 }], 0.8, 0.95);
    assert.deepEqual([...none.values()], ["C", "C"]);
    const tie = storage.classifyAbc([{ id: "b", movements: 5 }, { id: "a", movements: 5 }], 0.5, 0.9);
    assert.equal(tie.get("a"), "A");
    assert.equal(tie.get("b"), "B");
  });
});

describe("predictNext", () => {
  it("adds the median gap to the last movement", () => {
    const r = storage.predictNext([daysAgo(30), daysAgo(20), daysAgo(12), daysAgo(0)]);
    // Gaps 10, 8 and 12 days: median 10.
    assert.equal(r.medianIntervalDays, 10);
    assert.equal(r.predictedNextAt?.toISOString(), new Date(NOW.getTime() + 10 * DAY).toISOString());
  });

  it("needs two movements", () => {
    assert.deepEqual(storage.predictNext([daysAgo(3)]), { medianIntervalDays: null, predictedNextAt: null });
  });
});

// Warehouse > Front (5 m from the dock), Warehouse > Back (80 m), and a shelf in Back that inherits it.
const W = "00000000-0000-4000-8000-00000000000a";
const FRONT = "00000000-0000-4000-8000-0000000000f1";
const BACK = "00000000-0000-4000-8000-0000000000b1";
const SHELF = "00000000-0000-4000-8000-0000000000b2";
const places = () =>
  new PlaceIndex([
    { id: W, parentId: null, name: "Warehouse" },
    { id: FRONT, parentId: W, name: "Front" },
    { id: BACK, parentId: W, name: "Back" },
    { id: SHELF, parentId: BACK, name: "Shelf 9" },
  ]);
const distances = () =>
  new Map([
    [FRONT, 5],
    [BACK, 80],
  ]);

const asset = (id: string, locationId: string, movesDaysAgo: number[], sinceDays: number): StorageAsset => ({
  itemId: id,
  name: `Thing ${id}`,
  code: `INV-${id.toUpperCase()}`,
  category: null,
  locationId,
  since: daysAgo(sinceDays),
  source: "record",
  movements: movesDaysAgo.map(daysAgo),
  movementCount: movesDaysAgo.length,
});

function analysis(assets: StorageAsset[], patch: unknown = {}) {
  return storage.analyzeStorage({
    assets,
    zoneMoves: [
      { from: BACK, to: FRONT, count: 3 },
      { from: null, to: BACK, count: 1 },
    ],
    places: places(),
    distances: distances(),
    settings: model.mergeSettings(model.defaultSettings(), patch),
    now: NOW,
  });
}

describe("analyzeStorage", () => {
  it("measures dwell, long-stored records and per-zone statistics", () => {
    const { report, items } = analysis([
      asset("a", SHELF, [1, 3, 5, 7, 9, 11, 13, 15], 1),
      asset("b", FRONT, [], 400),
      asset("c", FRONT, [40], 40),
    ]);
    const b = items.find((i) => i.itemId === "b")!;
    assert.equal(b.dwellDays, 400);
    assert.equal(b.longStored, true);
    assert.equal(b.abc, "C");
    assert.equal(items.find((i) => i.itemId === "a")!.abc, "A");
    assert.equal(report.totals.longStored, 1);
    assert.equal(report.longStored[0]?.itemId, "b");
    assert.equal(report.topMovers[0]?.itemId, "a");

    const front = report.zones.find((z) => z.locationId === FRONT)!;
    assert.equal(front.occupancy, 2);
    assert.equal(front.avgDwellDays, 220);
    assert.equal(front.movesIn, 3);
    assert.equal(front.distanceToDockM, 5);
    const back = report.zones.find((z) => z.locationId === BACK)!;
    assert.equal(back.movesOut, 3);
    assert.equal(back.occupancy, 0);
    assert.equal(back.turnover, 3);
    const shelf = report.zones.find((z) => z.locationId === SHELF)!;
    assert.equal(shelf.distanceToDockM, 80, "inherits the aisle's distance");
    assert.equal(shelf.path, "Warehouse / Back / Shelf 9");
  });

  it("reports moves per month over the window", () => {
    const { items } = analysis([asset("a", FRONT, [1, 2, 3], 1)], { storage: { windowDays: 30 } });
    assert.equal(items[0]!.movesPerMonth, 3);
  });
});

describe("suggestSlotting", () => {
  const run = (assets: StorageAsset[], patch: unknown = {}) => {
    const settings = model.mergeSettings(model.defaultSettings(), patch);
    const { items } = analysis(assets, patch);
    const p = places();
    const d = distances();
    return slotting.suggestSlotting(items, (id) => storage.distanceOf(p, d, id), settings);
  };

  it("swaps a fast mover at the back with a slow mover at the front, and says why", () => {
    const r = run([
      asset("fast", SHELF, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1),
      asset("slow", FRONT, [], 200),
      asset("mid", FRONT, [20], 20),
      asset("idle", BACK, [], 300),
    ]);
    assert.equal(r.cutoffM, 42.5);
    assert.equal(r.suggestions.length, 1);
    const s = r.suggestions[0]!;
    assert.equal(s.kind, "swap");
    assert.equal(s.fast.itemId, "fast");
    assert.equal(s.slow?.itemId, "slow");
    assert.equal(s.gainM, 75);
    assert.match(s.explanation, /Thing fast \(INV-FAST\) moved 10 times/);
    assert.match(s.explanation, /75 m closer/);
    assert.equal(r.rule, slotting.SLOTTING_RULE);
  });

  it("asks for a closer spot when there is nobody left to swap with", () => {
    const r = run([asset("fast", SHELF, [1, 2, 3], 1), asset("mid", FRONT, [9], 9)], { storage: { abcA: 0.5 } });
    assert.equal(r.suggestions[0]?.kind, "move_closer");
    assert.equal(r.suggestions[0]?.slow, null);
  });

  it("honours the minimum gain and leaves out places with no distance", () => {
    const r = run(
      [asset("fast", SHELF, [1, 2, 3, 4], 1), asset("slow", FRONT, [], 200), asset("nowhere", W, [], 5)],
      { slotting: { minGainM: 100 } },
    );
    assert.equal(r.withoutDistance, 1);
    assert.equal(r.suggestions[0]?.kind, "move_closer");
  });

  it("returns nothing when no place has a distance", () => {
    const settings = model.defaultSettings();
    const r = slotting.suggestSlotting([], () => null, settings);
    assert.equal(r.cutoffM, null);
    assert.deepEqual(r.suggestions, []);
  });
});
