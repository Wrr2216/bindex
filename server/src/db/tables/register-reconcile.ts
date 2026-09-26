import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  date,
  real,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

/** T05: asset register import and reconciliation. See docs/register-reconcile.md. */

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

export type MatchMethod = "asset_tag" | "serial" | "epc" | "asset_code";

export type RegisterEdit = { from: string | null; to: string | null; at: string; by: string | null };

export const registerImports = pgTable("register_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  sourcePreset: text("source_preset").$type<RegisterPreset>().default("generic").notNull(),
  fileName: text("file_name"),
  fileFormat: text("file_format").$type<"csv" | "xlsx">().notNull(),
  fileSha256: text("file_sha256").notNull(),
  rowCount: integer("row_count").default(0).notNull(),
  headers: jsonb("headers").$type<string[]>().default([]).notNull(),
  columnMapping: jsonb("column_mapping").$type<ColumnMapping>().default({}).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const registerRows = pgTable("register_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  importId: uuid("import_id").notNull(),
  rowNumber: integer("row_number").notNull(),
  raw: jsonb("raw").$type<Record<string, string>>().notNull(),
  assetTag: text("asset_tag"),
  serial: text("serial"),
  epc: text("epc"),
  bindexCode: text("bindex_code"),
  name: text("name"),
  model: text("model"),
  brand: text("brand"),
  category: text("category"),
  description: text("description"),
  locationText: text("location_text"),
  custodian: text("custodian"),
  costCents: bigint("cost_cents", { mode: "number" }),
  purchaseDate: date("purchase_date", { mode: "string" }),
  quantity: integer("quantity"),
  issues: jsonb("issues").$type<string[]>().default([]).notNull(),
  edits: jsonb("edits").$type<Record<string, RegisterEdit>>().default({}).notNull(),
  createdItemId: uuid("created_item_id"),
});

export const registerLocationMap = pgTable("register_location_map", {
  sourceText: text("source_text").primaryKey(),
  displayText: text("display_text").notNull(),
  locationId: uuid("location_id").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const reconciliationRuns = pgTable("reconciliation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  importId: uuid("import_id").notNull(),
  scopeCompanyId: uuid("scope_company_id"),
  scopeLocationId: uuid("scope_location_id"),
  scopeLabel: text("scope_label"),
  counts: jsonb("counts").$type<Record<string, number>>().default({}).notNull(),
  durationMs: integer("duration_ms"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ResultConflict = { field: string; register: string | null; bindex: string | null };

export type ResultSnapshot = {
  itemName?: string;
  itemAssetCode?: string;
  unitAssetCode?: string | null;
  unitLabel?: string | null;
  model?: string | null;
  serials?: string[];
  valueCents?: number | null;
  flaggedMissing?: boolean;
  proposalName?: string;
  proposalAssetCode?: string;
};

export const reconciliationResults = pgTable("reconciliation_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  rowId: uuid("row_id"),
  itemId: uuid("item_id"),
  unitId: uuid("unit_id"),
  classes: text("classes").array().$type<ReconcileClass[]>().notNull(),
  matchMethod: text("match_method").$type<MatchMethod>(),
  registerLocationId: uuid("register_location_id"),
  bindexLocationId: uuid("bindex_location_id"),
  proposalItemId: uuid("proposal_item_id"),
  proposalScore: real("proposal_score"),
  conflicts: jsonb("conflicts").$type<ResultConflict[]>().default([]).notNull(),
  notes: jsonb("notes").$type<string[]>().default([]).notNull(),
  snapshot: jsonb("snapshot").$type<ResultSnapshot>().default({}).notNull(),
  resolution: text("resolution").$type<"resolved" | "ignored">(),
  resolutionNote: text("resolution_note"),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export type RegisterImport = typeof registerImports.$inferSelect;
export type RegisterRow = typeof registerRows.$inferSelect;
export type ReconciliationRun = typeof reconciliationRuns.$inferSelect;
export type ReconciliationResult = typeof reconciliationResults.$inferSelect;
