import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

/**
 * Load planning: measuring lines, vehicle capacity, first-fit-decreasing that
 * never exceeds a vehicle, the stop-ordered loading sequence, and the printed
 * plan. Pure.
 */

process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Load = typeof import("../src/services/ops-intel/load");
type Model = typeof import("../src/services/ops-intel/model");
type PlanLineInput = import("../src/services/ops-intel/load").PlanLineInput;
type PlanVehicleInput = import("../src/services/ops-intel/load").PlanVehicleInput;
type LoadPlan = import("../src/services/ops-intel/load").LoadPlan;

let load: Load;
let model: Model;

before(async () => {
  load = await import("../src/services/ops-intel/load");
  model = await import("../src/services/ops-intel/model");
});

const settings = (patch: unknown = {}) => model.mergeSettings(model.defaultSettings(), patch).load;

describe("measureLine", () => {
  it("prefers the record's own weight and volume", () => {
    const m = load.measureLine({ metadata: { weightKg: 12.5, volumeM3: "0.2" }, category: null, quantity: 1, wholeItem: true }, settings());
    assert.equal(m.weightKg, 12.5);
    assert.equal(m.volumeM3, 0.2);
    assert.equal(m.weightSource, "item");
    assert.equal(m.volumeSource, "item");
  });

  it("works volume out from dimensions, then falls back to the category, then the defaults", () => {
    const s = settings({ load: { categoryDefaults: { chairs: { weightKg: 9, volumeM3: 0.4 } } } });
    const dims = load.measureLine({ metadata: { lengthCm: 120, widthCm: 60, heightCm: 50 }, category: "Chairs", quantity: 1, wholeItem: true }, s);
    assert.equal(dims.volumeSource, "dimensions");
    assert.ok(Math.abs(dims.volumeM3 - 0.36) < 1e-9);
    assert.deepEqual(dims.dimsM, [1.2, 0.6, 0.5]);
    assert.equal(dims.weightSource, "category");
    assert.equal(dims.weightKg, 9);

    const cat = load.measureLine({ metadata: {}, category: " CHAIRS ", quantity: 1, wholeItem: true }, s);
    assert.equal(cat.volumeSource, "category");
    const def = load.measureLine({ metadata: { weightKg: "heavy", volumeM3: -1 }, category: "Desks", quantity: 1, wholeItem: true }, s);
    assert.equal(def.weightSource, "default");
    assert.equal(def.weightKg, 10);
    assert.equal(def.volumeM3, 0.05);
  });

  it("counts every piece of a whole-item line, and one for a unit line", () => {
    const whole = load.measureLine({ metadata: { weightKg: 2 }, category: null, quantity: 10, wholeItem: true }, settings());
    assert.equal(whole.pieces, 10);
    assert.equal(whole.weightKg, 20);
    const unit = load.measureLine({ metadata: { weightKg: 2 }, category: null, quantity: 10, wholeItem: false }, settings());
    assert.equal(unit.weightKg, 2);
  });
});

describe("capacityOf", () => {
  it("uses the stated volume, else the interior, times the fill factor", () => {
    const stated = load.capacityOf({ maxKg: 1000, maxM3: 20, interiorLengthM: null, interiorWidthM: null, interiorHeightM: null }, 0.85);
    assert.equal(stated?.maxM3, 17);
    const interior = load.capacityOf({ maxKg: null, maxM3: null, interiorLengthM: 4, interiorWidthM: 2, interiorHeightM: 2 }, 0.5);
    assert.equal(interior?.maxM3, 8);
    assert.deepEqual(interior?.interiorM, [4, 2, 2]);
    assert.equal(load.capacityOf({ maxKg: null, maxM3: null, interiorLengthM: 4, interiorWidthM: null, interiorHeightM: 2 }, 1), null);
    assert.equal(load.capacityOf(null, 1), null);
  });

  it("checks a piece fits the interior turned any way", () => {
    assert.equal(load.fitsInterior([2.5, 1, 0.5], [4, 2, 2]), true);
    assert.equal(load.fitsInterior([0.5, 2.5, 1].sort((a, b) => b - a) as [number, number, number], [4, 2, 2]), true);
    assert.equal(load.fitsInterior([4.5, 1, 0.5], [4, 2, 2]), false);
    assert.equal(load.fitsInterior(null, [4, 2, 2]), true);
  });
});

