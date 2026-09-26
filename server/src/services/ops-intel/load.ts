import type { CategoryDefault, OpsSettings } from "./model";
import { naturalCompare } from "./text";

/**
 * Load planning. Deliberately simple, and exactly this:
 *
 * 1. Every line gets a weight and a volume: from the record's own metadata
 *    (weightKg, volumeM3, or lengthCm × widthCm × heightCm), else its
 *    category's defaults, else the instance defaults. A whole-item line of a
 *    quantity-10 record counts ten pieces. Each figure says where it came from.
 * 2. Every vehicle gets a capacity: its maximum weight, and its volume (its
 *    stated cubic metres, else interior length × width × height) times the
 *    fill factor, because boxes never stack without gaps. A vehicle with
 *    neither is not planned onto.
 * 3. Lines already loaded stay on their shipment, and so do lines already
 *    assigned to one unless the plan is a repack. Everything else still to
 *    load is packed first-fit-decreasing: largest first (by its share of the
 *    biggest vehicle's weight or volume, whichever is larger), each into the
 *    first vehicle, in order, where its weight and volume still fit and its
 *    measured dimensions fit the interior in some orthogonal orientation.
 *    Nothing is ever added to a vehicle past its capacity; what does not fit
 *    is listed with the reason.
 * 4. Each vehicle's loading sequence follows the stops in reverse: the stop
 *    delivered last is loaded first, so the first stop's things come off the
 *    back first. Within a stop, heavier things go in first.
 *
 * It does not arrange boxes in three dimensions and makes no claim that a
 * plan within capacity will physically stack; it is a planning aid.
 */

export type MeasureSource = "item" | "dimensions" | "category" | "default";

export type Measure = {
  pieces: number;
  /** For the whole line: per piece × pieces. */
  weightKg: number;
  volumeM3: number;
  weightSource: MeasureSource;
  volumeSource: MeasureSource;
  /** One piece, metres, largest first. Only when all three were measured. */
  dimsM: [number, number, number] | null;
};

const positive = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const sortDesc = (xs: number[]) => [...xs].sort((a, b) => b - a) as [number, number, number];

export function categoryDefault(
  defaults: Record<string, CategoryDefault>,
  category: string | null | undefined,
): CategoryDefault | null {
  if (!category) return null;
  const want = category.trim().toLowerCase();
  for (const [name, value] of Object.entries(defaults)) {
    if (name.trim().toLowerCase() === want) return value;
  }
  return null;
}

export function measureLine(
  input: { metadata: Record<string, unknown> | null; category: string | null; quantity: number; wholeItem: boolean },
  load: OpsSettings["load"],
): Measure {
  const m = input.metadata ?? {};
  const pieces = input.wholeItem ? Math.max(1, Math.floor(Number(input.quantity) || 1)) : 1;
  const l = positive(m.lengthCm);
  const w = positive(m.widthCm);
  const h = positive(m.heightCm);
  const dimsM = l && w && h ? sortDesc([l / 100, w / 100, h / 100]) : null;
  const cat = categoryDefault(load.categoryDefaults, input.category);

  let weight = positive(m.weightKg);
  let weightSource: MeasureSource = "item";
  if (weight === null && cat?.weightKg) {
    weight = cat.weightKg;
    weightSource = "category";
  }
  if (weight === null) {
    weight = load.defaultWeightKg;
    weightSource = "default";
  }

  let volume = positive(m.volumeM3);
  let volumeSource: MeasureSource = "item";
  if (volume === null && dimsM) {
    volume = dimsM[0] * dimsM[1] * dimsM[2];
    volumeSource = "dimensions";
  }
  if (volume === null && cat?.volumeM3) {
    volume = cat.volumeM3;
    volumeSource = "category";
  }
  if (volume === null) {
    volume = load.defaultVolumeM3;
    volumeSource = "default";
  }
  return { pieces, weightKg: weight * pieces, volumeM3: volume * pieces, weightSource, volumeSource, dimsM };
}

export type VehicleProfile = {
  maxKg: number | null;
  maxM3: number | null;
  interiorLengthM: number | null;
  interiorWidthM: number | null;
  interiorHeightM: number | null;
};

