import { pgTable, uuid, text, bigserial, bigint, timestamp } from "drizzle-orm/pg-core";

/**
 * Placement guidance. Mirrors server/migrations/0032_placement.sql;
 * docs/placement.md explains the model and services/placement/ holds the
 * logic.
 */

/** What a placement observation records. */
export const PLACEMENT_OUTCOMES = ["placed", "misplaced", "wrong_shipment", "wrong_job"] as const;
export type PlacementOutcome = (typeof PLACEMENT_OUTCOMES)[number];

export const placementRoomMap = pgTable("placement_room_map", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull(),
  originLocationId: uuid("origin_location_id").notNull(),
  destinationLocationId: uuid("destination_location_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const placementObservations = pgTable("placement_observations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  jobId: uuid("job_id").notNull(),
  jobItemId: uuid("job_item_id"),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  code: text("code"),
  outcome: text("outcome").$type<PlacementOutcome>().notNull(),
  expectedLocationId: uuid("expected_location_id"),
  actualLocationId: uuid("actual_location_id"),
  shipmentId: uuid("shipment_id"),
  otherJobId: uuid("other_job_id"),
  deviceId: uuid("device_id"),
  via: text("via").default("manual").notNull(),
  userOid: text("user_oid"),
  actor: text("actor"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const placementCursors = pgTable("placement_cursors", {
  name: text("name").primaryKey(),
  lastId: bigint("last_id", { mode: "number" }).default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PlacementRoomMapRow = typeof placementRoomMap.$inferSelect;
export type PlacementObservation = typeof placementObservations.$inferSelect;
