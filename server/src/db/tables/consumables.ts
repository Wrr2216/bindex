import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  numeric,
  timestamp,
  date,
  primaryKey,
} from "drizzle-orm/pg-core";

// Quantities are numeric so a roll of wrap can be counted in feet or a half
// bundle of pads recorded. node-postgres returns numeric as a string; the
// consumables service converts at its boundary.

export type StockReason =
  | "receive"
  | "issue"
  | "return"
  | "transfer"
  | "consume"
  | "adjust"
  | "count";

export const consumableItems = pgTable("consumable_items", {
  itemId: uuid("item_id").primaryKey(),
  unit: text("unit").default("each").notNull(),
  reorderPoint: numeric("reorder_point", { precision: 14, scale: 3 }),
  reorderQty: numeric("reorder_qty", { precision: 14, scale: 3 }),
  supplier: text("supplier"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const stockLevels = pgTable(
  "stock_levels",
  {
    itemId: uuid("item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    qty: numeric("qty", { precision: 14, scale: 3 }).default("0").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.locationId] })],
);

export const stockMovements = pgTable("stock_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  reason: text("reason").$type<StockReason>().notNull(),
  qty: numeric("qty", { precision: 14, scale: 3 }).notNull(),
  fromLocationId: uuid("from_location_id"),
  toLocationId: uuid("to_location_id"),
  holderEntityId: uuid("holder_entity_id"),
  holderName: text("holder_name"),
  holderDelta: numeric("holder_delta", { precision: 14, scale: 3 }).default("0").notNull(),
  jobRef: text("job_ref"),
  note: text("note"),
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }),
  expectedQty: numeric("expected_qty", { precision: 14, scale: 3 }),
  countedQty: numeric("counted_qty", { precision: 14, scale: 3 }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const equipmentKits = pgTable("equipment_kits", {
  id: uuid("id").primaryKey().defaultRandom(),
  holderEntityId: uuid("holder_entity_id"),
  holderName: text("holder_name").notNull(),
  expectedReturnAt: timestamp("expected_return_at", { withTimezone: true }),
  jobRef: text("job_ref"),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const equipmentKitLines = pgTable("equipment_kit_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  kitId: uuid("kit_id").notNull(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  assignmentId: uuid("assignment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const consumableDigestRuns = pgTable("consumable_digest_runs", {
  day: date("day").primaryKey(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  lowCount: integer("low_count").default(0).notNull(),
});

export type ConsumableItem = typeof consumableItems.$inferSelect;
export type StockLevel = typeof stockLevels.$inferSelect;
export type StockMovement = typeof stockMovements.$inferSelect;
export type EquipmentKit = typeof equipmentKits.$inferSelect;
export type EquipmentKitLine = typeof equipmentKitLines.$inferSelect;