export type Capacity = {
  maxKg: number | null;
  /** Usable volume: nominal × fill factor. */
  maxM3: number | null;
  nominalM3: number | null;
  /** Interior, metres, largest first. */
  interiorM: [number, number, number] | null;
  fillFactor: number;
};

/** What a vehicle can take, or null when nothing about it is known. */
export function capacityOf(p: VehicleProfile | null | undefined, fillFactor: number): Capacity | null {
  if (!p) return null;
  const { interiorLengthM: l, interiorWidthM: w, interiorHeightM: h } = p;
  const interiorM = l && w && h ? sortDesc([l, w, h]) : null;
  const nominalM3 = p.maxM3 ?? (interiorM ? interiorM[0] * interiorM[1] * interiorM[2] : null);
  const maxM3 = nominalM3 === null ? null : nominalM3 * fillFactor;
  const maxKg = p.maxKg ?? null;
  if (maxKg === null && maxM3 === null) return null;
  return { maxKg, maxM3, nominalM3, interiorM, fillFactor };
}

const EPS = 1e-9;

/** Whether one piece fits the interior, turned whichever way; unknown sizes are given the benefit. */
export function fitsInterior(dims: Measure["dimsM"], interior: Capacity["interiorM"]): boolean {
  if (!dims || !interior) return true;
  return dims.every((d, i) => d <= interior[i]! + EPS);
}

export type PlanLineInput = {
  jobItemId: string;
  itemId: string;
  unitId: string | null;
  name: string;
  code: string | null;
  stage: string;
  shipmentId: string | null;
  stopKey: string;
  stopLabel: string;
  measure: Measure;
};

export type PlanVehicleInput = {
  /** The shipment id, or "loc:<id>" for a vehicle planned without a shipment. */
  key: string;
  shipmentId: string | null;
  shipmentCode: string | null;
  name: string;
  vehicleLocationId: string | null;
  vehicleName: string | null;
  capacity: Capacity | null;
};

export type PlannedLine = PlanLineInput & { sequence: number; stopIndex: number; pinned: boolean };

export type VehiclePlan = PlanVehicleInput & {
  usable: boolean;
  lines: PlannedLine[];
  totals: { weightKg: number; volumeM3: number; lines: number };
  /** Load over capacity, 0 to 1 (more only when lines already on it overfill it). */
  utilization: { weight: number | null; volume: number | null };
  over: { weight: boolean; volume: boolean };
};

export type Unassigned = { line: PlanLineInput & { stopIndex: number }; reason: string };

export type Stop = { key: string; label: string; index: number; lines: number };

export type LoadPlan = {
  repack: boolean;
  fillFactor: number;
  stops: Stop[];
  vehicles: VehiclePlan[];
  unassigned: Unassigned[];
  /** Lines left out: already delivered or placed, loaded on a vehicle not in the plan, or in an exception stage. */
  skipped: { done: number; elsewhere: number; exception: number };
  estimates: { weightDefault: number; volumeDefault: number; weightCategory: number; volumeCategory: number };
  warnings: string[];
};

const TO_LOAD = new Set(["pending", "packed"]);

/** The stop key of a line with no destination; see loadData.ts. */
export const NO_STOP = "none";
const DONE = new Set(["delivered", "placed"]);

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

