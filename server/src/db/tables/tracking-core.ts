import {
  pgTable,
  uuid,
  text,
  integer,
  bigserial,
  boolean,
  timestamp,
  jsonb,
  real,
  doublePrecision,
} from "drizzle-orm/pg-core";

/**
 * Tracking core (T01). Mirrors server/migrations/0022_tracking_core.sql.
 * docs/tracking-core.md explains the model; the services that write these
 * tables live in server/src/services/tracking/.
 */

/** Every kind of device the tracking features know about. */
export const TRACKING_DEVICE_KINDS = [
  "rfid_reader",
  "rfid_portal",
  "ble_gateway",
  "ble_beacon",
  "ble_tag",
  "gps_tracker",
  "nfc_reader",
  "mobile",
] as const;
export type TrackingDeviceKind = (typeof TRACKING_DEVICE_KINDS)[number];

/** The radio or method that produced a sighting. */
export const SIGHTING_TECHS = ["rfid", "ble", "gps", "nfc", "barcode", "manual"] as const;
export type SightingTech = (typeof SIGHTING_TECHS)[number];

/** Which way an asset went through a portal. */
export type SightingDirection = "in" | "out";

export const trackingDevices = pgTable("tracking_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<TrackingDeviceKind>().notNull(),
  name: text("name").notNull(),
  // Reader serial, MAC or IMEI. Unique per kind.
  externalId: text("external_id"),
  // The zone a fixed device covers.
  locationId: uuid("location_id"),
  // The asset a tag or tracker is attached to.
  itemId: uuid("item_id"),
  unitId: uuid("unit_id"),
  // Whether reads by this device may change an item's recorded location.
  updatesLocation: boolean("updates_location").default(false).notNull(),
  // Shape documented by TrackingDeviceSettings in services/tracking/types.ts.
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  tokenHash: text("token_hash"),
  tokenLast4: text("token_last4"),
  batteryPct: integer("battery_pct"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  disabled: boolean("disabled").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sightings = pgTable("sightings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  deviceId: uuid("device_id"),
  tech: text("tech").$type<SightingTech>().notNull(),
  // Raw EPC, beacon identity or tracker id, as normalized on the way in.
  code: text("code"),
  itemId: uuid("item_id"),
  unitId: uuid("unit_id"),
  // The zone the sighting resolved to, if any.
  locationId: uuid("location_id"),
  rssi: real("rssi"),
  antenna: integer("antenna"),
  direction: text("direction").$type<SightingDirection>(),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  accuracyM: real("accuracy_m"),
  speedMps: real("speed_mps"),
  headingDeg: real("heading_deg"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
});

export const assetPositions = pgTable("asset_positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  // Null for the item as a whole; set when a unit carries its own tag.
  unitId: uuid("unit_id"),
  tech: text("tech").$type<SightingTech>().notNull(),
  locationId: uuid("location_id"),
  previousLocationId: uuid("previous_location_id"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  deviceId: uuid("device_id"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  // When the asset arrived in locationId.
  enteredAt: timestamp("entered_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TrackingDevice = typeof trackingDevices.$inferSelect;
export type Sighting = typeof sightings.$inferSelect;
export type AssetPosition = typeof assetPositions.$inferSelect;
