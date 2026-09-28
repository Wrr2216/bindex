import { pgTable, uuid, text, integer, bigint, timestamp, jsonb } from "drizzle-orm/pg-core";

// Tables for tag commissioning (migration 0028). Foreign keys and the trigger
// that fills tag_legacy_stickers live in the migration.

/** Which unit of an item a bound tag is stuck on. */
export const tagIdentifierUnits = pgTable("tag_identifier_units", {
  identifierId: uuid("identifier_id").primaryKey(),
  unitId: uuid("unit_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Maintained by a database trigger from each 'legacy' identifier; read-only here. */
export const tagLegacyStickers = pgTable("tag_legacy_stickers", {
  identifierId: uuid("identifier_id").primaryKey(),
  itemId: uuid("item_id").notNull(),
  color: text("color").notNull(),
  lot: text("lot"),
  number: bigint("number", { mode: "number" }).notNull(),
});

export type TagEpcScheme = "giai-96" | "bindex-96";

/** The EPC assigned to an item (unit_id null) or to one unit. */
export const tagEpcs = pgTable("tag_epcs", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  scheme: text("scheme").$type<TagEpcScheme>().notNull(),
  epc: text("epc").notNull(),
  giaiSerial: bigint("giai_serial", { mode: "number" }),
  encodedAt: timestamp("encoded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TagBindSessionStatus = "active" | "finished";

export const tagBindSessions = pgTable("tag_bind_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  tagType: text("tag_type").$type<"rfid" | "nfc">().notNull(),
  queue: jsonb("queue").$type<{ itemId: string; unitId: string | null }[]>().default([]).notNull(),
  position: integer("position").default(0).notNull(),
  history: jsonb("history").$type<unknown[]>().default([]).notNull(),
  status: text("status").$type<TagBindSessionStatus>().default("active").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TagEpc = typeof tagEpcs.$inferSelect;
export type TagBindSession = typeof tagBindSessions.$inferSelect;