export function planLoad(input: {
  lines: PlanLineInput[];
  vehicles: PlanVehicleInput[];
  /** Stop keys in delivery order. Stops not listed follow, in name order. */
  stopOrder?: string[];
  repack?: boolean;
  fillFactor: number;
}): LoadPlan {
  const repack = input.repack ?? false;
  const byShipment = new Map(input.vehicles.filter((v) => v.shipmentId).map((v) => [v.shipmentId!, v]));
  const skipped = { done: 0, elsewhere: 0, exception: 0 };

  const pinned = new Map<string, PlanLineInput[]>();
  const toPack: PlanLineInput[] = [];
  for (const line of input.lines) {
    const vehicle = line.shipmentId ? byShipment.get(line.shipmentId) : undefined;
    if (line.stage === "loaded") {
      if (vehicle) pinned.set(vehicle.key, [...(pinned.get(vehicle.key) ?? []), line]);
      else skipped.elsewhere += 1;
    } else if (TO_LOAD.has(line.stage)) {
      if (vehicle && !repack) pinned.set(vehicle.key, [...(pinned.get(vehicle.key) ?? []), line]);
      else toPack.push(line);
    } else if (DONE.has(line.stage)) skipped.done += 1;
    else skipped.exception += 1;
  }

  // Stops, in delivery order.
  const planned = [...[...pinned.values()].flat(), ...toPack];
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const l of planned) {
    labels.set(l.stopKey, l.stopLabel);
    counts.set(l.stopKey, (counts.get(l.stopKey) ?? 0) + 1);
  }
  const listed = (input.stopOrder ?? []).filter((k, i, all) => labels.has(k) && all.indexOf(k) === i);
  // Lines with no destination at all are a stop of their own, delivered last
  // unless someone says otherwise.
  const rest = [...labels.keys()]
    .filter((k) => !listed.includes(k))
    .sort(
      (a, b) =>
        Number(a === NO_STOP) - Number(b === NO_STOP) ||
        naturalCompare(labels.get(a)!, labels.get(b)!) ||
        a.localeCompare(b),
    );
  const stops: Stop[] = [...listed, ...rest].map((key, index) => ({
    key,
    label: labels.get(key)!,
    index,
    lines: counts.get(key) ?? 0,
  }));
  const stopIndex = new Map(stops.map((s) => [s.key, s.index]));

  // First-fit decreasing.
  const usable = input.vehicles.filter((v) => v.capacity);
  const load = new Map(input.vehicles.map((v) => [v.key, { kg: 0, m3: 0 }]));
  for (const [key, lines] of pinned) {
    const l = load.get(key)!;
    for (const line of lines) {
      l.kg += line.measure.weightKg;
      l.m3 += line.measure.volumeM3;
    }
  }
  const capKg = Math.max(0, ...usable.map((v) => v.capacity!.maxKg ?? 0));
  const capM3 = Math.max(0, ...usable.map((v) => v.capacity!.maxM3 ?? 0));
  const size = (l: PlanLineInput) =>
    Math.max(capKg ? l.measure.weightKg / capKg : 0, capM3 ? l.measure.volumeM3 / capM3 : 0);
  const order = [...toPack].sort(
    (a, b) =>
      size(b) - size(a) ||
      b.measure.volumeM3 - a.measure.volumeM3 ||
      b.measure.weightKg - a.measure.weightKg ||
      (a.code ?? "").localeCompare(b.code ?? "") ||
      a.jobItemId.localeCompare(b.jobItemId),
  );

  const assigned = new Map<string, PlanLineInput[]>();
  const unassigned: Unassigned[] = [];
  for (const line of order) {
    const target = usable.find((v) => {
      const cap = v.capacity!;
      const l = load.get(v.key)!;
      if (cap.maxKg !== null && l.kg + line.measure.weightKg > cap.maxKg + EPS) return false;
      if (cap.maxM3 !== null && l.m3 + line.measure.volumeM3 > cap.maxM3 + EPS) return false;
      return fitsInterior(line.measure.dimsM, cap.interiorM);
    });
    if (target) {
      const l = load.get(target.key)!;
      l.kg += line.measure.weightKg;
      l.m3 += line.measure.volumeM3;
      assigned.set(target.key, [...(assigned.get(target.key) ?? []), line]);
    } else {
      unassigned.push({ line: { ...line, stopIndex: stopIndex.get(line.stopKey) ?? 0 }, reason: whyNot(line, usable) });
    }
  }

  const vehicles: VehiclePlan[] = input.vehicles.map((v) => {
    const lines = [
      ...(pinned.get(v.key) ?? []).map((l) => ({ l, pinned: true })),
      ...(assigned.get(v.key) ?? []).map((l) => ({ l, pinned: false })),
    ]
      .map(({ l, pinned: p }) => ({ ...l, stopIndex: stopIndex.get(l.stopKey) ?? 0, pinned: p, sequence: 0 }))
      // Last stop first into the vehicle; heavy things first within a stop.
      .sort(
        (a, b) =>
          b.stopIndex - a.stopIndex ||
          b.measure.weightKg - a.measure.weightKg ||
          b.measure.volumeM3 - a.measure.volumeM3 ||
          (a.code ?? "").localeCompare(b.code ?? "") ||
          a.jobItemId.localeCompare(b.jobItemId),
      )
      .map((l, i) => ({ ...l, sequence: i + 1 }));
    const l = load.get(v.key)!;
    const cap = v.capacity;
    return {
      ...v,
      usable: !!cap,
      lines,
      totals: { weightKg: round(l.kg), volumeM3: round(l.m3, 4), lines: lines.length },
      utilization: {
        weight: cap?.maxKg ? round(l.kg / cap.maxKg) : null,
        volume: cap?.maxM3 ? round(l.m3 / cap.maxM3) : null,
      },
      over: {
        weight: !!cap && cap.maxKg !== null && l.kg > cap.maxKg + EPS,
        volume: !!cap && cap.maxM3 !== null && l.m3 > cap.maxM3 + EPS,
      },
    };
  });

  const counted = planned;
  const estimates = {
    weightDefault: counted.filter((l) => l.measure.weightSource === "default").length,
    volumeDefault: counted.filter((l) => l.measure.volumeSource === "default").length,
    weightCategory: counted.filter((l) => l.measure.weightSource === "category").length,
    volumeCategory: counted.filter((l) => l.measure.volumeSource === "category").length,
  };

  const warnings: string[] = [];
  if (!input.vehicles.length) warnings.push("There is no vehicle to plan onto: add a shipment with a vehicle, or pick one.");
  for (const v of vehicles) {
    const name = v.shipmentCode ? `${v.shipmentCode} (${v.name})` : v.name;
    if (!v.usable) warnings.push(`${name} has no capacity set, so nothing was planned onto it. Set one under Setup.`);
    if (v.over.weight || v.over.volume) {
      warnings.push(`${name} is already over its ${v.over.weight ? "weight" : "volume"} capacity with the lines on it.`);
    }
  }
  if (estimates.weightDefault || estimates.volumeDefault) {
    warnings.push(
      `${Math.max(estimates.weightDefault, estimates.volumeDefault)} of ${counted.length} lines use the default size or weight; record weights and dimensions for a closer plan.`,
    );
  }
  for (const key of input.stopOrder ?? []) {
    if (!labels.has(key)) warnings.push(`Stop ${key} has nothing to load and was ignored.`);
  }

  return { repack, fillFactor: input.fillFactor, stops, vehicles, unassigned, skipped, estimates, warnings };
}

