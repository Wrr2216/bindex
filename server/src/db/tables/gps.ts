import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  bigserial,
  boolean,
  timestamp,
  jsonb,
  real,
  doublePrecision,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * GPS trackers, maps and geofences. Mirrors server/migrations/0031_gps.sql;
 * docs/gps.md explains the model and services/gps/ holds the logic.
 */

export type GeofenceKind = "circle" | "polygon";

/** GeoJSON as stored: a Point for a circle's centre, or a Polygon. */
export type GeofenceGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "Polygon"; coordinates: [number, number][][] };

export const GPS_TRACKER_STATUSES = ["available", "assigned", "awaiting_return", "disposed"] as const;
export type GpsTrackerStatus = (typeof GPS_TRACKER_STATUSES)[number];

/** One recent accepted fix, kept for the average speed behind an ETA. */
export type RecentFix = { lat: number; lng: number; at: number };

export const geofences = pgTable("geofences", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").$type<GeofenceKind>().notNull(),
  geometry: jsonb("geometry").$type<GeofenceGeometry>().notNull(),
  radiusM: doublePrecision("radius_m"),
  locationId: uuid("location_id"),
  active: boolean("active").default(true).notNull(),
  dwellSeconds: integer("dwell_seconds").default(30).notNull(),
  color: text("color"),
  notes: text("notes"),
  geometryAt: timestamp("geometry_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const gpsTrackers = pgTable("gps_trackers", {
  deviceId: uuid("device_id").primaryKey(),
  status: text("status").$type<GpsTrackerStatus>().default("available").notNull(),
  statusAt: timestamp("status_at", { withTimezone: true }).defaultNow().notNull(),
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  lastAccuracyM: real("last_accuracy_m"),
  lastFixAt: timestamp("last_fix_at", { withTimezone: true }),
  rejectStreak: integer("reject_streak").default(0).notNull(),
  rejectLat: doublePrecision("reject_lat"),
  rejectLng: doublePrecision("reject_lng"),
  rejectAccuracyM: real("reject_accuracy_m"),
  rejectAt: timestamp("reject_at", { withTimezone: true }),
  recent: jsonb("recent").$type<RecentFix[]>().default([]).notNull(),
  batteryAlerted: boolean("battery_alerted").default(false).notNull(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const geofenceStates = pgTable(
  "geofence_states",
  {
    deviceId: uuid("device_id").notNull(),
    geofenceId: uuid("geofence_id").notNull(),
    inside: boolean("inside").notNull(),
    since: timestamp("since", { withTimezone: true }),
    pendingInside: boolean("pending_inside"),
    pendingSince: timestamp("pending_since", { withTimezone: true }),
    pendingLat: doublePrecision("pending_lat"),
    pendingLng: doublePrecision("pending_lng"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.geofenceId] })],
);

export const geofenceEvents = pgTable("geofence_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  geofenceId: uuid("geofence_id"),
  geofenceName: text("geofence_name").notNull(),
  locationId: uuid("location_id"),
  deviceId: uuid("device_id"),
  itemId: uuid("item_id"),
  unitId: uuid("unit_id"),
  shipmentIds: uuid("shipment_ids").array().default([]).notNull(),
  kind: text("kind").$type<"entered" | "exited">().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  auditId: bigint("audit_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const gpsTrackerLinks = pgTable("gps_tracker_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: uuid("device_id").notNull(),
  shipmentId: uuid("shipment_id"),
  vehicleLocationId: uuid("vehicle_location_id"),
  originGeofenceId: uuid("origin_geofence_id"),
  destinationGeofenceId: uuid("destination_geofence_id"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  assignedBy: text("assigned_by"),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"),
  endedBy: text("ended_by"),
});

export type Geofence = typeof geofences.$inferSelect;
export type GpsTracker = typeof gpsTrackers.$inferSelect;
export type GeofenceState = typeof geofenceStates.$inferSelect;
export type GeofenceEvent = typeof geofenceEvents.$inferSelect;
export type GpsTrackerLink = typeof gpsTrackerLinks.$inferSelect;
