/**
 * The vocabulary of operations insights: which rules exist, what each one
 * looks for, and the thresholds an administrator can tune. Pure, so the rules,
 * the tests and the screens all read the same definitions.
 */

export const RULE_IDS = [
  "packed_not_loaded",
  "loaded_not_delivered",
  "delivered_not_placed",
  "duplicate_identifier",
  "duplicate_record",
  "impossible_travel",
  "zone_mismatch",
  "not_seen",
  "multi_shipment",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export const isRuleId = (v: string): v is RuleId => (RULE_IDS as readonly string[]).includes(v);

export type Severity = "low" | "medium" | "high";
export const SEVERITIES: readonly Severity[] = ["low", "medium", "high"];
export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

export type RuleGroup = "jobs" | "records" | "tracking";

export type RuleInfo = {
  rule: RuleId;
  title: string;
  group: RuleGroup;
  /** Sticky rules report an event and stay open until a person resolves them. */
  sticky: boolean;
  /** One plain sentence: what it catches and when. */
  description: string;
  /** Where the fix is made. */
  fix: string;
};

export const RULES: Record<RuleId, RuleInfo> = {
  packed_not_loaded: {
    rule: "packed_not_loaded",
    title: "Packed, never loaded",
    group: "jobs",
    sticky: false,
    description:
      "A manifest line is still packed after its shipment was loaded or left, or, for a line on no shipment, after every shipment on the job left.",
    fix: "Find it and scan it onto a shipment, or mark the line missing, on the job's manifest.",
  },
  loaded_not_delivered: {
    rule: "loaded_not_delivered",
    title: "Loaded, not delivered",
    group: "jobs",
    sticky: false,
    description:
      "A line is still loaded some time after its shipment was marked delivered: it was not scanned off the truck.",
    fix: "Check the vehicle, then scan the line as delivered or mark it missing.",
  },
  delivered_not_placed: {
    rule: "delivered_not_placed",
    title: "Delivered, not placed",
    group: "jobs",
    sticky: false,
    description:
      "A line has sat at delivered for too long on a job that places things (it has a place task, or other lines already placed).",
    fix: "Place it and scan it as placed, or record why it stays where it is.",
  },
  duplicate_identifier: {
    rule: "duplicate_identifier",
    title: "Duplicate identifier",
    group: "records",
    sticky: false,
    description:
      "The same serial, asset tag, MAC or RFID tag is on two records, either exactly or differing only by spaces, dashes, colons or case.",
    fix: "Merge the records, or correct the identifier on the one that is wrong.",
  },
  duplicate_record: {
    rule: "duplicate_record",
    title: "Duplicate record",
    group: "records",
    sticky: false,
    description:
      "A small group of records in the same place with the same name and model and no serials that tell them apart: likely entered twice.",
    fix: "Delete the extra record, or add serials so the two can be told apart.",
  },
  impossible_travel: {
    rule: "impossible_travel",
    title: "Impossible travel",
    group: "tracking",
    sticky: true,
    description:
      "A tag was read in two places further apart than it could have travelled in the time between the reads: a cloned or mis-assigned tag, or a reader in the wrong zone.",
    fix: "Check the tag on the asset and the zones of the two devices.",
  },
  zone_mismatch: {
    rule: "zone_mismatch",
    title: "Seen somewhere else",
    group: "tracking",
    sticky: false,
    description:
      "An asset has been read in one zone for hours while its record says it is somewhere else, and nobody has changed the record since.",
    fix: "Move it on file, or take it back where it belongs.",
  },
  not_seen: {
    rule: "not_seen",
    title: "Not seen lately",
    group: "tracking",
    sticky: false,
    description:
      "A tagged, active asset that is not checked out has not been read by any device for days.",
    fix: "Look for it where it was last seen; mark it missing or retire it if it is gone.",
  },
  multi_shipment: {
    rule: "multi_shipment",
    title: "On two shipments",
    group: "jobs",
    sticky: false,
    description: "The same asset is on lines on two open shipments, which cannot both carry it.",
    fix: "Take it off the shipment that is not carrying it.",
  },
};

export const ruleList = (): RuleInfo[] => RULE_IDS.map((r) => RULES[r]);

// --- Settings ------------------------------------------------------------------

export type CategoryDefault = { weightKg?: number | null; volumeM3?: number | null };

export type OpsSettings = {
  rules: {
    packed_not_loaded: { enabled: boolean };
    loaded_not_delivered: { enabled: boolean; graceMinutes: number };
    delivered_not_placed: { enabled: boolean; hours: number };
    duplicate_identifier: { enabled: boolean };
    duplicate_record: { enabled: boolean; maxGroup: number };
    impossible_travel: { enabled: boolean; maxSpeedKmh: number; minDistanceM: number; lookbackHours: number };
    zone_mismatch: { enabled: boolean; hours: number };
    not_seen: { enabled: boolean; days: number };
    multi_shipment: { enabled: boolean };
  };
  /** Completed jobs are still checked for this many days after they finish. */
  jobLookbackDays: number;
  storage: {
    /** Movements are counted over this many days. */
    windowDays: number;
    /** Stored longer than this is "long stored". */
    longStoredDays: number;
    /** Share of all movements the A class accounts for (0.8 = the top 80%). */
    abcA: number;
    /** Cumulative share that ends the B class. */
    abcB: number;
  };
  slotting: {
    /** A swap has to bring the fast mover at least this much closer to the dock. */
    minGainM: number;
    maxSuggestions: number;
  };
  load: {
    /** Used when nothing else says how heavy or big something is. */
    defaultWeightKg: number;
    defaultVolumeM3: number;
    /** Share of a vehicle's volume treated as usable; boxes never stack without gaps. */
    fillFactor: number;
    /** Per category (matched case-insensitively). */
    categoryDefaults: Record<string, CategoryDefault>;
  };
};

export function defaultSettings(): OpsSettings {
  return {
    rules: {
      packed_not_loaded: { enabled: true },
      loaded_not_delivered: { enabled: true, graceMinutes: 120 },
      delivered_not_placed: { enabled: true, hours: 24 },
      duplicate_identifier: { enabled: true },
      duplicate_record: { enabled: true, maxGroup: 3 },
      impossible_travel: { enabled: true, maxSpeedKmh: 120, minDistanceM: 1000, lookbackHours: 24 },
      zone_mismatch: { enabled: true, hours: 4 },
      not_seen: { enabled: true, days: 14 },
      multi_shipment: { enabled: true },
    },
    jobLookbackDays: 30,
    storage: { windowDays: 90, longStoredDays: 180, abcA: 0.8, abcB: 0.95 },
    slotting: { minGainM: 5, maxSuggestions: 50 },
    load: { defaultWeightKg: 10, defaultVolumeM3: 0.05, fillFactor: 0.85, categoryDefaults: {} },
  };
}

/** Numeric bounds for every threshold; stored values outside them are clamped. */
export const LIMITS = {
  graceMinutes: [0, 7 * 24 * 60],
  hours: [1, 24 * 90],
  days: [1, 3650],
  maxGroup: [2, 50],
  maxSpeedKmh: [1, 2000],
  minDistanceM: [0, 1_000_000],
  lookbackHours: [1, 24 * 14],
  jobLookbackDays: [0, 3650],
  windowDays: [7, 730],
  longStoredDays: [1, 3650],
  share: [0.05, 0.99],
  minGainM: [0, 100_000],
  maxSuggestions: [1, 500],
  weightKg: [0.001, 100_000],
  volumeM3: [0.00001, 1000],
  fillFactor: [0.1, 1],
} as const satisfies Record<string, readonly [number, number]>;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};
const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Lay stored (or submitted) values over a base, keeping only known keys and
 * clamping every number into range. Used both to read what is stored, which
 * may predate a new threshold, and to apply a partial update.
 */
