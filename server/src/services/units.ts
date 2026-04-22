import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  itemUnits,
  items,
  locations,
  entities,
  itemAssignments,
} from "../db/schema";
import { genAssetCode } from "../lib/codes";
import { badRequest, isUniqueViolation, notFound } from "../lib/errors";

export type UnitInput = {
  label?: string | null;
  serial?: string | null;
  status?: string;
  valueCents?: number | null;
  locationId?: string | null;
  utilizedByEntityId?: string | null;
  notes?: string | null;
};

/** When units exist, roll up item.quantity (= count) and item.valueCents (= sum). */
async function syncRollups(itemId: string): Promise<void> {
  const rows = await db
    .select({
      n: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(value_cents), 0)::bigint`,
    })
    .from(itemUnits)
    .where(eq(itemUnits.itemId, itemId));
  const n = rows[0]?.n ?? 0;
  if (n > 0) {
    await db
      .update(items)
      .set({ quantity: n, valueCents: Number(rows[0]?.total ?? 0), updatedAt: new Date() })
      .where(eq(items.id, itemId));
  }
}

/**
 * Units of an item, with location/entity names resolved and the unit's open
 * check-out (if any). The assignments table is queried directly rather than
 * through ./assignments so that units, assignments and items do not import in a cycle;
 * the partial unique index guarantees at most one open row per unit, so the
 * join can't multiply rows.
 */
export function listUnits(itemId: string) {
  return db
    .select({
      id: itemUnits.id,
      itemId: itemUnits.itemId,
      assetCode: itemUnits.assetCode,
      label: itemUnits.label,
      serial: itemUnits.serial,
      status: itemUnits.status,
      valueCents: itemUnits.valueCents,
      locationId: itemUnits.locationId,
      utilizedByEntityId: itemUnits.utilizedByEntityId,
      notes: itemUnits.notes,
      createdAt: itemUnits.createdAt,
      locationName: locations.name,
      utilizedByEntityName: entities.name,
      assignmentId: itemAssignments.id,
      assignmentEntityId: itemAssignments.entityId,
      assignmentEntityName: itemAssignments.entityName,
      assignmentCheckedOutAt: itemAssignments.checkedOutAt,
      assignmentNote: itemAssignments.note,
    })
    .from(itemUnits)
    .leftJoin(locations, eq(itemUnits.locationId, locations.id))
    .leftJoin(entities, eq(itemUnits.utilizedByEntityId, entities.id))
    .leftJoin(
      itemAssignments,
      and(eq(itemAssignments.unitId, itemUnits.id), isNull(itemAssignments.checkedInAt)),
    )
    .where(eq(itemUnits.itemId, itemId))
    .orderBy(asc(itemUnits.createdAt))
    .then((rows) =>
      rows.map(
        ({
          assignmentId,
          assignmentEntityId,
          assignmentEntityName,
          assignmentCheckedOutAt,
          assignmentNote,
          ...unit
        }) => ({
          ...unit,
          assignment: assignmentId
            ? {
                id: assignmentId,
                entityId: assignmentEntityId,
                entityName: assignmentEntityName!,
                checkedOutAt: assignmentCheckedOutAt!,
                note: assignmentNote,
              }
            : null,
        }),
      ),
    );
}

const serialTaken = (err: unknown) => isUniqueViolation(err, "uq_item_units_serial");
const codeTaken = (err: unknown) => isUniqueViolation(err, "uq_item_units_asset_code");

const clean = (s: string | null | undefined) => s?.trim() || null;

export async function addUnit(itemId: string, input: UnitInput) {
  // The DB trigger already picks a code free across items + units; retry only
  // covers the race where two inserts land on the same code concurrently.
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await db
        .insert(itemUnits)
        .values({
          itemId,
          assetCode: genAssetCode(),
          label: clean(input.label),
          serial: clean(input.serial),
          status: input.status ?? "active",
          valueCents: input.valueCents ?? null,
          locationId: input.locationId ?? null,
          utilizedByEntityId: input.utilizedByEntityId ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      await syncRollups(itemId);
      return row!;
    } catch (err) {
      if (serialTaken(err)) throw badRequest("That serial is already assigned to another unit.");
      if (codeTaken(err) && attempt < 4) continue;
      throw err;
    }
  }
}

export async function updateUnit(unitId: string, patch: UnitInput): Promise<string> {
  const [existing] = await db.select().from(itemUnits).where(eq(itemUnits.id, unitId)).limit(1);
  if (!existing) throw notFound("Unit not found");
  try {
    await db
      .update(itemUnits)
      .set({
        label: patch.label === undefined ? existing.label : clean(patch.label),
        serial: patch.serial === undefined ? existing.serial : clean(patch.serial),
        status: patch.status ?? existing.status,
        valueCents: patch.valueCents === undefined ? existing.valueCents : patch.valueCents,
        locationId: patch.locationId === undefined ? existing.locationId : patch.locationId,
        utilizedByEntityId:
          patch.utilizedByEntityId === undefined
            ? existing.utilizedByEntityId
            : patch.utilizedByEntityId,
        notes: patch.notes === undefined ? existing.notes : patch.notes,
        updatedAt: new Date(),
      })
      .where(eq(itemUnits.id, unitId));
  } catch (err) {
    if (serialTaken(err)) throw badRequest("That serial is already assigned to another unit.");
    throw err;
  }
  await syncRollups(existing.itemId);
  return existing.itemId;
}

export async function deleteUnit(unitId: string): Promise<string> {
  const [existing] = await db
    .select({ itemId: itemUnits.itemId })
    .from(itemUnits)
    .where(eq(itemUnits.id, unitId))
    .limit(1);
  if (!existing) throw notFound("Unit not found");
  await db.delete(itemUnits).where(eq(itemUnits.id, unitId));
  await syncRollups(existing.itemId);
  return existing.itemId;
}

/** Resolve a scanned code to a unit by serial. */
export async function findUnitBySerial(code: string) {
  const [row] = await db
    .select({ id: itemUnits.id, itemId: itemUnits.itemId })
    .from(itemUnits)
    .where(eq(itemUnits.serial, code))
    .limit(1);
  return row ?? null;
}

/** Resolve a scanned code to a unit by its printed per-unit asset code. */
export async function findUnitByAssetCode(code: string) {
  const [row] = await db
    .select({ id: itemUnits.id, itemId: itemUnits.itemId })
    .from(itemUnits)
    .where(eq(itemUnits.assetCode, code))
    .limit(1);
  return row ?? null;
}

/** Map unit asset codes to item ids, for the batched verify and audit paths. */
export async function unitItemIdsByAssetCode(codes: string[]) {
  if (!codes.length) return [];
  return db
    .select({ assetCode: itemUnits.assetCode, itemId: itemUnits.itemId })
    .from(itemUnits)
    .where(inArray(itemUnits.assetCode, codes));
}

/** Everything a per-unit label needs: the item it belongs to plus its position. */
export type UnitLabelInfo = {
  id: string;
  itemId: string;
  itemName: string;
  assetCode: string;
  label: string | null;
  serial: string | null;
  locationName: string | null;
  index: number; // 1-based position among the item's units, oldest first
  total: number;
};

export async function getUnitLabelInfo(unitId: string): Promise<UnitLabelInfo> {
  const [unit] = await db
    .select({
      id: itemUnits.id,
      itemId: itemUnits.itemId,
      assetCode: itemUnits.assetCode,
      label: itemUnits.label,
      serial: itemUnits.serial,
      itemName: items.name,
      unitLocationName: locations.name,
    })
    .from(itemUnits)
    .innerJoin(items, eq(itemUnits.itemId, items.id))
    .leftJoin(locations, eq(itemUnits.locationId, locations.id))
    .where(eq(itemUnits.id, unitId))
    .limit(1);
  if (!unit) throw notFound("Unit not found");

  const siblings = await db
    .select({ id: itemUnits.id, locationId: itemUnits.locationId })
    .from(itemUnits)
    .where(eq(itemUnits.itemId, unit.itemId))
    .orderBy(asc(itemUnits.createdAt));
  const index = siblings.findIndex((s) => s.id === unit.id) + 1;

  // Fall back to the item's location when the unit doesn't override it.
  let locationName = unit.unitLocationName;
  if (!locationName) {
    const [row] = await db
      .select({ name: locations.name })
      .from(items)
      .leftJoin(locations, eq(items.locationId, locations.id))
      .where(eq(items.id, unit.itemId))
      .limit(1);
    locationName = row?.name ?? null;
  }

  return {
    id: unit.id,
    itemId: unit.itemId,
    itemName: unit.itemName,
    assetCode: unit.assetCode,
    label: unit.label,
    serial: unit.serial,
    locationName,
    index: index || 1,
    total: siblings.length || 1,
  };
}

/** The sub-line printed on a unit label: its label, else serial, else position. */
export const unitSubLine = (u: UnitLabelInfo): string =>
  u.label?.trim() || u.serial?.trim() || `Unit ${u.index} of ${u.total}`;
