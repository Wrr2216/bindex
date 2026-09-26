import { pool } from "../../db/client";
import { getConfig } from "../config";
import { planSync, referencedIds, type PlanAction, type PlanResult, type World } from "./plan";

/** An open check-out's holder: its id, "unknown" when that holder was deleted. */
const holderOf = (entityId: string | null) => entityId ?? "unknown";

/**
 * Load the server's current state for everything a queue refers to, in a fixed
 * number of queries however long the queue is.
 */
export async function loadWorld(actions: PlanAction[]): Promise<World> {
  const ids = referencedIds(actions);
  const [items, itemHolders, units, unitHolders, locations, entities] = await Promise.all([
    // Where each record is now, named, so a conflict can say where it went.
    pool.query<{
      id: string;
      name: string;
      location_id: string | null;
      location_name: string | null;
      parent_item_id: string | null;
      parent_name: string | null;
    }>(
      `SELECT i.id, i.name, i.location_id, l.name AS location_name,
              i.parent_item_id, p.name AS parent_name
         FROM items i
         LEFT JOIN locations l ON l.id = i.location_id
         LEFT JOIN items p ON p.id = i.parent_item_id
        WHERE i.id = ANY($1::uuid[])`,
      [ids.items],
    ),
    pool.query<{ item_id: string; entity_id: string | null; entity_name: string }>(
      `SELECT item_id, entity_id, entity_name FROM item_assignments
        WHERE item_id = ANY($1::uuid[]) AND unit_id IS NULL AND checked_in_at IS NULL`,
      [ids.items],
    ),
    pool.query<{
      id: string;
      item_id: string;
      label: string | null;
      asset_code: string;
      location_id: string | null;
      location_name: string | null;
    }>(
      `SELECT u.id, u.item_id, u.label, u.asset_code, u.location_id, l.name AS location_name
         FROM item_units u
         LEFT JOIN locations l ON l.id = u.location_id
        WHERE u.id = ANY($1::uuid[])`,
      [ids.units],
    ),
    pool.query<{ unit_id: string; entity_id: string | null; entity_name: string }>(
      `SELECT unit_id, entity_id, entity_name FROM item_assignments
        WHERE unit_id = ANY($1::uuid[]) AND checked_in_at IS NULL`,
      [ids.units],
    ),
    pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM locations WHERE id = ANY($1::uuid[])`,
      [ids.locations],
    ),
    pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM entities WHERE id = ANY($1::uuid[])`,
      [ids.entities],
    ),
  ]);

  const openByItem = new Map(itemHolders.rows.map((r) => [r.item_id, r]));
  const openByUnit = new Map(unitHolders.rows.map((r) => [r.unit_id, r]));
  const knownLocations = new Map(locations.rows.map((r) => [r.id, { name: r.name }]));
  for (const r of [...items.rows, ...units.rows]) {
    if (r.location_id && r.location_name) knownLocations.set(r.location_id, { name: r.location_name });
  }

  return {
    items: new Map(
      items.rows.map((r) => {
        const open = openByItem.get(r.id);
        return [
          r.id,
          {
            name: r.name,
            locationId: r.location_id,
            parentItemId: r.parent_item_id,
            parentName: r.parent_name,
            holderId: open ? holderOf(open.entity_id) : null,
            holderName: open?.entity_name ?? null,
          },
        ];
      }),
    ),
    units: new Map(
      units.rows.map((r) => {
        const open = openByUnit.get(r.id);
        return [
          r.id,
          {
            itemId: r.item_id,
            name: r.label ?? r.asset_code,
            locationId: r.location_id,
            holderId: open ? holderOf(open.entity_id) : null,
            holderName: open?.entity_name ?? null,
          },
        ];
      }),
    ),
    locations: knownLocations,
    entities: new Map(entities.rows.map((r) => [r.id, { name: r.name }])),
  };
}

/** Plan a device's queue against the current state, in the instance's words. */
export async function planQueue(actions: PlanAction[]): Promise<PlanResult[]> {
  const [world, config] = await Promise.all([loadWorld(actions), getConfig()]);
  return planSync(actions, world, {
    item: config.terms.item.singular.toLowerCase(),
    items: config.terms.item.plural.toLowerCase(),
    location: config.terms.location.singular.toLowerCase(),
  });
}
