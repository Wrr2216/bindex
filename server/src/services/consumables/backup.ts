import { db } from "../../db/client";
import {
  consumableItems,
  entities,
  equipmentKitLines,
  equipmentKits,
  itemAssignments,
  items,
  itemUnits,
  locations,
  stockLevels,
  stockMovements,
} from "../../db/schema";
import type { Tx } from "./stock";

/**
 * Consumables in the JSON backup. Kept here so the shared backup module only
 * needs a line to include them: one spread when writing, one call when
 * restoring.
 */

export const CONSUMABLE_TABLES = [
  "consumable_items",
  "stock_levels",
  "stock_movements",
  "equipment_kits",
  "equipment_kit_lines",
] as const;
type ConsumableTable = (typeof CONSUMABLE_TABLES)[number];
type Rows = Record<string, unknown>[];

export async function consumablesBackupData(): Promise<Record<ConsumableTable, Rows>> {
  const [ci, sl, sm, ek, ekl] = await Promise.all([
    db.select().from(consumableItems),
    db.select().from(stockLevels),
    db.select().from(stockMovements),
    db.select().from(equipmentKits),
    db.select().from(equipmentKitLines),
  ]);
  return {
    consumable_items: ci,
    stock_levels: sl,
    stock_movements: sm,
    equipment_kits: ek,
    equipment_kit_lines: ekl,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Put consumables back after the core tables have been restored. Runs inside
 * the restore transaction, last, because kit lines point at assignments.
 * Anything that points at a row the snapshot no longer has is dropped or
 * unlinked rather than failing the whole restore.
 */
export async function restoreConsumables(tx: Tx, d: Record<ConsumableTable, Rows>): Promise<void> {
  // Deleting items already cascaded most of this away; kits hang off holders,
  // which only unlink, so clear everything explicitly.
  await tx.delete(equipmentKitLines);
  await tx.delete(equipmentKits);
  await tx.delete(stockMovements);
  await tx.delete(stockLevels);
  await tx.delete(consumableItems);

  const ids = async (q: Promise<{ id: string }[]>) => new Set((await q).map((r) => r.id));
  const [itemIds, locationIds, entityIds, unitIds, assignmentIds] = await Promise.all([
    ids(tx.select({ id: items.id }).from(items)),
    ids(tx.select({ id: locations.id }).from(locations)),
    ids(tx.select({ id: entities.id }).from(entities)),
    ids(tx.select({ id: itemUnits.id }).from(itemUnits)),
    ids(tx.select({ id: itemAssignments.id }).from(itemAssignments)),
  ]);
  const keep = (set: Set<string>, v: unknown) => (typeof v === "string" && set.has(v) ? v : null);

  const ci = d.consumable_items.filter((r) => itemIds.has(r.itemId as string));
  const sl = d.stock_levels.filter(
    (r) => itemIds.has(r.itemId as string) && locationIds.has(r.locationId as string),
  );
  const sm = d.stock_movements
    .filter((r) => itemIds.has(r.itemId as string))
    .map((r) => ({
      ...r,
      fromLocationId: keep(locationIds, r.fromLocationId),
      toLocationId: keep(locationIds, r.toLocationId),
      holderEntityId: keep(entityIds, r.holderEntityId),
    }));
  const ek = d.equipment_kits.map((r) => ({ ...r, holderEntityId: keep(entityIds, r.holderEntityId) }));
  const kitIds = new Set(d.equipment_kits.map((r) => r.id as string));
  const ekl = d.equipment_kit_lines
    .filter(
      (r) =>
        kitIds.has(r.kitId as string) &&
        itemIds.has(r.itemId as string) &&
        (r.unitId == null || unitIds.has(r.unitId as string)),
    )
    .map((r) => ({ ...r, assignmentId: keep(assignmentIds, r.assignmentId) }));

  for (const part of chunk(ci, 500)) await tx.insert(consumableItems).values(part as never);
  for (const part of chunk(sl, 500)) await tx.insert(stockLevels).values(part as never);
  for (const part of chunk(sm, 500)) await tx.insert(stockMovements).values(part as never);
  for (const part of chunk(ek, 500)) await tx.insert(equipmentKits).values(part as never);
  for (const part of chunk(ekl, 500)) await tx.insert(equipmentKitLines).values(part as never);
}
