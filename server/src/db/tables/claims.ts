import { bigint, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Claims and incident reports, their lines and their activity. The SQL lives
 * in migrations/0037_claims.sql; this file only describes it for queries.
 */

export type ClaimType = "loss" | "damage" | "property_damage" | "delay" | "other" | "incident";
export type ClaimStatus = "draft" | "submitted" | "under_review" | "approved" | "denied" | "paid" | "closed";
export type ClaimResolution = "repair" | "replace" | "cash" | "deny";
export type ClaimActivityKind = "created" | "comment" | "status" | "assignment" | "lines" | "update" | "export" | "sla";

export const claims = pgTable("claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  type: text("type").$type<ClaimType>().notNull(),
  category: text("category"),
  status: text("status").$type<ClaimStatus>().default("draft").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  jobId: uuid("job_id"),
  shipmentId: uuid("shipment_id"),
  locationId: uuid("location_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  reporterUserOid: text("reporter_user_oid"),
  reporterGrantId: uuid("reporter_grant_id"),
  reporterName: text("reporter_name"),
  reporterEmail: text("reporter_email"),
  assigneeUserOid: text("assignee_user_oid"),
  assigneeName: text("assignee_name"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  currency: text("currency").default("USD").notNull(),
  estimatedTotalCents: bigint("estimated_total_cents", { mode: "number" }),
  approvedTotalCents: bigint("approved_total_cents", { mode: "number" }),
  paidTotalCents: bigint("paid_total_cents", { mode: "number" }),
  carrierReference: text("carrier_reference"),
  insurerReference: text("insurer_reference"),
  paymentReference: text("payment_reference"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
  slaBreachedAt: timestamp("sla_breached_at", { withTimezone: true }),
  evidenceHash: text("evidence_hash"),
  evidenceFrozenAt: timestamp("evidence_frozen_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const claimLines = pgTable("claim_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  claimId: uuid("claim_id").notNull(),
  position: integer("position").default(0).notNull(),
  jobItemId: uuid("job_item_id"),
  itemId: uuid("item_id"),
  unitId: uuid("unit_id"),
  itemName: text("item_name"),
  assetCode: text("asset_code"),
  declaredValueCents: bigint("declared_value_cents", { mode: "number" }),
  description: text("description"),
  damageDescription: text("damage_description"),
  estimatedCents: bigint("estimated_cents", { mode: "number" }),
  approvedCents: bigint("approved_cents", { mode: "number" }),
  resolution: text("resolution").$type<ClaimResolution>(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const claimActivity = pgTable("claim_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  claimId: uuid("claim_id").notNull(),
  kind: text("kind").$type<ClaimActivityKind>().notNull(),
  fromStatus: text("from_status").$type<ClaimStatus>(),
  toStatus: text("to_status").$type<ClaimStatus>(),
  body: text("body"),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
  authorUserOid: text("author_user_oid"),
  authorName: text("author_name"),
  authorGrantId: uuid("author_grant_id"),
  auditLogId: bigint("audit_log_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Claim = typeof claims.$inferSelect;
export type ClaimLine = typeof claimLines.$inferSelect;
export type ClaimActivity = typeof claimActivity.$inferSelect;
