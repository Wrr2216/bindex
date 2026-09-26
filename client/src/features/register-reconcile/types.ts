export type RegisterPreset = "generic" | "snipeit" | "homebox" | "erp";

export type RegisterField =
  | "assetTag"
  | "serial"
  | "epc"
  | "bindexCode"
  | "name"
  | "model"
  | "brand"
  | "category"
  | "description"
  | "locationText"
  | "custodian"
  | "cost"
  | "purchaseDate"
  | "quantity";

export type ColumnMapping = Partial<Record<RegisterField, string>>;

export type ReconcileClass =
  | "matched"
  | "misplaced"
  | "conflict"
  | "register_only"
  | "bindex_only"
  | "duplicate"
  | "flagged_missing";

export const CLASS_ORDER: ReconcileClass[] = [
  "matched",
  "misplaced",
  "conflict",
  "register_only",
  "bindex_only",
  "duplicate",
  "flagged_missing",
];

export interface FieldInfo {
  key: RegisterField;
  label: string;
  hint: string;
}

export interface PresetInfo {
  key: RegisterPreset;
  label: string;
  description: string;
}

export interface RegisterRow {
  id: string;
  rowNumber: number;
  raw: Record<string, string>;
  assetTag: string | null;
  serial: string | null;
  epc: string | null;
  bindexCode: string | null;
  name: string | null;
  model: string | null;
  brand: string | null;
  category: string | null;
  description: string | null;
  locationText: string | null;
  custodian: string | null;
  costCents: number | null;
  purchaseDate: string | null;
  quantity: number | null;
  issues: string[];
  createdItemId: string | null;
}

export interface RunSummary {
  id: string;
  importId: string;
  importName?: string;
  scopeLabel: string | null;
  counts: Record<string, number>;
  durationMs: number | null;
  createdBy: string | null;
  createdAt: string;
}

export interface RegisterImportSummary {
  id: string;
  name: string;
  sourcePreset: RegisterPreset;
  fileName: string | null;
  fileFormat: "csv" | "xlsx";
  rowCount: number;
  createdBy: string | null;
  createdAt: string;
  runCount: number;
  lastRunAt: string | null;
}

export interface RegisterImport extends Omit<RegisterImportSummary, "runCount" | "lastRunAt"> {
  updatedAt: string;
  headers: string[];
  columnMapping: ColumnMapping;
  coverage: Record<RegisterField, number>;
  rowsWithIssues: number;
  createdItems: number;
  sample: RegisterRow[];
  runs: RunSummary[];
  sameFileAs: { id: string; name: string } | null;
}

export interface LocationResolution {
  text: string;
  rows: number;
  locationId: string | null;
  via: "path" | "name" | "mapping" | null;
  ambiguous: boolean;
  path: string | null;
}

export interface ClassStatus {
  total: number;
  open: number;
  resolved: number;
  ignored: number;
}

export interface RunDetail extends RunSummary {
  importName: string;
  importRowCount: number;
  status: Record<ReconcileClass, ClassStatus>;
  previousRunId: string | null;
}

export interface ResultConflict {
  field: string;
  register: string | null;
  bindex: string | null;
}

export interface ReconcileResult {
  id: string;
  classes: ReconcileClass[];
  matchMethod: "asset_tag" | "serial" | "epc" | "asset_code" | null;
  conflicts: ResultConflict[];
  notes: string[];
  resolution: "resolved" | "ignored" | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  row: {
    id: string;
    rowNumber: number;
    assetTag: string | null;
    serial: string | null;
    epc: string | null;
    bindexCode: string | null;
    name: string | null;
    model: string | null;
    brand: string | null;
    locationText: string | null;
    custodian: string | null;
    costCents: number | null;
    purchaseDate: string | null;
    createdItemId: string | null;
  } | null;
  registerLocation: { id: string; path: string | null } | null;
  asset: {
    itemId: string;
    unitId: string | null;
    name: string | null;
    assetCode: string | null;
    unitLabel: string | null;
    model: string | null;
    flaggedMissing: boolean | null;
    exists: boolean;
    locationAtRun: { id: string; path: string | null } | null;
    location: { id: string; path: string | null } | null;
  } | null;
  proposal: { itemId: string; score: number; name: string | null; assetCode: string | null } | null;
}

export interface ResultPage {
  results: ReconcileResult[];
  total: number;
  offset: number;
  limit: number;
}

export type CopyField = "name" | "model" | "serial" | "assetTag" | "epc" | "cost";

export type ActionRequest =
  | { action: "create_items"; resultIds: string[]; companyId?: string | null; defaultLocationId?: string | null }
  | { action: "move_to_register"; resultIds: string[] }
  | { action: "accept_bindex_location"; resultIds: string[] }
  | { action: "copy_fields"; resultIds: string[]; direction: "to_bindex" | "to_register"; fields: CopyField[] }
  | { action: "flag_missing"; resultIds: string[] }
  | { action: "clear_missing"; resultIds: string[] }
  | { action: "link_proposal"; resultIds: string[] }
  | { action: "ignore"; resultIds: string[]; reason: string }
  | { action: "reopen"; resultIds: string[] };

export interface ActionOutcome {
  action: ActionRequest["action"];
  done: number;
  skipped: { resultId: string; reason: string }[];
  created?: { rowId: string; rowNumber: number; itemId: string; assetCode: string }[];
}

export interface CompareEntry {
  key: string;
  label: string;
  before: ReconcileClass[];
  after: ReconcileClass[];
}

export interface RunComparison {
  before: { id: string; createdAt: string; importName: string; scopeLabel: string | null };
  after: { id: string; createdAt: string; importName: string; scopeLabel: string | null };
  counts: Record<ReconcileClass, { before: number; after: number }>;
  cleared: CompareEntry[];
  appeared: CompareEntry[];
  changed: CompareEntry[];
  unchanged: number;
}

export interface PlannedItem {
  rowId: string;
  rowNumber: number;
  name: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  description: string | null;
  quantity: number;
  valueCents: number | null;
  locationId: string | null;
  locationPath: string | null;
  companyId: string | null;
  identifiers: { type: string; value: string }[];
}

export interface ImportPreview {
  create: PlannedItem[];
  skip: { rowId: string; rowNumber: number; reason: string }[];
  warnings: { rowId: string; rowNumber: number; message: string }[];
  hash: string;
}
