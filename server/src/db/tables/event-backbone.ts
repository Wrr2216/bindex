import { pgTable, uuid, text, integer, bigint, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * T04: audit log and webhooks (migration 0025). Declared for typing; the
 * service writes with SQL, because the audit log is chained by a trigger and
 * webhook deliveries are queued in the same statement as the event.
 */

export const auditLog = pgTable("audit_log", {
  // Assigned by the chaining trigger, never by the caller.
  id: bigint("id", { mode: "number" }).primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  actorKind: text("actor_kind").$type<"user" | "api_key" | "device" | "system">().default("system").notNull(),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  type: text("type").notNull(),
  subjectType: text("subject_type"),
  subjectId: text("subject_id"),
  data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
});

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull(),
  description: text("description").default("").notNull(),
  secret: text("secret").notNull(),
  eventPatterns: text("event_patterns").array().default(["*"]).notNull(),
  active: boolean("active").default(true).notNull(),
  failureCount: integer("failure_count").default(0).notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledReason: text("disabled_reason"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WebhookDeliveryStatus = "pending" | "succeeded" | "failed" | "dead";

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  endpointId: uuid("endpoint_id").notNull(),
  auditLogId: bigint("audit_log_id", { mode: "number" }),
  eventType: text("event_type").notNull(),
  status: text("status").$type<WebhookDeliveryStatus>().default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  responseStatus: integer("response_status"),
  responseMs: integer("response_ms"),
  lastError: text("last_error"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
