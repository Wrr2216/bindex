import { pgTable, uuid, text, integer, bigserial, timestamp, jsonb, real } from "drizzle-orm/pg-core";

/**
 * Bluetooth beacons, gateways and room-level presence (T09). Mirrors
 * server/migrations/0030_ble.sql. Gateways, tags, room beacons and phones are
 * rows of tracking_devices (tables/tracking-core.ts); these tables hold the
 * presence engine's own state. docs/ble.md explains the model.
 */

/** What a BLE alert is about. */
export const BLE_ALERT_KINDS = ["missing", "after_hours_move", "battery_low"] as const;
export type BleAlertKind = (typeof BLE_ALERT_KINDS)[number];

export const bleTagState = pgTable("ble_tag_state", {
  // The ble_tag device's id, or the tag's identity when it has no device.
  tagKey: text("tag_key").primaryKey(),
  deviceId: uuid("device_id"),
  identity: text("identity").notNull(),
  itemId: uuid("item_id"),
  unitId: uuid("unit_id"),
  locationId: uuid("location_id"),
  previousLocationId: uuid("previous_location_id"),
  zoneSince: timestamp("zone_since", { withTimezone: true }),
  gatewayId: uuid("gateway_id"),
  rssi: real("rssi"),
  lastHeardAt: timestamp("last_heard_at", { withTimezone: true }).notNull(),
  missingSince: timestamp("missing_since", { withTimezone: true }),
  batteryMv: integer("battery_mv"),
  temperatureC: real("temperature_c"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const blePhoneRooms = pgTable("ble_phone_rooms", {
  deviceId: uuid("device_id").primaryKey(),
  userOid: text("user_oid"),
  locationId: uuid("location_id").notNull(),
  beaconId: uuid("beacon_id"),
  rssi: real("rssi"),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const bleAlerts = pgTable("ble_alerts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").$type<BleAlertKind>().notNull(),
  tagKey: text("tag_key"),
  deviceId: uuid("device_id"),
  itemId: uuid("item_id"),
  locationId: uuid("location_id"),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
});

export type BleTagStateRow = typeof bleTagState.$inferSelect;
export type BlePhoneRoom = typeof blePhoneRooms.$inferSelect;
export type BleAlert = typeof bleAlerts.$inferSelect;
