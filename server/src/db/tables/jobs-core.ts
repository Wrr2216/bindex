import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  date,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Projects, jobs, shipments and manifests (T03). The SQL lives in
 * migrations/0024_jobs_core.sql; this file only describes it for queries.
 *
 * Stage, task-kind and "via" values are plain strings here on purpose: the core
 * set is in services/jobs-core/model.ts, and later features register more at
 * runtime.
 */

export type ProjectStatus = "planned" | "active" | "on_hold" | "completed" | "cancelled";
export type JobStatus = "planned" | "in_progress" | "completed" | "cancelled";
export type JobTaskStatus = "todo" | "doing" | "done" | "skipped";
export type ShipmentStatus = "planned" | "staged" | "loaded" | "in_transit" | "delivered" | "closed";

/** One step of a job type's task template. */
export type JobTaskTemplateEntry = { kind: string; title: string };

export const jobTypes = pgTable("job_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  color: text("color").default("#0284c7").notNull(),
  description: text("description"),
  taskTemplate: jsonb("task_template").$type<JobTaskTemplateEntry[]>().default([]).notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  companyId: uuid("company_id"),
  entityId: uuid("entity_id"),
  status: text("status").$type<ProjectStatus>().default("planned").notNull(),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const projectPhases = pgTable("project_phases", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  sequence: integer("sequence").default(0).notNull(),
  name: text("name").notNull(),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  projectId: uuid("project_id"),
  phaseId: uuid("phase_id"),
  jobTypeId: uuid("job_type_id"),
  name: text("name").notNull(),
  status: text("status").$type<JobStatus>().default("planned").notNull(),
  originLocationId: uuid("origin_location_id"),
  destinationLocationId: uuid("destination_location_id"),
  scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
  scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobTasks = pgTable("job_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull(),
  sequence: integer("sequence").default(0).notNull(),
  kind: text("kind").default("custom").notNull(),
  title: text("title").notNull(),
  status: text("status").$type<JobTaskStatus>().default("todo").notNull(),
  assigneeEntityId: uuid("assignee_entity_id"),
  assigneeUserOid: text("assignee_user_oid"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: text("completed_by"),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const shipments = pgTable("shipments", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  jobId: uuid("job_id").notNull(),
  name: text("name").notNull(),
  status: text("status").$type<ShipmentStatus>().default("planned").notNull(),
  vehicleLocationId: uuid("vehicle_location_id"),
  carrier: text("carrier"),
  sealNumbers: text("seal_numbers").array().default(sql`'{}'::text[]`).notNull(),
  weightKg: doublePrecision("weight_kg"),
  volumeM3: doublePrecision("volume_m3"),
  distanceKm: doublePrecision("distance_km"),
  eta: timestamp("eta", { withTimezone: true }),
  departedAt: timestamp("departed_at", { withTimezone: true }),
  arrivedAt: timestamp("arrived_at", { withTimezone: true }),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const shipmentStatusHistory = pgTable("shipment_status_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  shipmentId: uuid("shipment_id").notNull(),
  fromStatus: text("from_status").$type<ShipmentStatus>(),
  toStatus: text("to_status").$type<ShipmentStatus>().notNull(),
  forced: boolean("forced").default(false).notNull(),
  reason: text("reason"),
  userOid: text("user_oid"),
  actor: text("actor"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobItems = pgTable("job_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull(),
  shipmentId: uuid("shipment_id"),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  originLocationId: uuid("origin_location_id"),
  destinationLocationId: uuid("destination_location_id"),
  destinationLabel: text("destination_label"),
  floor: text("floor"),
  department: text("department"),
  crateNo: text("crate_no"),
  stage: text("stage").default("pending").notNull(),
  stageAt: timestamp("stage_at", { withTimezone: true }).defaultNow().notNull(),
  stageBy: text("stage_by"),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobItemStageHistory = pgTable("job_item_stage_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobItemId: uuid("job_item_id").notNull(),
  jobId: uuid("job_id").notNull(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  shipmentId: uuid("shipment_id"),
  fromStage: text("from_stage"),
  toStage: text("to_stage").notNull(),
  via: text("via").default("manual").notNull(),
  deviceId: text("device_id"),
  userOid: text("user_oid"),
  actor: text("actor"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type JobType = typeof jobTypes.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectPhase = typeof projectPhases.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type JobTask = typeof jobTasks.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
export type ShipmentStatusChange = typeof shipmentStatusHistory.$inferSelect;
export type JobItem = typeof jobItems.$inferSelect;
export type JobItemStageChange = typeof jobItemStageHistory.$inferSelect;
