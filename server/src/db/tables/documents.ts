import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, primaryKey } from "drizzle-orm/pg-core";

/**
 * Document templates, packets and filled documents. The SQL lives in
 * migrations/0038_documents.sql; this file only describes it for queries.
 * Block, field and condition shapes are in services/documents/model.ts.
 */

export type DocumentStatus = "draft" | "completed" | "signed";
export type TemplateVersionStatus = "draft" | "published";

export const documentCustomFields = pgTable("document_custom_fields", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  type: text("type").notNull(),
  required: boolean("required").default(false).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const documentTemplates = pgTable("document_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  active: boolean("active").default(true).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const documentTemplateVersions = pgTable("document_template_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").$type<TemplateVersionStatus>().default("draft").notNull(),
  title: text("title").notNull(),
  body: jsonb("body").$type<unknown[]>().default([]).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedBy: text("published_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const documentPackets = pgTable("document_packets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  conditions: jsonb("conditions").$type<Record<string, unknown>>().default({}).notNull(),
  autoAttach: boolean("auto_attach").default(true).notNull(),
  active: boolean("active").default(true).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const documentPacketTemplates = pgTable(
  "document_packet_templates",
  {
    packetId: uuid("packet_id").notNull(),
    templateId: uuid("template_id").notNull(),
    position: integer("position").default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.packetId, t.templateId] })],
);

export const documentJobPackets = pgTable(
  "document_job_packets",
  {
    jobId: uuid("job_id").notNull(),
    packetId: uuid("packet_id").notNull(),
    auto: boolean("auto").default(true).notNull(),
    applies: boolean("applies").default(true).notNull(),
    attachedBy: text("attached_by"),
    attachedAt: timestamp("attached_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.packetId] })],
);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id").notNull(),
  templateVersionId: uuid("template_version_id").notNull(),
  jobId: uuid("job_id"),
  packetId: uuid("packet_id"),
  position: integer("position").default(0).notNull(),
  title: text("title").notNull(),
  status: text("status").$type<DocumentStatus>().default("draft").notNull(),
  values: jsonb("field_values").$type<Record<string, unknown>>().default({}).notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
  contentHash: text("content_hash"),
  copiedFrom: uuid("copied_from"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: text("completed_by"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const documentExports = pgTable("document_exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull(),
  sha256: text("sha256").notNull(),
  contentHash: text("content_hash").notNull(),
  status: text("status").$type<DocumentStatus>().notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  attachmentId: uuid("attachment_id"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type DocumentCustomField = typeof documentCustomFields.$inferSelect;
export type DocumentTemplate = typeof documentTemplates.$inferSelect;
export type DocumentTemplateVersion = typeof documentTemplateVersions.$inferSelect;
export type DocumentPacket = typeof documentPackets.$inferSelect;
export type DocumentPacketTemplate = typeof documentPacketTemplates.$inferSelect;
export type DocumentJobPacket = typeof documentJobPackets.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentExport = typeof documentExports.$inferSelect;
