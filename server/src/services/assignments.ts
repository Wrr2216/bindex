import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { items, itemUnits, entities, itemAssignments } from "../db/schema";
import { badRequest, notFound } from "../lib/errors";
import { recordEvent } from "./items";

/** Assign an item to an entity. Auto-returns any currently-open assignment. */
export async function checkOut(
  itemId: string,
  entityId: string,
  userOid: string | null,
  note?: string | null,
): Promise<void> {
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, itemId)).limit(1);
  if (!item) throw notFound("Item not found");
  const [entity] = await db.select().from(entities).where(eq(entities.id, entityId)).limit(1);
  if (!entity) throw badRequest("Entity not found");

  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(itemAssignments)
      .set({ checkedInAt: now, checkedInBy: userOid })
      .where(
        and(
          eq(itemAssignments.itemId, itemId),
          isNull(itemAssignments.unitId),
          isNull(itemAssignments.checkedInAt),
        ),
      );
    await tx.insert(itemAssignments).values({
      itemId,
      entityId,
      entityName: entity.name,
      checkedOutBy: userOid,
      note: note ?? null,
    });
    await tx.update(items).set({ utilizedByEntityId: entityId, updatedAt: now }).where(eq(items.id, itemId));
  });

  await recordEvent(itemId, userOid, "updated", { action: "checked_out", entity: entity.name });
}

/** Return the item: closes the open assignment and clears the current holder. */
export async function checkIn(
  itemId: string,
  userOid: string | null,
  note?: string | null,
): Promise<void> {
  const [open] = await db
    .select()
    .from(itemAssignments)
    .where(
      and(
        eq(itemAssignments.itemId, itemId),
        isNull(itemAssignments.unitId),
        isNull(itemAssignments.checkedInAt),
      ),
    )
    .limit(1);
  if (!open) throw badRequest("Item is not checked out.");

  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(itemAssignments)
      .set({ checkedInAt: now, checkedInBy: userOid, note: note ?? open.note })
      .where(eq(itemAssignments.id, open.id));
    await tx.update(items).set({ utilizedByEntityId: null, updatedAt: now }).where(eq(items.id, itemId));
  });

  await recordEvent(itemId, userOid, "updated", { action: "checked_in", entity: open.entityName });
}

/** Item-level assignment history. Unit assignments are listed on their unit. */
export const listAssignments = (itemId: string) =>
  db
    .select()
    .from(itemAssignments)
    .where(and(eq(itemAssignments.itemId, itemId), isNull(itemAssignments.unitId)))
    .orderBy(desc(itemAssignments.checkedOutAt))
    .limit(50);

/** Check one physical unit out to an entity. Auto-returns its open assignment. */
export async function checkOutUnit(
  unitId: string,
  entityId: string,
  userOid: string | null,
  note?: string | null,
): Promise<string> {
  const [unit] = await db
    .select({ id: itemUnits.id, itemId: itemUnits.itemId, assetCode: itemUnits.assetCode })
    .from(itemUnits)
    .where(eq(itemUnits.id, unitId))
    .limit(1);
  if (!unit) throw notFound("Unit not found");
  const [entity] = await db.select().from(entities).where(eq(entities.id, entityId)).limit(1);
  if (!entity) throw badRequest("Entity not found");

  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(itemAssignments)
      .set({ checkedInAt: now, checkedInBy: userOid })
      .where(and(eq(itemAssignments.unitId, unitId), isNull(itemAssignments.checkedInAt)));
    await tx.insert(itemAssignments).values({
      itemId: unit.itemId,
      unitId,
      entityId,
      entityName: entity.name,
      checkedOutBy: userOid,
      note: note ?? null,
    });
    await tx
      .update(itemUnits)
      .set({ utilizedByEntityId: entityId, updatedAt: now })
      .where(eq(itemUnits.id, unitId));
  });

  await recordEvent(unit.itemId, userOid, "updated", {
    action: "unit_checked_out",
    unit: unit.assetCode,
    entity: entity.name,
  });
  return unit.itemId;
}

/** Return one unit: closes its open assignment and clears its holder. */
export async function checkInUnit(
  unitId: string,
  userOid: string | null,
  note?: string | null,
): Promise<string> {
  const [open] = await db
    .select()
    .from(itemAssignments)
    .where(and(eq(itemAssignments.unitId, unitId), isNull(itemAssignments.checkedInAt)))
    .limit(1);
  if (!open) throw badRequest("This unit is not checked out.");

  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(itemAssignments)
      .set({ checkedInAt: now, checkedInBy: userOid, note: note ?? open.note })
      .where(eq(itemAssignments.id, open.id));
    await tx
      .update(itemUnits)
      .set({ utilizedByEntityId: null, updatedAt: now })
      .where(eq(itemUnits.id, unitId));
  });

  await recordEvent(open.itemId, userOid, "updated", {
    action: "unit_checked_in",
    entity: open.entityName,
  });
  return open.itemId;
}
