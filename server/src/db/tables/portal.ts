import { bigint, boolean, integer, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * External portal (T15). Mirrors server/migrations/0036_portal.sql; the
 * services that use these tables live in server/src/services/portal/.
 */

export type PortalScope = "project" | "job" | "shipment";
export type PortalRole = "viewer" | "contributor";
export type PortalCondition = "good" | "fair" | "poor" | "damaged";
export type PortalNotificationStatus = "pending" | "sent" | "skipped" | "failed";

export const portalGrants = pgTable("portal_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").$type<PortalScope>().notNull(),
  projectId: uuid("project_id"),
  jobId: uuid("job_id"),
  shipmentId: uuid("shipment_id"),
  role: text("role").$type<PortalRole>().default("viewer").notNull(),
  granteeName: text("grantee_name").notNull(),
  granteeEmail: text("grantee_email"),
  granteeOrg: text("grantee_org"),
  showValues: boolean("show_values").default(false).notNull(),
  showDocuments: boolean("show_documents").default(true).notNull(),
  allowedStages: text("allowed_stages").array(),
  requireCode: boolean("require_code").default(false).notNull(),
  notify: boolean("notify").default(false).notNull(),
  // sha256 of the link token. Never returned by any API.
  tokenHash: text("token_hash"),
  tokenLast4: text("token_last4"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  useCount: integer("use_count").default(0).notNull(),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const portalCodes = pgTable("portal_codes", {
  grantId: uuid("grant_id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const portalPasses = pgTable("portal_passes", {
  id: uuid("id").primaryKey().defaultRandom(),
  grantId: uuid("grant_id").notNull(),
  passHash: text("pass_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export const portalNotes = pgTable("portal_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  grantId: uuid("grant_id"),
  author: text("author").notNull(),
  jobId: uuid("job_id").notNull(),
  jobItemId: uuid("job_item_id").notNull(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  condition: text("condition").$type<PortalCondition>(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const portalNotifications = pgTable("portal_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  grantId: uuid("grant_id").notNull(),
  milestoneKey: text("milestone_key").notNull(),
  title: text("title").notNull(),
  eventId: bigint("event_id", { mode: "number" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  status: text("status").$type<PortalNotificationStatus>().default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const portalNotifierState = pgTable("portal_notifier_state", {
  id: smallint("id").primaryKey().default(1),
  lastEventId: bigint("last_event_id", { mode: "number" }).default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PortalGrant = typeof portalGrants.$inferSelect;
export type PortalNote = typeof portalNotes.$inferSelect;
export type PortalNotification = typeof portalNotifications.$inferSelect;
