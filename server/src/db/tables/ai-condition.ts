import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// T12: condition reports, condition sweeps and container captures.
// See migrations/0033_ai_condition.sql.

export type ConditionStage = "before" | "after" | "inspection" | "custom";
export type ConditionRating = "excellent" | "good" | "fair" | "poor" | "damaged";
export type DefectType = "scratch" | "dent" | "gouge" | "stain" | "crack" | "loose" | "missing_part" | "other";
export type DefectSeverity = "minor" | "moderate" | "major";
export type ContainerFlag = "fragile" | "this_side_up" | "high_value" | "heavy" | "keep_dry";

export type Defect = {
  area: string;
  type: DefectType;
  severity: DefectSeverity;
  description: string | null;
};

export type ContentLine = {
  name: string;
  category: string | null;
  qty: number;
  condition: ConditionRating | null;
  fragile: boolean;
  description: string | null;
  /** The item created for this line, once saved. */
  itemId?: string | null;
};

export const conditionSweeps = pgTable("condition_sweeps", {
  id: uuid("id").primaryKey().defaultRandom(),
  locationId: uuid("location_id"),
  name: text("name"),
  stage: text("stage").$type<Exclude<ConditionStage, "custom">>().default("inspection").notNull(),
  status: text("status").$type<"open" | "closed">().default("open").notNull(),
  startedBy: text("started_by"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  closedBy: text("closed_by"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const conditionReports = pgTable("condition_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  stage: text("stage").$type<ConditionStage>().notNull(),
  stageLabel: text("stage_label"),
  rating: text("rating").$type<ConditionRating>(),
  notes: text("notes"),
  aiNotes: text("ai_notes"),
  defects: jsonb("defects").$type<Defect[]>().default([]).notNull(),
  handlingNote: text("handling_note"),
  attachmentIds: uuid("attachment_ids").array().default([]).notNull(),
  aiAssisted: boolean("ai_assisted").default(false).notNull(),
  sweepId: uuid("sweep_id"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const containerCaptures = pgTable("container_captures", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  sizeClass: text("size_class"),
  handwrittenText: text("handwritten_text"),
  room: text("room"),
  contentsSummary: text("contents_summary"),
  contents: jsonb("contents").$type<ContentLine[]>().default([]).notNull(),
  flags: text("flags").array().$type<ContainerFlag[]>().default([]).notNull(),
  confidence: jsonb("confidence").$type<Record<string, number>>(),
  aiAssisted: boolean("ai_assisted").default(false).notNull(),
  attachmentIds: uuid("attachment_ids").array().default([]).notNull(),
  createdItemIds: uuid("created_item_ids").array().default([]).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ConditionSweepRow = typeof conditionSweeps.$inferSelect;
export type ConditionReportRow = typeof conditionReports.$inferSelect;
export type ContainerCaptureRow = typeof containerCaptures.$inferSelect;
