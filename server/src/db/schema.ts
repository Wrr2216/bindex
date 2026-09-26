import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { genAssetCode } from "../lib/codes";

export type IdentifierType =
  | "upc"
  | "serial"
  | "asset_tag"
  | "mac"
  | "sku"
  | "other"
  | "rfid"
  | "domain"
  | "nfc"
  | "legacy";

export type ItemEventAction = "created" | "updated" | "scanned" | "moved" | "deleted";

export type UserRole = "admin" | "member";

export const users = pgTable("users", {
  // `local:<uuid>` for a password account, `<issuer-host>:<sub>` for an SSO one.
  oid: text("oid").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").$type<UserRole>().default("member").notNull(),
  disabled: boolean("disabled").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastLogin: timestamp("last_login", { withTimezone: true }).defaultNow().notNull(),
});

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  address: text("address"),
  notes: text("notes"),
  companyId: uuid("company_id"),
  parentId: uuid("parent_id"), // optional parent location, so a building can hold a room holding a tote
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const entities = pgTable("entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind"), // optional: customer | department | person | site | other
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  brand: text("brand"),
  model: text("model"),
  category: text("category"),
  primaryImageUrl: text("primary_image_url"),
  parentItemId: uuid("parent_item_id"),
  locationId: uuid("location_id"),
  quantity: integer("quantity").default(1).notNull(),
  status: text("status").default("active").notNull(),
  valueCents: bigint("value_cents", { mode: "number" }), // monetary value in cents
  expiresAt: timestamp("expires_at", { withTimezone: true }), // e.g. domain renewal date
  // Which lookup produced the product details: upcitemdb | web | manual |
  // ninjaone | registrar.
  enrichmentSource: text("enrichment_source"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  // Printed on labels. A database trigger regenerates it on collision.
  assetCode: text("asset_code").notNull().$defaultFn(genAssetCode),
  ninjaoneDeviceId: bigint("ninjaone_device_id", { mode: "number" }),
  ninjaoneAssetId: text("ninjaone_asset_id"),
  ninjaoneOrg: text("ninjaone_org"),
  ninjaoneSyncedAt: timestamp("ninjaone_synced_at", { withTimezone: true }),
  utilizedByEntityId: uuid("utilized_by_entity_id"),
  companyId: uuid("company_id"),
  lastSpotCheckedAt: timestamp("last_spot_checked_at", { withTimezone: true }),
  lastSpotCheckedBy: text("last_spot_checked_by"),
  flaggedMissing: boolean("flagged_missing").default(false).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const itemIdentifiers = pgTable("item_identifiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  type: text("type").$type<IdentifierType>().notNull(),
  value: text("value").notNull(), // unique across all items (DB constraint)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const itemUnits = pgTable("item_units", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  // Same shape as an item's code, so one reader resolves both. The database
  // trigger also rejects a code already taken by an item.
  assetCode: text("asset_code").notNull().$defaultFn(genAssetCode),
  label: text("label"), // optional human name for this unit ("Unit 1", "Spare")
  serial: text("serial"),
  status: text("status").default("active").notNull(),
  valueCents: bigint("value_cents", { mode: "number" }),
  locationId: uuid("location_id"),
  utilizedByEntityId: uuid("utilized_by_entity_id"),
  companyId: uuid("company_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const itemImages = pgTable("item_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  url: text("url").notNull(),
  isPrimary: boolean("is_primary").default(false).notNull(),
  sort: integer("sort").default(0).notNull(),
});

export const itemEvents = pgTable("item_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id"),
  userOid: text("user_oid"),
  action: text("action").$type<ItemEventAction>().notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const itemAssignments = pgTable("item_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"), // null = the whole item is out; set = just that unit
  entityId: uuid("entity_id"),
  entityName: text("entity_name").notNull(),
  checkedOutAt: timestamp("checked_out_at", { withTimezone: true }).defaultNow().notNull(),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  checkedOutBy: text("checked_out_by"),
  checkedInBy: text("checked_in_by"),
  note: text("note"),
});

export const enrichmentCache = pgTable("enrichment_cache", {
  code: text("code").primaryKey(),
  provider: text("provider").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});

export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  created: integer("created").default(0).notNull(),
  updated: integer("updated").default(0).notNull(),
  matched: integer("matched").default(0).notNull(),
  error: text("error"),
});

export type ApiKeyScope = "read" | "read_write";

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyLast4: text("key_last4").notNull(),
  scope: text("scope").$type<ApiKeyScope>().default("read").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const ninjaoneTokens = pgTable("ninjaone_tokens", {
  provider: text("provider").primaryKey().default("ninjaone"),
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  scope: text("scope"),
  connectedBy: text("connected_by"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Location = typeof locations.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Entity = typeof entities.$inferSelect;
export type ItemUnit = typeof itemUnits.$inferSelect;
export type ItemAssignment = typeof itemAssignments.$inferSelect;
export type ItemIdentifier = typeof itemIdentifiers.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type NinjaoneToken = typeof ninjaoneTokens.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type User = typeof users.$inferSelect;
export * from "./tables/event-backbone";
export * from "./tables/tracking-core";
export * from "./tables/media-ai-core";
export * from "./tables/jobs-core";
export * from "./tables/register-reconcile";
export * from "./tables/consumables";
export * from "./tables/tag-commissioning";
export * from "./tables/offline-field";
export * from "./tables/bulk-capture";
export * from "./tables/ai-condition";
export * from "./tables/inspections";
export * from "./tables/valuation";
export * from "./tables/crew";
export * from "./tables/custody";
export * from "./tables/teardown";
export * from "./tables/gps";
export * from "./tables/documents";
export * from "./tables/portal";