let seq = 0;
const lineOf = (over: Partial<PlanLineInput> & { kg: number; m3: number }): PlanLineInput => {
  const { kg, m3, ...rest } = over;
  seq += 1;
  return {
    jobItemId: `line-${String(seq).padStart(4, "0")}`,
    itemId: `item-${seq}`,
    unitId: null,
    name: `Box ${seq}`,
    code: `INV-${String(seq).padStart(6, "0")}`,
    stage: "packed",
    shipmentId: null,
    stopKey: "loc:a",
    stopLabel: "Stop A",
    measure: { pieces: 1, weightKg: kg, volumeM3: m3, weightSource: "item", volumeSource: "item", dimsM: null },
    ...rest,
  };
};

const vehicle = (key: string, maxKg: number | null, maxM3: number | null, interior: [number, number, number] | null = null): PlanVehicleInput => ({
  key,
  shipmentId: key.startsWith("loc:") ? null : key,
  shipmentCode: key.startsWith("loc:") ? null : `SHP-${key}`,
  name: `Truck ${key}`,
  vehicleLocationId: null,
  vehicleName: null,
  capacity:
    maxKg === null && maxM3 === null && !interior
      ? null
      : { maxKg, maxM3, nominalM3: maxM3, interiorM: interior, fillFactor: 1 },
});

function assertWithinCapacity(plan: LoadPlan) {
  for (const v of plan.vehicles) {
    const cap = v.capacity;
    const kg = v.lines.reduce((s, l) => s + l.measure.weightKg, 0);
    const m3 = v.lines.reduce((s, l) => s + l.measure.volumeM3, 0);
    if (!cap) {
      assert.equal(v.lines.filter((l) => !l.pinned).length, 0, "nothing planned onto a vehicle without capacity");
      continue;
    }
    if (cap.maxKg !== null) assert.ok(kg <= cap.maxKg + 1e-6, `${v.key}: ${kg} kg over ${cap.maxKg}`);
    if (cap.maxM3 !== null) assert.ok(m3 <= cap.maxM3 + 1e-6, `${v.key}: ${m3} m³ over ${cap.maxM3}`);
  }
}

function assertStopOrder(plan: LoadPlan) {
  for (const v of plan.vehicles) {
    assert.deepEqual(
      v.lines.map((l) => l.sequence),
      v.lines.map((_, i) => i + 1),
    );
    for (let i = 1; i < v.lines.length; i++) {
      assert.ok(v.lines[i - 1]!.stopIndex >= v.lines[i]!.stopIndex, `${v.key}: stop ${v.lines[i]!.stopIndex} loaded after ${v.lines[i - 1]!.stopIndex}`);
    }
  }
}

