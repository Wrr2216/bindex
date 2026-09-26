import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { itemEvents, itemUnits, items } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";

/**
 * Notes a crew member writes against an item in the field. They live in the
 * item's history, so they sit alongside every other change, and keep the time
 * they were written: a note made in a dead zone can reach the server hours
 * later.
 */

export type FieldNote = {
  id: string;
  itemId: string;
  unitId: string | null;
  text: string;
  writtenAt: string;
  createdAt: string;
  userOid: string | null;
};

export async function addFieldNote(input: {
  itemId: string;
  unitId?: string | null;
  text: string;
  writtenAt?: string | null;
  userOid: string | null;
}): Promise<FieldNote> {
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, input.itemId)).limit(1);
  if (!item) throw notFound("Item not found");
  if (input.unitId) {
    const [unit] = await db
      .select({ id: itemUnits.id })
      .from(itemUnits)
      .where(and(eq(itemUnits.id, input.unitId), eq(itemUnits.itemId, input.itemId)))
      .limit(1);
    if (!unit) throw badRequest("That unit does not belong to this item.");
  }
  const writtenAt = input.writtenAt ? new Date(input.writtenAt) : new Date();
  // A device clock can be wrong; a time in the future would sort the note
  // above things that really happened after it.
  const when = writtenAt.getTime() > Date.now() ? new Date() : writtenAt;
  const text = input.text.trim();

  // The same row recordEvent writes, inserted here so the new note comes back.
  const [row] = await db
    .insert(itemEvents)
    .values({
      itemId: input.itemId,
      userOid: input.userOid,
      action: "updated",
      detail: { fieldNote: text, unitId: input.unitId ?? null, writtenAt: when.toISOString() },
    })
    .returning();
  return toNote(row!);
}

function toNote(row: typeof itemEvents.$inferSelect): FieldNote {
  const d = row.detail as { fieldNote?: string; unitId?: string | null; writtenAt?: string };
  return {
    id: row.id,
    itemId: row.itemId!,
    unitId: d.unitId ?? null,
    text: d.fieldNote ?? "",
    writtenAt: d.writtenAt ?? row.createdAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    userOid: row.userOid,
  };
}

export async function listFieldNotes(itemId: string): Promise<FieldNote[]> {
  const rows = await db
    .select()
    .from(itemEvents)
    .where(and(eq(itemEvents.itemId, itemId), sql`${itemEvents.detail}->>'fieldNote' IS NOT NULL`))
    .orderBy(desc(itemEvents.createdAt))
    .limit(50);
  return rows.map(toNote);
}