export function mergeSettings(base: OpsSettings, patch: unknown): OpsSettings {
  const p = obj(patch);
  const r = obj(p.rules);
  const rule = (id: RuleId) => obj(r[id]);
  const b = base.rules;
  const L = LIMITS;

  const rules: OpsSettings["rules"] = {
    packed_not_loaded: { enabled: flag(rule("packed_not_loaded").enabled, b.packed_not_loaded.enabled) },
    loaded_not_delivered: {
      enabled: flag(rule("loaded_not_delivered").enabled, b.loaded_not_delivered.enabled),
      graceMinutes: clamp(rule("loaded_not_delivered").graceMinutes, L.graceMinutes, b.loaded_not_delivered.graceMinutes),
    },
    delivered_not_placed: {
      enabled: flag(rule("delivered_not_placed").enabled, b.delivered_not_placed.enabled),
      hours: clamp(rule("delivered_not_placed").hours, L.hours, b.delivered_not_placed.hours),
    },
    duplicate_identifier: { enabled: flag(rule("duplicate_identifier").enabled, b.duplicate_identifier.enabled) },
    duplicate_record: {
      enabled: flag(rule("duplicate_record").enabled, b.duplicate_record.enabled),
      maxGroup: Math.round(clamp(rule("duplicate_record").maxGroup, L.maxGroup, b.duplicate_record.maxGroup)),
    },
    impossible_travel: {
      enabled: flag(rule("impossible_travel").enabled, b.impossible_travel.enabled),
      maxSpeedKmh: clamp(rule("impossible_travel").maxSpeedKmh, L.maxSpeedKmh, b.impossible_travel.maxSpeedKmh),
      minDistanceM: clamp(rule("impossible_travel").minDistanceM, L.minDistanceM, b.impossible_travel.minDistanceM),
      lookbackHours: clamp(rule("impossible_travel").lookbackHours, L.lookbackHours, b.impossible_travel.lookbackHours),
    },
    zone_mismatch: {
      enabled: flag(rule("zone_mismatch").enabled, b.zone_mismatch.enabled),
      hours: clamp(rule("zone_mismatch").hours, L.hours, b.zone_mismatch.hours),
    },
    not_seen: {
      enabled: flag(rule("not_seen").enabled, b.not_seen.enabled),
      days: clamp(rule("not_seen").days, L.days, b.not_seen.days),
    },
    multi_shipment: { enabled: flag(rule("multi_shipment").enabled, b.multi_shipment.enabled) },
  };

  const s = obj(p.storage);
  const abcA = clamp(s.abcA, L.share, base.storage.abcA);
  // B has to end after A does, or the B class would be empty by construction.
  const abcB = Math.max(clamp(s.abcB, L.share, base.storage.abcB), Math.min(0.99, abcA + 0.01));
  const sl = obj(p.slotting);
  const l = obj(p.load);

  let categoryDefaults = base.load.categoryDefaults;
  if (l.categoryDefaults !== undefined) {
    categoryDefaults = {};
    for (const [name, raw] of Object.entries(obj(l.categoryDefaults))) {
      const key = name.trim();
      if (!key) continue;
      const v = obj(raw);
      const weightKg = v.weightKg == null ? null : clamp(v.weightKg, L.weightKg, NaN);
      const volumeM3 = v.volumeM3 == null ? null : clamp(v.volumeM3, L.volumeM3, NaN);
      const entry: CategoryDefault = {};
      if (weightKg != null && Number.isFinite(weightKg)) entry.weightKg = weightKg;
      if (volumeM3 != null && Number.isFinite(volumeM3)) entry.volumeM3 = volumeM3;
      if (entry.weightKg != null || entry.volumeM3 != null) categoryDefaults[key] = entry;
    }
  }

  return {
    rules,
    jobLookbackDays: Math.round(clamp(p.jobLookbackDays, L.jobLookbackDays, base.jobLookbackDays)),
    storage: {
      windowDays: Math.round(clamp(s.windowDays, L.windowDays, base.storage.windowDays)),
      longStoredDays: Math.round(clamp(s.longStoredDays, L.longStoredDays, base.storage.longStoredDays)),
      abcA,
      abcB,
    },
    slotting: {
      minGainM: clamp(sl.minGainM, L.minGainM, base.slotting.minGainM),
      maxSuggestions: Math.round(clamp(sl.maxSuggestions, L.maxSuggestions, base.slotting.maxSuggestions)),
    },
    load: {
      defaultWeightKg: clamp(l.defaultWeightKg, L.weightKg, base.load.defaultWeightKg),
      defaultVolumeM3: clamp(l.defaultVolumeM3, L.volumeM3, base.load.defaultVolumeM3),
      fillFactor: clamp(l.fillFactor, L.fillFactor, base.load.fillFactor),
      categoryDefaults,
    },
  };
}

export const enabledRules = (settings: OpsSettings): RuleId[] =>
  RULE_IDS.filter((id) => settings.rules[id].enabled);
