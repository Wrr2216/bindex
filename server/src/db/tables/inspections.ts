import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Pre- and post-move facility inspections. The SQL lives in
 * migrations/0034_inspections.sql; this file only describes it for queries.
 * Spots are plain strings on purpose: the list is in
 * services/inspections/model.ts and the database checks only their shape.
 */

export type InspectionKind = "pre" | "post" | "adhoc";
export type InspectionStatus = "draft" | "completed" | "signed";
export type FindingArea = "inside" | "outside";
export type FindingSeverity = "minor" | "moderate" | "major";
export type PairSource = "ai" | "manual";

export const inspections = pgTable("inspections", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  kind: text("kind").$type<InspectionKind>().notNull(),
  status: text("status").$type<InspectionStatus>().default("draft").notNull(),
  jobId: uuid("job_id"),
  jobTaskId: uuid("job_task_id"),
  locationId: uuid("location_id"),
  siteName: text("site_name").notNull(),
  preInspectionId: uuid("pre_inspection_id"),
  inspectors: text("inspectors").array().default([]).notNull(),
  notes: text("notes"),
  facilitySignatureId: uuid("facility_signature_id"),
  crewSignatureId: uuid("crew_signature_id"),
  startedBy: text("started_by"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: text("completed_by"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const inspectionFindings = pgTable("inspection_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  inspectionId: uuid("inspection_id").notNull(),
  sequence: integer("sequence").default(0).notNull(),
  area: text("area").$type<FindingArea>().default("inside").notNull(),
  room: text("room").notNull(),
  locationId: uuid("location_id"),
  spot: text("spot").notNull(),
  spotDetail: text("spot_detail"),
  description: text("description").notNull(),
  severity: text("severity").$type<FindingSeverity>().default("minor").notNull(),
  aiGenerated: boolean("ai_generated").default(false).notNull(),
  aiSuggestion: jsonb("ai_suggestion").$type<Record<string, unknown> | null>(),
  preExisting: boolean("pre_existing").default(false).notNull(),
  attachmentIds: uuid("attachment_ids").array().default([]).notNull(),
  pairedWithId: uuid("paired_with_id"),
  pairSource: text("pair_source").$type<PairSource | null>(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const inspectionShares = pgTable("inspection_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  inspectionId: uuid("inspection_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
  openCount: integer("open_count").default(0).notNull(),
});

export type Inspection = typeof inspections.$inferSelect;
export type InspectionFinding = typeof inspectionFindings.$inferSelect;
export type InspectionShare = typeof inspectionShares.$inferSelect;
