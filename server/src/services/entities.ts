import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { entities } from "../db/schema";
import { notFound } from "../lib/errors";

export type EntityInput = { name: string; kind?: string | null; notes?: string | null };

export const listEntities = () => db.select().from(entities).orderBy(asc(entities.name));

export async function createEntity(input: EntityInput) {
  const [row] = await db
    .insert(entities)
    .values({ name: input.name.trim(), kind: input.kind ?? null, notes: input.notes ?? null })
    .returning();
  return row!;
}

export async function updateEntity(id: string, patch: Partial<EntityInput>) {
  const [existing] = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  if (!existing) throw notFound("Entity not found");
  const [row] = await db
    .update(entities)
    .set({
      name: patch.name?.trim() ?? existing.name,
      kind: patch.kind === undefined ? existing.kind : patch.kind,
      notes: patch.notes === undefined ? existing.notes : patch.notes,
    })
    .where(eq(entities.id, id))
    .returning();
  return row!;
}

export async function deleteEntity(id: string) {
  // The foreign key is ON DELETE SET NULL, so items become unassigned.
  const del = await db.delete(entities).where(eq(entities.id, id)).returning({ id: entities.id });
  if (!del.length) throw notFound("Entity not found");
}
