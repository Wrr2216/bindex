import { boolean, doublePrecision, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// T20: teardown guides, their steps and the parts detached. See
// migrations/0041_teardown.sql.

export type TeardownJobStatus = "idle" | "queued" | "running" | "done" | "failed";
export type TeardownPartKind = "hardware" | "component" | "cable" | "other";
export type TeardownSource = "narration" | "manual";

export const teardownGuides = pgTable("teardown_guides", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  title: text("title").notNull(),
  notes: text("notes"),
  videoAttachmentId: uuid("video_attachment_id"),
  durationSec: doublePrecision("duration_sec"),
  transcript: jsonb("transcript").$type<Record<string, unknown>>(),
  draft: jsonb("draft").$type<Record<string, unknown>>(),
  refinedAt: timestamp("refined_at", { withTimezone: true }),
  jobStatus: text("job_status").$type<TeardownJobStatus>().default("idle").notNull(),
  jobStage: text("job_stage"),
  jobProgress: jsonb("job_progress").$type<Record<string, unknown>>(),
  jobError: text("job_error"),
  jobNotes: jsonb("job_notes").$type<{ code: string; message: string }[]>().default([]).notNull(),
  jobAttempts: integer("job_attempts").default(0).notNull(),
  jobToken: uuid("job_token"),
  jobQueuedAt: timestamp("job_queued_at", { withTimezone: true }),
  jobStartedAt: timestamp("job_started_at", { withTimezone: true }),
  jobHeartbeatAt: timestamp("job_heartbeat_at", { withTimezone: true }),
  jobFinishedAt: timestamp("job_finished_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const teardownSteps = pgTable("teardown_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  guideId: uuid("guide_id").notNull(),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  instruction: text("instruction").default("").notNull(),
  startSec: doublePrecision("start_sec"),
  endSec: doublePrecision("end_sec"),
  callout: text("callout"),
  keyframeAttachmentId: uuid("keyframe_attachment_id"),
  source: text("source").$type<TeardownSource>().default("manual").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const teardownParts = pgTable("teardown_parts", {
  id: uuid("id").primaryKey().defaultRandom(),
  guideId: uuid("guide_id").notNull(),
  stepId: uuid("step_id"),
  position: integer("position").default(0).notNull(),
  name: text("name").notNull(),
  kind: text("kind").$type<TeardownPartKind>().default("other").notNull(),
  qty: integer("qty").default(1).notNull(),
  note: text("note"),
  source: text("source").$type<TeardownSource>().default("manual").notNull(),
  heardAs: text("heard_as"),
  edited: boolean("edited").default(false).notNull(),
  reassembledAt: timestamp("reassembled_at", { withTimezone: true }),
  reassembledBy: text("reassembled_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TeardownGuideRow = typeof teardownGuides.$inferSelect;
export type TeardownStepRow = typeof teardownSteps.$inferSelect;
export type TeardownPartRow = typeof teardownParts.$inferSelect;