describe("planLoad", () => {
  it("packs largest first into the first vehicle that fits", () => {
    const lines = [lineOf({ kg: 300, m3: 1 }), lineOf({ kg: 700, m3: 2 }), lineOf({ kg: 400, m3: 1 }), lineOf({ kg: 600, m3: 1 })];
    const plan = load.planLoad({ lines, vehicles: [vehicle("t1", 1000, 10), vehicle("t2", 1000, 10)], fillFactor: 1 });
    const on = (key: string) => plan.vehicles.find((v) => v.key === key)!.lines.map((l) => l.measure.weightKg).sort((a, b) => a - b);
    // Decreasing by share of the biggest vehicle: 700, 600, 400, 300.
    assert.deepEqual(on("t1"), [300, 700]);
    assert.deepEqual(on("t2"), [400, 600]);
    assert.equal(plan.unassigned.length, 0);
    assertWithinCapacity(plan);
  });

  it("never exceeds capacity and lists what does not fit, with the reason", () => {
    const lines = [lineOf({ kg: 900, m3: 1 }), lineOf({ kg: 900, m3: 1 }), lineOf({ kg: 50, m3: 30 }), lineOf({ kg: 2000, m3: 1 })];
    const plan = load.planLoad({ lines, vehicles: [vehicle("t1", 1000, 10)], fillFactor: 1 });
    assertWithinCapacity(plan);
    const reasons = plan.unassigned.map((u) => [u.line.measure.weightKg, u.reason]);
    assert.deepEqual(reasons.sort(), [
      [2000, "Heavier than any vehicle can carry."],
      [50, "Bigger than any vehicle holds."],
      [900, "No room left on any vehicle."],
    ].sort());
  });

  it("checks the interior of a vehicle", () => {
    const long = lineOf({ kg: 10, m3: 0.1 });
    long.measure.dimsM = [5, 0.2, 0.1];
    const plan = load.planLoad({ lines: [long], vehicles: [vehicle("van", 1000, 10, [4, 2, 2]), vehicle("truck", 1000, 10, [7, 2.4, 2.4])], fillFactor: 1 });
    assert.equal(plan.vehicles.find((v) => v.key === "truck")!.lines.length, 1);
    const only = load.planLoad({ lines: [long], vehicles: [vehicle("van", 1000, 10, [4, 2, 2])], fillFactor: 1 });
    assert.equal(only.unassigned[0]?.reason, "Does not fit inside any vehicle's interior.");
  });

  it("loads the last stop first and the heaviest first within a stop", () => {
    const lines = [
      lineOf({ kg: 5, m3: 0.1, stopKey: "loc:1", stopLabel: "Floor 1" }),
      lineOf({ kg: 50, m3: 0.1, stopKey: "loc:1", stopLabel: "Floor 1" }),
      lineOf({ kg: 20, m3: 0.1, stopKey: "loc:3", stopLabel: "Floor 3" }),
      lineOf({ kg: 30, m3: 0.1, stopKey: "loc:2", stopLabel: "Floor 2" }),
    ];
    const plan = load.planLoad({ lines, vehicles: [vehicle("t1", 1000, 10)], fillFactor: 1, stopOrder: ["loc:1", "loc:2", "loc:3"] });
    const seq = plan.vehicles[0]!.lines.map((l) => [l.sequence, l.stopLabel, l.measure.weightKg]);
    assert.deepEqual(seq, [
      [1, "Floor 3", 20],
      [2, "Floor 2", 30],
      [3, "Floor 1", 50],
      [4, "Floor 1", 5],
    ]);
    assert.deepEqual(
      plan.stops.map((s) => s.label),
      ["Floor 1", "Floor 2", "Floor 3"],
    );

    // Reversed delivery order reverses the loading.
    const back = load.planLoad({ lines, vehicles: [vehicle("t1", 1000, 10)], fillFactor: 1, stopOrder: ["loc:3", "loc:2", "loc:1"] });
    assert.equal(back.vehicles[0]!.lines[0]!.stopLabel, "Floor 1");
    assertStopOrder(back);
  });

  it("orders unlisted stops by name, naturally", () => {
    const lines = ["Floor 10", "Floor 2", "Floor 9"].map((label) => lineOf({ kg: 1, m3: 0.01, stopKey: label, stopLabel: label }));
    const plan = load.planLoad({ lines, vehicles: [vehicle("t1", 100, 1)], fillFactor: 1, stopOrder: ["Floor 9", "nowhere"] });
    assert.deepEqual(
      plan.stops.map((s) => s.label),
      ["Floor 9", "Floor 2", "Floor 10"],
    );
    assert.ok(plan.warnings.some((w) => w.includes("nowhere")));

    const withNone = load.planLoad({
      lines: [lineOf({ kg: 1, m3: 0.01, stopKey: "none", stopLabel: "No destination" }), ...lines],
      vehicles: [vehicle("t1", 100, 1)],
      fillFactor: 1,
    });
    assert.equal(withNone.stops[withNone.stops.length - 1]!.key, "none", "no destination is delivered last");
  });

  it("keeps lines on their shipment unless repacking, and always keeps what is loaded", () => {
    const kept = lineOf({ kg: 100, m3: 1, shipmentId: "t2" });
    const onBoard = lineOf({ kg: 100, m3: 1, shipmentId: "t2", stage: "loaded" });
    const done = lineOf({ kg: 100, m3: 1, stage: "delivered" });
    const missing = lineOf({ kg: 100, m3: 1, stage: "missing" });
    const elsewhere = lineOf({ kg: 100, m3: 1, stage: "loaded", shipmentId: "gone" });
    const vehicles = [vehicle("t1", 1000, 10), vehicle("t2", 1000, 10)];
    const plan = load.planLoad({ lines: [kept, onBoard, done, missing, elsewhere], vehicles, fillFactor: 1 });
    const t2 = plan.vehicles.find((v) => v.key === "t2")!;
    assert.equal(t2.lines.length, 2);
    assert.ok(t2.lines.every((l) => l.pinned));
    assert.deepEqual(plan.skipped, { done: 1, elsewhere: 1, exception: 1 });

    const repacked = load.planLoad({ lines: [kept, onBoard], vehicles, fillFactor: 1, repack: true });
    assert.equal(repacked.vehicles.find((v) => v.key === "t1")!.lines[0]?.jobItemId, kept.jobItemId);
    assert.equal(repacked.vehicles.find((v) => v.key === "t2")!.lines[0]?.jobItemId, onBoard.jobItemId);
  });

  it("adds nothing to a vehicle already over capacity, and says so", () => {
    const heavy = lineOf({ kg: 1200, m3: 1, shipmentId: "t1", stage: "loaded" });
    const plan = load.planLoad({ lines: [heavy, lineOf({ kg: 1, m3: 0.01 })], vehicles: [vehicle("t1", 1000, 10)], fillFactor: 1 });
    assert.equal(plan.vehicles[0]!.over.weight, true);
    assert.equal(plan.vehicles[0]!.lines.length, 1);
    assert.equal(plan.unassigned.length, 1);
    assert.ok(plan.warnings.some((w) => w.includes("over its weight capacity")));
  });

  it("does not plan onto a vehicle with no capacity, and warns", () => {
    const plan = load.planLoad({ lines: [lineOf({ kg: 1, m3: 0.01 })], vehicles: [vehicle("t1", null, null)], fillFactor: 1 });
    assert.equal(plan.unassigned[0]?.reason, "No vehicle with a capacity to plan against.");
    assert.ok(plan.warnings.some((w) => w.includes("no capacity set")));
  });

  it("never exceeds capacity and respects stop order over many random plans", () => {
    let state = 42;
    const rand = () => {
      // xorshift32, so the test is the same every run.
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ((state >>> 0) % 1_000_000) / 1_000_000;
    };
    for (let round = 0; round < 300; round++) {
      const stops = Math.floor(rand() * 5) + 1;
      const lines = Array.from({ length: Math.floor(rand() * 60) }, () => {
        const stop = Math.floor(rand() * stops);
        const l = lineOf({
          kg: Math.round(rand() * 400 * 10) / 10 + 0.1,
          m3: Math.round(rand() * 3 * 1000) / 1000 + 0.001,
          stopKey: `s${stop}`,
          stopLabel: `Stop ${stop}`,
          stage: rand() < 0.8 ? "pending" : "packed",
        });
        if (rand() < 0.3) l.measure.dimsM = [rand() * 5, rand() * 2, rand() * 2].sort((a, b) => b - a) as [number, number, number];
        return l;
      });
      const vehicles = Array.from({ length: Math.floor(rand() * 4) + 1 }, (_, i) =>
        vehicle(
          `v${i}`,
          rand() < 0.2 ? null : Math.round(rand() * 3000) + 200,
          rand() < 0.2 ? null : Math.round(rand() * 30) + 2,
          rand() < 0.5 ? [4 + rand() * 4, 2 + rand(), 2 + rand()].sort((a, b) => b - a) as [number, number, number] : null,
        ),
      );
      const order = Array.from({ length: stops }, (_, i) => `s${i}`).sort(() => rand() - 0.5);
      const plan = load.planLoad({ lines, vehicles, stopOrder: order, fillFactor: 1 });
      assertWithinCapacity(plan);
      assertStopOrder(plan);
      const placed = plan.vehicles.reduce((s, v) => s + v.lines.length, 0);
      assert.equal(placed + plan.unassigned.length, lines.length, "every line is placed or reported");
      assert.deepEqual(
        plan.stops.map((s) => s.key),
        order.filter((k) => lines.some((l) => l.stopKey === k)),
      );
    }
  });
});

