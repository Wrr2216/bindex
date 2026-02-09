import { eq, getTableColumns, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client";
import { companies, items, locations } from "../db/schema";
import { badRequest, notFound } from "../lib/errors";
import { locationCode } from "../lib/codes";
import { serialsForItems, type ContainerManifest, type ManifestContent } from "./items";

export type LocationInput = {
  name: string;
  address?: string | null;
  notes?: string | null;
  companyId?: string | null;
  parentId?: string | null;
};

/** Reject a parent assignment that would loop (a rack inside its own container). */
async function assertValidParent(id: string | null, parentId: string): Promise<void> {
  let cur: string | null = parentId;
  for (let depth = 0; cur && depth < 50; depth++) {
    if (cur === id) throw badRequest("A location cannot be placed inside itself.");
    const [row] = await db
      .select({ parentId: locations.parentId })
      .from(locations)
      .where(eq(locations.id, cur))
      .limit(1);
    if (!row) throw notFound("Parent location not found");
    cur = row.parentId;
  }
}


/** A location with the items currently assigned to it (its "contents"). */
export async function getLocationDetail(id: string) {
  const parent = alias(locations, "parent");
  const [loc] = await db
    .select({
      ...getTableColumns(locations),
      companyName: companies.name,
      parentName: parent.name,
    })
    .from(locations)
    .leftJoin(companies, eq(locations.companyId, companies.id))
    .leftJoin(parent, eq(locations.parentId, parent.id))
    .where(eq(locations.id, id))
    .limit(1);
  if (!loc) throw notFound("Location not found");

  // Sub-locations (e.g. containers 1A/1B/1C inside a rack), with item counts.
  const children = await db
    .select({
      id: locations.id,
      name: locations.name,
      itemCount: sql<number>`count(${items.id})::int`,
    })
    .from(locations)
    .leftJoin(items, eq(items.locationId, locations.id))
    .where(eq(locations.parentId, id))
    .groupBy(locations.id)
    .orderBy(locations.name);

  const rows = await db
    .select({
      id: items.id,
      name: items.name,
      brand: items.brand,
      model: items.model,
      assetCode: items.assetCode,
      quantity: items.quantity,
      flaggedMissing: items.flaggedMissing,
    })
    .from(items)
    .where(eq(items.locationId, id))
    .orderBy(items.name);

  const serials = await serialsForItems(rows.map((r) => r.id));
  const contents: ManifestContent[] = rows.map((r) => ({
    ...r,
    serials: serials.get(r.id) ?? [],
  }));
  const totalUnits = contents.reduce((n, c) => n + c.quantity, 0);
  return { ...loc, contents, itemCount: contents.length, totalUnits, children };
}

export type LocationDetail = Awaited<ReturnType<typeof getLocationDetail>>;

/** Build a printable contents-sheet manifest for a location (reuses the renderer). */
export async function getLocationManifest(id: string): Promise<ContainerManifest> {
  const d = await getLocationDetail(id);
  return {
    id: d.id,
    name: d.name,
    assetCode: "", // Locations have no asset code; the header skips the empty line.
    locationName: d.address ?? null,
    companyName: d.companyName ?? null,
    contents: d.contents,
  };
}

export const listLocations = () => {
  const parent = alias(locations, "parent");
  return db
    .select({
      ...getTableColumns(locations),
      companyName: companies.name,
      parentName: parent.name,
    })
    .from(locations)
    .leftJoin(companies, eq(locations.companyId, companies.id))
    .leftJoin(parent, eq(locations.parentId, parent.id))
    .orderBy(locations.name);
};

export async function createLocation(input: LocationInput) {
  if (input.parentId) await assertValidParent(null, input.parentId);
  const [row] = await db.insert(locations).values(input).returning();
  return row!;
}

export async function updateLocation(id: string, patch: Partial<LocationInput>) {
  if (patch.parentId) await assertValidParent(id, patch.parentId);
  const [row] = await db.update(locations).set(patch).where(eq(locations.id, id)).returning();
  if (!row) throw notFound("Location not found");
  return row;
}

export async function deleteLocation(id: string) {
  const deleted = await db.delete(locations).where(eq(locations.id, id)).returning({ id: locations.id });
  if (!deleted.length) throw notFound("Location not found");
}
