import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Valuation, declarations, receipts, warranty and service (T19). Mirrors
 * server/migrations/0040_valuation.sql; docs/valuation.md explains the model.
 * Dates without a time (purchase, warranty end, valued on) are "YYYY-MM-DD"
 * strings, so no time zone can move them a day.
 */

export const VALUATION_SOURCES = ["ai", "web", "receipt", "manual", "appraisal"] as const;
export type ValuationSource = (typeof VALUATION_SOURCES)[number];

export const HIGH_VALUE_MODES = ["auto", "yes", "no"] as const;
export type HighValueMode = (typeof HIGH_VALUE_MODES)[number];

export const DECLARATION_SCOPES = ["company", "location", "job"] as const;
export type DeclarationScope = (typeof DECLARATION_SCOPES)[number];

export const valuations = pgTable("valuations", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  valueCents: bigint("value_cents", { mode: "number" }).notNull(),
  previousCents: bigint("previous_cents", { mode: "number" }),
  currency: text("currency").notNull(),
  source: text("source").$type<ValuationSource>().notNull(),
  basis: text("basis"),
  confidence: real("confidence"),
  lowCents: bigint("low_cents", { mode: "number" }),
  highCents: bigint("high_cents", { mode: "number" }),
  valuedOn: date("valued_on").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const valuationProfiles = pgTable("valuation_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  purchaseDate: date("purchase_date"),
  purchaseCents: bigint("purchase_cents", { mode: "number" }),
  vendor: text("vendor"),
  receiptId: uuid("receipt_id"),
  warrantyEnds: date("warranty_ends"),
  warrantyTerms: text("warranty_terms"),
  warrantyProvider: text("warranty_provider"),
  highValue: text("high_value").$type<HighValueMode>().default("auto").notNull(),
  usageHours: numeric("usage_hours", { mode: "number" }),
  usageReadAt: timestamp("usage_read_at", { withTimezone: true }),
  warrantyAlertedFor: date("warranty_alerted_for"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const servicePlans = pgTable("service_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  name: text("name").notNull(),
  intervalDays: integer("interval_days"),
  intervalHours: numeric("interval_hours", { mode: "number" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).defaultNow().notNull(),
  startsHours: numeric("starts_hours", { mode: "number" }),
  lastDoneAt: timestamp("last_done_at", { withTimezone: true }),
  lastDoneHours: numeric("last_done_hours", { mode: "number" }),
  notes: text("notes"),
  active: boolean("active").default(true).notNull(),
  alertedFor: text("alerted_for"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const serviceRecords = pgTable("service_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id"),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  planName: text("plan_name"),
  doneAt: timestamp("done_at", { withTimezone: true }).defaultNow().notNull(),
  hours: numeric("hours", { mode: "number" }),
  costCents: bigint("cost_cents", { mode: "number" }),
  notes: text("notes"),
  doneBy: text("done_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ReceiptStatus = "draft" | "confirmed";

export const receipts = pgTable("receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").$type<ReceiptStatus>().default("draft").notNull(),
  vendor: text("vendor"),
  purchaseDate: date("purchase_date"),
  currency: text("currency"),
  subtotalCents: bigint("subtotal_cents", { mode: "number" }),
  taxCents: bigint("tax_cents", { mode: "number" }),
  totalCents: bigint("total_cents", { mode: "number" }),
  reading: jsonb("reading").$type<Record<string, unknown> | null>(),
  notes: text("notes"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedBy: text("confirmed_by"),
});

export const receiptLines = pgTable("receipt_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id").notNull(),
  position: integer("position").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { mode: "number" }).default(1).notNull(),
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }),
  totalCents: bigint("total_cents", { mode: "number" }),
  sku: text("sku"),
  serial: text("serial"),
  warrantyMonths: integer("warranty_months"),
  itemId: uuid("item_id"),
  unitId: uuid("unit_id"),
  matchScore: real("match_score"),
  matchReason: text("match_reason"),
});

export type DeclarationStatus = "draft" | "signed";

export const hvDeclarations = pgTable("hv_declarations", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Assigned by the database from a sequence: HVI-00001, HVI-00002…
  code: text("code").notNull(),
  title: text("title").notNull(),
  scope: text("scope").$type<DeclarationScope>().notNull(),
  scopeId: uuid("scope_id"),
  scopeLabel: text("scope_label"),
  status: text("status").$type<DeclarationStatus>().default("draft").notNull(),
  currency: text("currency").notNull(),
  notes: text("notes"),
  signatureId: uuid("signature_id"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  auditEntryId: bigint("audit_entry_id", { mode: "number" }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const hvDeclarationLines = pgTable("hv_declaration_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  declarationId: uuid("declaration_id").notNull(),
  position: integer("position").notNull(),
  itemId: uuid("item_id"),
  unitId: uuid("unit_id"),
  valuationId: uuid("valuation_id"),
  name: text("name").notNull(),
  brand: text("brand"),
  model: text("model"),
  serial: text("serial"),
  assetCode: text("asset_code"),
  description: text("description"),
  materials: text("materials"),
  condition: text("condition"),
  declaredCents: bigint("declared_cents", { mode: "number" }).notNull(),
  valueSource: text("value_source"),
  notes: text("notes"),
});

export type ValuationRow = typeof valuations.$inferSelect;
export type ValuationProfileRow = typeof valuationProfiles.$inferSelect;
export type ServicePlanRow = typeof servicePlans.$inferSelect;
export type ServiceRecordRow = typeof serviceRecords.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;
export type ReceiptLineRow = typeof receiptLines.$inferSelect;
export type HvDeclarationRow = typeof hvDeclarations.$inferSelect;
export type HvDeclarationLineRow = typeof hvDeclarationLines.$inferSelect;