describe("shipmentLoad", () => {
  it("counts lines still to load or on board against the vehicle", () => {
    const m = (kg: number) => ({ pieces: 1, weightKg: kg, volumeM3: 1, weightSource: "item" as const, volumeSource: "item" as const, dimsM: null });
    const r = load.shipmentLoad(
      [
        { stage: "packed", measure: m(600) },
        { stage: "loaded", measure: m(600) },
        { stage: "delivered", measure: m(600) },
        { stage: "missing", measure: m(600) },
      ],
      { maxKg: 1000, maxM3: 10, nominalM3: 10, interiorM: null, fillFactor: 1 },
    );
    assert.equal(r.totals.weightKg, 1200);
    assert.equal(r.totals.lines, 2);
    assert.equal(r.over.weight, true);
    assert.equal(r.over.volume, false);
    assert.equal(r.utilization.weight, 1.2);
  });
});

describe("loadPlanPdf", () => {
  it("renders a multi-page plan, including characters the font lacks", async () => {
    const { loadPlanPdf } = await import("../src/services/ops-intel/loadPdf");
    const lines = Array.from({ length: 90 }, (_, i) =>
      lineOf({ kg: 10 + i, m3: 0.1, stopKey: `s${i % 3}`, stopLabel: `Room ${i % 3} 🚚`, name: `Carton ${i} 箱` }),
    );
    const plan = load.planLoad({
      lines: [...lines, lineOf({ kg: 99999, m3: 1 })],
      vehicles: [vehicle("t1", 5000, 20), vehicle("t2", null, null)],
      fillFactor: 0.85,
    });
    const pdf = await loadPlanPdf({ jobCode: "JOB-7F3K2A", jobName: "Floor 3 → Level 5", generatedAt: new Date().toISOString(), timeZone: "Europe/London", plan });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 3000);
  });
});
