import { bigint, customType, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// T02: attachments and signatures. See migrations/0023_media_ai_core.sql.

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export type AttachmentKind = "photo" | "video" | "audio" | "document" | "signature";
export type AttachmentStorage = "db" | "disk";

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerType: text("owner_type").notNull(),
  ownerId: uuid("owner_id").notNull(),
  kind: text("kind").$type<AttachmentKind>().notNull(),
  stage: text("stage"),
  caption: text("caption"),
  mime: text("mime").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  storage: text("storage").$type<AttachmentStorage>().notNull(),
  // Never selected in bulk: read through getAttachmentStream instead.
  bytes: bytea("bytes"),
  // Relative to DATA_DIR, so the volume can move without rewriting rows.
  path: text("path"),
  width: integer("width"),
  height: integer("height"),
  durationMs: integer("duration_ms"),
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const signatures = pgTable("signatures", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerType: text("owner_type").notNull(),
  ownerId: uuid("owner_id").notNull(),
  signerName: text("signer_name").notNull(),
  signerEmail: text("signer_email"),
  signerRole: text("signer_role"),
  statement: text("statement").notNull(),
  contentHash: text("content_hash").notNull(),
  content: jsonb("content").$type<unknown>(),
  attachmentId: uuid("attachment_id"),
  signedAt: timestamp("signed_at", { withTimezone: true }).defaultNow().notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  signedByUser: text("signed_by_user"),
});

export type AttachmentRow = typeof attachments.$inferSelect;
export type SignatureRow = typeof signatures.$inferSelect;
