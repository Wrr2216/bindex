/** Shapes the /api/placement endpoints return. Mirrors server/src/services/placement. */

export type Place = { id: string; name: string; path: string[] };

export type Tally = {
  total: number;
  placed: number;
  remaining: number;
  exceptions: Record<string, number>;
  percent: number;
};

export type PlacementLine = {
  id: string;
  jobId: string;
  itemId: string;
  unitId: string | null;
  stage: string;
  stageAt: string;
  shipmentId: string | null;
  shipmentCode: string | null;
  shipmentName: string | null;
  shipmentStatus: string | null;
  destinationLocationId: string | null;
  lastActualId: string | null;
  itemName: string;
  assetCode: string;
  unitCode: string | null;
  unitLabel: string | null;
  origin: Place | null;
  destination: Place | null;
  destinationLabel: string | null;
  floor: string | null;
  planFloor: string | null;
  floorColor: string;
  department: string | null;
  crateNo: string | null;
  notes: string | null;
  lastActual: (Place & { at: string }) | null;
};

export type PlacementJobSummary = {
  id: string;
  code: string;
  name: string;
  status: string;
  destination: Place | null;
  tally: Tally;
};

export type AfterDeliveryReason = "not_unloaded" | "flagged_missing" | "not_placed";

export type JobProgress = {
  job: { id: string; code: string; name: string; status: string; origin: Place | null; destination: Place | null };
  overall: Tally;
  byFloor: { floor: string | null; color: string; tally: Tally }[];
  byRoom: { destination: Place | null; floor: string | null; color: string; tally: Tally }[];
  remaining: PlacementLine[];
  misplaced: PlacementLine[];
  afterDelivery: (PlacementLine & { reason: AfterDeliveryReason })[];
  shipments: { id: string; code: string; name: string; status: string }[];
  floors: { floor: string; color: string; custom: boolean }[];
  truncated: boolean;
};

export type OtherJob = {
  id: string;
  code: string;
  name: string;
  destination: Place | null;
  floor: string | null;
  floorColor: string;
};

export type ItemRef = { id: string; name: string; assetCode: string; unitId: string | null; unitCode: string | null };

export type CardOutcome = "ok" | "no_destination" | "already_placed" | "wrong_shipment" | "not_on_job" | "unknown";

export type Card = {
  outcome: CardOutcome;
  code: string;
  item: ItemRef | null;
  line: PlacementLine | null;
  otherJobs: OtherJob[];
  shipment: { id: string; code: string; name: string } | null;
  recorded: boolean;
  handlingNotes: string[];
};

export type PlaceResult = {
  placed: PlacementLine[];
  already: string[];
  blocked: { jobItemId: string; reason: string }[];
};

export type RoomStatus = {
  room: Place & { floor: string | null; floorColor: string };
  nested: boolean;
  belongs: { total: number; placed: number };
  remaining: PlacementLine[];
  extras: PlacementLine[];
  extrasByDestination: { destination: Place | null; floor: string | null; floorColor: string; count: number }[];
  nearby: number;
};

export type SweepOutcome =
  | "placed"
  | "already"
  | "misplaced"
  | "nearby"
  | "no_destination"
  | "held"
  | "not_on_job"
  | "unknown"
  | "blocked";

export type SweepEntry = {
  code: string;
  outcome: SweepOutcome;
  line: PlacementLine | null;
  item: ItemRef | null;
  otherJobs: OtherJob[];
  reason: string | null;
};

export type SweepResult = {
  entries: SweepEntry[];
  counts: Partial<Record<SweepOutcome, number>>;
  status: RoomStatus;
};

export type ProposalReason = "room_map" | "same_path" | "same_name" | "department";

export type Proposals = {
  originRoot: Place | null;
  destinationRoot: Place | null;
  proposals: { line: PlacementLine; destination: Place; reason: ProposalReason; floor: string | null; replaces: Place | null }[];
  unmatched: { line: PlacementLine; reason: "no_origin" | "no_match" | "ambiguous"; candidates: Place[] }[];
  unmatchedOrigins: { origin: Place; lines: number }[];
  skipped: number;
};

export type RoomMapRow = { id: string; origin: Place; destination: Place };

export type KioskOutcome = "this_way" | "elsewhere" | "no_destination" | "placed" | "not_on_job" | "info";

export type KioskEntry = {
  id: number;
  at: string;
  direction: "in" | "out" | null;
  deviceName: string | null;
  code: string | null;
  outcome: KioskOutcome;
  itemId: string;
  itemName: string;
  unitId: string | null;
  line: PlacementLine | null;
  otherJobs: OtherJob[];
  handlingNotes: string[];
};

export type KioskPage = { cursor: number; zone: Place | null; entries: KioskEntry[]; unknown: number };

export type Observation = {
  id: number;
  at: string;
  outcome: "placed" | "misplaced" | "wrong_shipment" | "wrong_job";
  jobItemId: string | null;
  itemId: string;
  unitId: string | null;
  itemName: string;
  assetCode: string;
  unitCode: string | null;
  code: string | null;
  expected: Place | null;
  actual: Place | null;
  shipmentCode: string | null;
  otherJob: { id: string; code: string } | null;
  deviceId: string | null;
  deviceName: string | null;
  via: string;
  actor: string | null;
  note: string | null;
};

export type PlacementReader = {
  id: string;
  name: string;
  kind: string;
  zone: Place | null;
  antennaZones: number;
  confirm: boolean;
  nested: boolean;
  disabled: boolean;
  lastSeenAt: string | null;
};

export type ReadersStatus = {
  worker: {
    on: boolean;
    pollSeconds: number;
    lastRun: { reads: number; placed: number; misplaced: number; cursor: number; at: string } | null;
  };
  ble: boolean;
  readers: PlacementReader[];
};
