/** Shapes the jobs API returns. Mirrors server/src/services/jobs-core. */

export type ProjectStatus = "planned" | "active" | "on_hold" | "completed" | "cancelled";
export type JobStatus = "planned" | "in_progress" | "completed" | "cancelled";
export type TaskStatus = "todo" | "doing" | "done" | "skipped";
export type ShipmentStatus = "planned" | "staged" | "loaded" | "in_transit" | "delivered" | "closed";
export type Step = "packed" | "loaded" | "delivered" | "placed";

export interface StageInfo {
  name: string;
  label: string;
  kind: "progress" | "exception";
  color: string;
}

export interface TaskKindInfo {
  kind: string;
  label: string;
  stage: string | null;
}

export interface JobsMeta {
  stages: StageInfo[];
  taskKinds: TaskKindInfo[];
  projectStatuses: ProjectStatus[];
  jobStatuses: JobStatus[];
  taskStatuses: TaskStatus[];
  shipmentStatuses: ShipmentStatus[];
}

export interface Progress {
  total: number;
  byStage: Record<string, number>;
  reached: Record<Step, number>;
  percent: Record<Step, number>;
  exceptions: number;
  overall: number;
  complete: boolean;
}

export interface LabelledGroup {
  key: string | null;
  label: string;
  code?: string | null;
  progress: Progress;
}

export interface JobProgressDetail {
  overall: Progress;
  byShipment: LabelledGroup[];
  byFloor: LabelledGroup[];
  byDepartment: LabelledGroup[];
}

export interface TemplateStep {
  kind: string;
  title: string;
}

export interface JobType {
  id: string;
  name: string;
  color: string;
  description: string | null;
  taskTemplate: TemplateStep[];
  settings: Record<string, unknown>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Phase {
  id: string;
  projectId: string;
  sequence: number;
  name: string;
  startsOn: string | null;
  endsOn: string | null;
  notes: string | null;
  jobCount: number;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  companyId: string | null;
  entityId: string | null;
  status: ProjectStatus;
  startsOn: string | null;
  endsOn: string | null;
  notes: string | null;
  companyName: string | null;
  entityName: string | null;
  jobCount?: number;
  phaseCount?: number;
  progress: Progress | null;
  createdAt: string;
}

export interface JobSummary {
  id: string;
  code: string;
  name: string;
  status: JobStatus;
  projectId: string | null;
  phaseId: string | null;
  jobTypeId: string | null;
  originLocationId: string | null;
  destinationLocationId: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string | null;
  completedAt: string | null;
  notes: string | null;
  jobTypeName: string | null;
  jobTypeColor: string | null;
  projectCode: string | null;
  projectName: string | null;
  phaseName: string | null;
  originName: string | null;
  destinationName: string | null;
  progress: Progress;
  createdAt: string;
}

export interface ProjectDetail extends Project {
  phases: Phase[];
  jobs: JobSummary[];
}

export interface Task {
  id: string;
  jobId: string;
  sequence: number;
  kind: string;
  title: string;
  status: TaskStatus;
  assigneeEntityId: string | null;
  assigneeEntityName: string | null;
  assigneeUserOid: string | null;
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  notes: string | null;
}

export interface Shipment {
  id: string;
  code: string;
  jobId: string;
  name: string;
  status: ShipmentStatus;
  vehicleLocationId: string | null;
  vehicleName: string | null;
  carrier: string | null;
  sealNumbers: string[];
  weightKg: number | null;
  volumeM3: number | null;
  distanceKm: number | null;
  eta: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  notes: string | null;
  progress: Progress;
}

export interface ShipmentHistoryEntry {
  id: string;
  fromStatus: ShipmentStatus | null;
  toStatus: ShipmentStatus;
  forced: boolean;
  reason: string | null;
  actor: string | null;
  createdAt: string;
}

export interface ShipmentDetail extends Shipment {
  jobCode: string;
  jobName: string;
  history: ShipmentHistoryEntry[];
}

export interface JobDetail extends Omit<JobSummary, "progress"> {
  tasks: Task[];
  shipments: Shipment[];
  progress: JobProgressDetail;
}

export interface ManifestLine {
  id: string;
  jobId: string;
  itemId: string;
  unitId: string | null;
  shipmentId: string | null;
  stage: string;
  stageAt: string;
  stageBy: string | null;
  originLocationId: string | null;
  destinationLocationId: string | null;
  destinationLabel: string | null;
  floor: string | null;
  department: string | null;
  crateNo: string | null;
  notes: string | null;
  itemName: string;
  itemBrand: string | null;
  itemModel: string | null;
  assetCode: string;
  unitCode: string | null;
  unitLabel: string | null;
  unitSerial: string | null;
  originName: string | null;
  destinationName: string | null;
  shipmentCode: string | null;
  shipmentName: string | null;
}

export interface ManifestPage {
  lines: ManifestLine[];
  total: number;
  floors: string[];
  departments: string[];
}

export interface LineFields {
  shipmentId?: string | null;
  destinationLocationId?: string | null;
  destinationLabel?: string | null;
  floor?: string | null;
  department?: string | null;
  crateNo?: string | null;
  notes?: string | null;
}

export interface LineOutcome {
  code: string | null;
  jobItemId: string;
  itemId: string;
  unitId: string | null;
  itemName: string;
  assetCode: string;
  unitCode: string | null;
  from: string;
  stage: string;
  shipmentId: string | null;
  shipmentCode: string | null;
  destinationLocationId: string | null;
  destinationName: string | null;
  destinationLabel: string | null;
  floor: string | null;
  department: string | null;
  crateNo: string | null;
}

export interface AdvanceResult {
  jobId: string;
  stage: string;
  shipmentId: string | null;
  advanced: LineOutcome[];
  alreadyAt: LineOutcome[];
  wrongShipment: LineOutcome[];
  notOnJob: {
    code: string;
    itemId: string;
    unitId: string | null;
    itemName: string;
    assetCode: string;
    otherJobs: { id: string; code: string; name: string }[];
  }[];
  unknown: string[];
  blocked: (LineOutcome & { reason: string })[];
}

export interface AddByCodesResult {
  added: number;
  alreadyOnJob: string[];
  unknown: string[];
  ambiguous: string[];
}

export interface CsvImportResult {
  added: number;
  updated: number;
  departments: { department: string; lines: number }[];
  unknownCodes: { line: number; code: string }[];
  ambiguousCodes: { line: number; code: string }[];
  notOnJob: { line: number; code: string }[];
  unmatchedDestinations: { line: number; value: string; reason: "unknown" | "ambiguous" }[];
  errors: { line: number; message: string }[];
}

export interface HistoryEntry {
  id: string;
  jobItemId: string;
  itemName: string;
  assetCode: string;
  unitCode: string | null;
  shipmentCode: string | null;
  fromStage: string | null;
  toStage: string;
  via: string;
  deviceId: string | null;
  actor: string | null;
  note: string | null;
  createdAt: string;
}

export type GroupBy = "floor" | "department" | "shipment" | "origin" | "none";
