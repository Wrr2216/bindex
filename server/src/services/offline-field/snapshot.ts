import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { itemAssignments, itemIdentifiers, itemUnits, items, locations } from "../../db/schema";
import { env } from "../../env";
import { badRequest, notFound } from "../../lib/errors";
import { listLocations } from "../locations";
import { listEntities } from "../entities";
import { listCompanies } from "../companies";

/**
 * The copy of the inventory a device takes offline.
 *
 * Scoped to a location and everything below it (sub-locations, containers
 * inside, and what those containers hold), or to the whole instance when that
 * is small enough. Items come with what scanning, moving and checking out need
 * offline: identifiers, units and open check-outs. Locations, holders and
 * groups come whole, because pickers need every choice and they are small.
 *
 * History and photos stay on the server.
 */

/** The ids of every item in scope, as a subquery. */
function scopeIds(locationId: string | null): SQL {
  if (!locationId) {
    return sql`(SELECT id FROM items WHERE category IS DISTINCT FROM 'Domain')`;
  }
  // UNION rather than UNION ALL: a parent loop in bad data ends instead of
  // recursing forever.
  return sql`(
    WITH RECURSIVE locs AS (
      SELECT id FROM locations WHERE id = ${locationId}
      UNION
      SELECT l.id FROM locations l JOIN locs ON l.parent_id = locs.id
    ), tree AS (
      SELECT id FROM items WHERE location_id IN (SELECT id FROM locs)
      UNION
      SELECT item_id FROM item_units WHERE location_id IN (SELECT id FROM locs)
      UNION
      SELECT i.id FROM items i JOIN tree ON i.parent_item_id = tree.id
    )
    SELECT t.id FROM tree t JOIN items i ON i.id = t.id
     WHERE i.category IS DISTINCT FROM 'Domain'
  )`;
}

export async function buildSnapshot(opts: { locationId?: string | null }) {
  const locationId = opts.locationId ?? null;
  let scopeName = "Everything";
  if (locationId) {
    const [loc] = await db
      .select({ name: locations.name })
      .from(locations)
      .where(eq(locations.id, locationId))
      .limit(1);
    if (!loc) throw notFound("Location not found");
    scopeName = loc.name;
  }

  const scope = scopeIds(locationId);
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(inArray(items.id, scope))) as [{ n: number }];
  if (n > env.OFFLINE_SNAPSHOT_MAX_ITEMS) {
    throw badRequest(
      `That is ${n} items, more than the ${env.OFFLINE_SNAPSHOT_MAX_ITEMS} one device may take offline at once. ` +
        "Pick a smaller location, or raise OFFLINE_SNAPSHOT_MAX_ITEMS.",
    );
  }

  const [itemRows, identifiers, units, openAssignments, allLocations, entities, companies] =
    await Promise.all([
      db.select().from(items).where(inArray(items.id, scope)).orderBy(asc(items.name)),
      db.select().from(itemIdentifiers).where(inArray(itemIdentifiers.itemId, scope)),
      db
        .select({
          unit: itemUnits,
          assignmentId: itemAssignments.id,
          assignmentEntityId: itemAssignments.entityId,
          assignmentEntityName: itemAssignments.entityName,
          assignmentCheckedOutAt: itemAssignments.checkedOutAt,
          assignmentNote: itemAssignments.note,
        })
        .from(itemUnits)
        .leftJoin(
          itemAssignments,
          and(eq(itemAssignments.unitId, itemUnits.id), isNull(itemAssignments.checkedInAt)),
        )
        .where(inArray(itemUnits.itemId, scope))
        .orderBy(asc(itemUnits.createdAt)),
      // Only open item-level check-outs: enough to show and change who has it.
      db
        .select()
        .from(itemAssignments)
        .where(
          and(
            inArray(itemAssignments.itemId, scope),
            isNull(itemAssignments.unitId),
            isNull(itemAssignments.checkedInAt),
          ),
        ),
      listLocations(),
      listEntities(),
      listCompanies(),
    ]);

  const idsByItem = new Map<string, (typeof identifiers)[number][]>();
  for (const row of identifiers) {
    const list = idsByItem.get(row.itemId) ?? [];
    list.push(row);
    idsByItem.set(row.itemId, list);
  }
  const unitsByItem = new Map<string, unknown[]>();
  for (const r of units) {
    const list = unitsByItem.get(r.unit.itemId) ?? [];
    list.push({
      ...r.unit,
      assignment: r.assignmentId
        ? {
            id: r.assignmentId,
            entityId: r.assignmentEntityId,
            entityName: r.assignmentEntityName,
            checkedOutAt: r.assignmentCheckedOutAt,
            note: r.assignmentNote,
          }
        : null,
    });
    unitsByItem.set(r.unit.itemId, list);
  }
  const assignmentsByItem = new Map<string, (typeof openAssignments)[number][]>();
  for (const row of openAssignments) {
    const list = assignmentsByItem.get(row.itemId) ?? [];
    list.push(row);
    assignmentsByItem.set(row.itemId, list);
  }

  return {
    generatedAt: new Date().toISOString(),
    scope: { locationId, name: scopeName },
    items: itemRows.map((item) => ({
      ...item,
      identifiers: idsByItem.get(item.id) ?? [],
      units: unitsByItem.get(item.id) ?? [],
      assignments: assignmentsByItem.get(item.id) ?? [],
      images: [],
    })),
    locations: allLocations,
    entities,
    companies,
  };
}

export type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;