function whyNot(line: PlanLineInput, usable: PlanVehicleInput[]): string {
  if (!usable.length) return "No vehicle with a capacity to plan against.";
  const empty = (test: (cap: Capacity) => boolean) => usable.every((v) => test(v.capacity!));
  if (empty((c) => c.maxKg !== null && line.measure.weightKg > c.maxKg + EPS)) return "Heavier than any vehicle can carry.";
  if (empty((c) => c.maxM3 !== null && line.measure.volumeM3 > c.maxM3 + EPS)) return "Bigger than any vehicle holds.";
  if (empty((c) => !fitsInterior(line.measure.dimsM, c.interiorM))) return "Does not fit inside any vehicle's interior.";
  return "No room left on any vehicle.";
}

/** Load on a shipment as it stands: every line on it that is still to load or on board. */
export function shipmentLoad(
  lines: { stage: string; measure: Measure }[],
  capacity: Capacity | null,
): {
  totals: { weightKg: number; volumeM3: number; lines: number };
  utilization: { weight: number | null; volume: number | null };
  over: { weight: boolean; volume: boolean };
} {
  const counted = lines.filter((l) => TO_LOAD.has(l.stage) || l.stage === "loaded");
  const kg = counted.reduce((s, l) => s + l.measure.weightKg, 0);
  const m3 = counted.reduce((s, l) => s + l.measure.volumeM3, 0);
  return {
    totals: { weightKg: round(kg), volumeM3: round(m3, 4), lines: counted.length },
    utilization: {
      weight: capacity?.maxKg ? round(kg / capacity.maxKg) : null,
      volume: capacity?.maxM3 ? round(m3 / capacity.maxM3) : null,
    },
    over: {
      weight: !!capacity && capacity.maxKg !== null && kg > capacity.maxKg + EPS,
      volume: !!capacity && capacity.maxM3 !== null && m3 > capacity.maxM3 + EPS,
    },
  };
}
