/** Shapes served by /api/ops. Mirrors server/src/services/ops-intel. */

export type RuleId =
  | "packed_not_loaded"
  | "loaded_not_delivered"
  | "delivered_not_placed"
  | "duplicate_identifier"
  | "duplicate_record"
  | "impossible_travel"
  | "zone_mismatch"
  | "not_seen"
  | "multi_shipment";

export type Severity = "low" | "medium" | "high";
export type Resolution = "fixed" | "dismissed" | "cleared";
export type LocationRole = "dock" | "pick" | "storage" | "staging" | "vehicle";

export interface RuleInfo {
  rule: RuleId;
  title: string;
  group: "jobs" | "records" | "tracking";
  sticky: boolean;
  description: string;
  fix: string;
}

export interface CategoryDefault {
  weightKg?: number | null;
  volumeM3?: number | null;
}

export interface OpsSettings {
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
  jobLookbackDays: number;
  storage: { windowDays: number; longStoredDays: number; abcA: number; abcB: number };
  slotting: { minGainM: number; maxSuggestions: number };
  load: {
    defaultWeightKg: number;
    defaultVolumeM3: number;
    fillFactor: number;
    categoryDefaults: Record<string, CategoryDefault>;
  };
}

export interface OpsMeta {
  rules: RuleInfo[];
  severities: Severity[];
  roles: LocationRole[];
  explanations: { available: boolean };
  settings: OpsSettings;
}

export interface Anomaly {
  id: string;
  rule: RuleId;
  ruleTitle: string;
  key: string;
  severity: Severity;
  subjectType: string;
  subjectId: string;
  itemId: string | null;
  unitId: string | null;
  jobId: string | null;
  shipmentId: string | null;
  locationId: string | null;
  title: string;
  detail: Record<string, unknown>;
  link: string | null;
  sticky: boolean;
  occurrences: number;
  occurredAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolution: Resolution | null;
  resolutionNote: string | null;
  reopenedFrom: string | null;
  explanation: string | null;
}

export interface AnomalyDetail extends Anomaly {
  history: Anomaly[];
}

export interface AnomalyPage {
  anomalies: Anomaly[];
  total: number;
}

export interface OpsSummary {
  open: { total: number; bySeverity: Record<Severity, number>; byRule: Partial<Record<RuleId, number>> };
  oldestOpenAt: string | null;
  trend: { day: string; opened: number; resolved: number }[];
  lastRun: {
    id: string;
    trigger: string;
    startedAt: string;
    finishedAt: string | null;
    opened: number;
    cleared: number;
    error: string | null;
  } | null;
}

export interface RunResult {
  runId: string;
  opened: number;
  updated: number;
  cleared: number;
  byRule: Partial<Record<RuleId, { found: number; opened: number; cleared: number; ms: number; error?: string }>>;
}

export type AbcClass = "A" | "B" | "C";

export interface StorageItem {
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
  medianIntervalDays: number | null;
  predictedNextAt: string | null;
  abc: AbcClass;
  longStored: boolean;
}

export interface ZoneStat {
  locationId: string;
  path: string;
  distanceToDockM: number | null;
  occupancy: number;
  avgDwellDays: number;
  maxDwellDays: number;
  longStored: number;
  movesIn: number;
  movesOut: number;
  turnover: number;
  abc: Record<AbcClass, number>;
}

export interface StorageReport {
  generatedAt: string;
  windowDays: number;
  longStoredDays: number;
  totals: { assets: number; movements: number; longStored: number } & Record<AbcClass, number>;
  zones: ZoneStat[];
  longStored: StorageItem[];
  topMovers: StorageItem[];
}

export interface SlottingSuggestion {
  kind: "swap" | "move_closer";
  fast: StorageItem & { distanceToDockM: number };
  slow: (StorageItem & { distanceToDockM: number }) | null;
  gainM: number | null;
  savedMPerMonth: number | null;
  explanation: string;
}

export interface SlottingResult {
  cutoffM: number | null;
  considered: number;
  withoutDistance: number;
  suggestions: SlottingSuggestion[];
  rule: string;
}

export interface Profile {
  locationId: string;
  locationName: string;
  parentId: string | null;
  role: LocationRole | null;
  distanceToDockM: number | null;
  lat: number | null;
  lng: number | null;
  maxKg: number | null;
  maxM3: number | null;
  interiorLengthM: number | null;
  interiorWidthM: number | null;
  interiorHeightM: number | null;
  notes: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export type ProfileInput = Partial<Omit<Profile, "locationId" | "locationName" | "parentId" | "updatedAt" | "updatedBy">>;

export type MeasureSource = "item" | "dimensions" | "category" | "default";

export interface Measure {
  pieces: number;
  weightKg: number;
  volumeM3: number;
  weightSource: MeasureSource;
  volumeSource: MeasureSource;
  dimsM: [number, number, number] | null;
}

export interface Capacity {
  maxKg: number | null;
  maxM3: number | null;
  nominalM3: number | null;
  interiorM: [number, number, number] | null;
  fillFactor: number;
}

export interface PlannedLine {
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
  sequence: number;
  stopIndex: number;
  pinned: boolean;
}

export interface VehiclePlan {
  key: string;
  shipmentId: string | null;
  shipmentCode: string | null;
  name: string;
  vehicleLocationId: string | null;
  vehicleName: string | null;
  capacity: Capacity | null;
  usable: boolean;
  lines: PlannedLine[];
  totals: { weightKg: number; volumeM3: number; lines: number };
  utilization: { weight: number | null; volume: number | null };
  over: { weight: boolean; volume: boolean };
}

export interface LoadPlan {
  repack: boolean;
  fillFactor: number;
  stops: { key: string; label: string; index: number; lines: number }[];
  vehicles: VehiclePlan[];
  unassigned: { line: Omit<PlannedLine, "sequence" | "pinned">; reason: string }[];
  skipped: { done: number; elsewhere: number; exception: number };
  estimates: { weightDefault: number; volumeDefault: number; weightCategory: number; volumeCategory: number };
  warnings: string[];
}

export interface JobLoadPlan {
  job: { id: string; code: string; name: string; status: string };
  plan: LoadPlan;
  generatedAt: string;
}

export interface ShipmentCapacity {
  shipmentId: string;
  code: string;
  name: string;
  status: string;
  jobId: string;
  jobCode: string;
  vehicleLocationId: string | null;
  vehicleName: string | null;
  capacity: Capacity | null;
  declared: { weightKg: number | null; volumeM3: number | null };
  totals: { weightKg: number; volumeM3: number; lines: number };
  utilization: { weight: number | null; volume: number | null };
  over: { weight: boolean; volume: boolean };
}

export interface JobOption {
  id: string;
  code: string;
  name: string;
  status: string;
}
