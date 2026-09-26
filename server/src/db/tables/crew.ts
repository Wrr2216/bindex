import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, date } from "drizzle-orm/pg-core";

/**
 * Crew check-in and credentials. The SQL lives in migrations/0039_crew.sql;
 * this file only describes it for queries, so the foreign keys (to jobs,
 * workers and credential types) are declared there only.
 */

export type CredentialStatus = "valid" | "pending" | "expired" | "failed" | "suspended" | "revoked";
export type CredentialSource = "manual" | "verifier";
export type ComplianceLight = "green" | "amber" | "red";
export type CrewPolicy = "warn" | "block";

export const crewCredentialTypes = pgTable("crew_credential_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  validityMonths: integer("validity_months"),
  warnDays: integer("warn_days").default(30).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crewWorkers = pgTable("crew_workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  company: text("company"),
  role: text("role"),
  badgeCode: text("badge_code").notNull(),
  phone: text("phone"),
  photoAttachmentId: uuid("photo_attachment_id"),
  active: boolean("active").default(true).notNull(),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crewCredentials = pgTable("crew_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  workerId: uuid("worker_id").notNull(),
  typeId: uuid("type_id").notNull(),
  issuer: text("issuer"),
  number: text("number"),
  issuedOn: date("issued_on"),
  expiresOn: date("expires_on"),
  status: text("status").$type<CredentialStatus>().default("valid").notNull(),
  source: text("source").$type<CredentialSource>().default("manual").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  notes: text("notes"),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crewCheckins = pgTable("crew_checkins", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull(),
  workerId: uuid("worker_id").notNull(),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }).defaultNow().notNull(),
  checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
  breakMinutes: integer("break_minutes").default(0).notNull(),
  via: text("via").default("manual").notNull(),
  compliance: text("compliance").$type<ComplianceLight>().notNull(),
  complianceDetail: jsonb("compliance_detail").$type<unknown[]>().default([]).notNull(),
  policy: text("policy").$type<CrewPolicy>().default("warn").notNull(),
  overrideReason: text("override_reason"),
  overriddenBy: text("overridden_by"),
  overriddenByName: text("overridden_by_name"),
  checkedInBy: text("checked_in_by"),
  checkedInByName: text("checked_in_by_name"),
  checkedOutBy: text("checked_out_by"),
  checkedOutByName: text("checked_out_by_name"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CrewCredentialType = typeof crewCredentialTypes.$inferSelect;
export type CrewWorker = typeof crewWorkers.$inferSelect;
export type CrewCredential = typeof crewCredentials.$inferSelect;
export type CrewCheckin = typeof crewCheckins.$inferSelect;
