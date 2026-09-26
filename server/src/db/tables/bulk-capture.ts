import { boolean, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

// T21: AI bulk capture. See migrations/0042_bulk_capture.sql.

export type CaptureMode = "walkthrough" | "desk" | "manifest";
export type CaptureSessionStatus = "open" | "committed";
export type CaptureCountRule = "max" | "sum";
export type CaptureSourceKind = "photo" | "video_frame" | "pdf_page";
export type CaptureSourceStatus = "pending" | "analysing" | "analysed" | "failed";
export type CaptureDraftStatus = "pending" | "discarded" | "created";

/** Fractions of the image, origin top left. */
export type CaptureBbox = { x: number; y: number; w: number; h: number };

/** One image's contribution to a draft. */
export type CaptureDraftSource = {
  sourceId: string;
  attachmentId: string;
  /** What that image called it. */
  name: string;
  qty: number;
  bbox: CaptureBbox | null;
  confidence: number | null;
};

export type CaptureDeskTemplate = {
  id: string;
  name: string;
  items: { key: string; label: string; qty: number; match: string[] }[];
};

export const captureSessions = pgTable("capture_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  mode: text("mode").$type<CaptureMode>().notNull(),
  title: text("title").notNull(),
  locationId: uuid("location_id"),
  status: text("status").$type<CaptureSessionStatus>().default("open").notNull(),
  countRule: text("count_rule").$type<CaptureCountRule>().default("max").notNull(),
  imageCap: integer("image_cap").default(40).notNull(),
  visionCalls: integer("vision_calls").default(0).notNull(),
  deskTemplate: jsonb("desk_template").$type<CaptureDeskTemplate | null>(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  committedBy: text("committed_by"),
});

export const captureSources = pgTable("capture_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  attachmentId: uuid("attachment_id").notNull(),
  originAttachmentId: uuid("origin_attachment_id"),
  kind: text("kind").$type<CaptureSourceKind>().notNull(),
  position: integer("position").notNull(),
  frameMs: integer("frame_ms"),
  pageNo: integer("page_no"),
  area: text("area"),
  status: text("status").$type<CaptureSourceStatus>().default("pending").notNull(),
  result: jsonb("result").$type<Record<string, unknown> | null>(),
  error: text("error"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  analysedAt: timestamp("analysed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const captureDrafts = pgTable("capture_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  position: integer("position").notNull(),
  status: text("status").$type<CaptureDraftStatus>().default("pending").notNull(),
  name: text("name").notNull(),
  category: text("category"),
  brand: text("brand"),
  model: text("model"),
  description: text("description"),
  qty: integer("qty").default(1).notNull(),
  qtyLocked: boolean("qty_locked").default(false).notNull(),
  edited: boolean("edited").default(false).notNull(),
  manual: boolean("manual").default(false).notNull(),
  area: text("area"),
  locationId: uuid("location_id"),
  lineNo: integer("line_no"),
  condition: text("condition"),
  conditionCodes: text("condition_codes").array().default([]).notNull(),
  stickerColor: text("sticker_color"),
  stickerLot: text("sticker_lot"),
  stickerNumber: text("sticker_number"),
  confidence: real("confidence"),
  sources: jsonb("sources").$type<CaptureDraftSource[]>().default([]).notNull(),
  note: text("note"),
  createdItemIds: uuid("created_item_ids").array().default([]).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CaptureSessionRow = typeof captureSessions.$inferSelect;
export type CaptureSourceRow = typeof captureSources.$inferSelect;
export type CaptureDraftRow = typeof captureDrafts.$inferSelect;
