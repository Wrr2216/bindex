import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, doublePrecision } from "drizzle-orm/pg-core";

/**
 * Operations insights. Mirrors server/migrations/0043_ops_intel.sql;
 * docs/ops-intel.md explains the rules and the analytics built on these.
 */

export type AnomalySeverity = "low" | "medium" | "high";
export type AnomalyResolution = "fixed" | "dismissed" | "cleared";
export type LocationRole = "dock" | "pick" | "storage" | "staging" | "vehicle";

export const opsAnomalies = pgTable("ops_anomalies", {
  id: uuid("id").primaryKey().defaultRandom(),
  rule: text("rule").notNull(),
  key: text("key").notNull(),
  severity: text("severity").$type<AnomalySeverity>().default("medium").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  itemId: uuid("item_id"),
  unitId: uuid("unit_id"),
  jobId: uuid("job_id"),
  shipmentId: uuid("shipment_id"),
  locationId: uuid("location_id"),
  title: text("title").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
  link: text("link"),
  sticky: boolean("sticky").default(false).notNull(),
  occurrences: integer("occurrences").default(1).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: text("resolved_by"),
  resolvedByName: text("resolved_by_name"),
  resolution: text("resolution").$type<AnomalyResolution>(),
  resolutionNote: text("resolution_note"),
  reopenedFrom: uuid("reopened_from"),
  explanation: text("explanation"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const opsRuns = pgTable("ops_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  trigger: text("trigger").$type<"schedule" | "manual">().default("schedule").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  opened: integer("opened").default(0).notNull(),
  updated: integer("updated").default(0).notNull(),
  cleared: integer("cleared").default(0).notNull(),
  byRule: jsonb("by_rule").$type<Record<string, unknown>>().default({}).notNull(),
  error: text("error"),
  userOid: text("user_oid"),
});

export const opsLocationProfiles = pgTable("ops_location_profiles", {
  locationId: uuid("location_id").primaryKey(),
  role: text("role").$type<LocationRole>(),
  distanceToDockM: doublePrecision("distance_to_dock_m"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  maxKg: doublePrecision("max_kg"),
  maxM3: doublePrecision("max_m3"),
  interiorLengthM: doublePrecision("interior_length_m"),
  interiorWidthM: doublePrecision("interior_width_m"),
  interiorHeightM: doublePrecision("interior_height_m"),
  notes: text("notes"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type OpsAnomaly = typeof opsAnomalies.$inferSelect;
export type OpsRun = typeof opsRuns.$inferSelect;
export type OpsLocationProfile = typeof opsLocationProfiles.$inferSelect;
