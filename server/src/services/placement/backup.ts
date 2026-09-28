import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { db } from "../../db/client";
import * as schema from "../../db/schema";
import { placementObservations, placementRoomMap } from "../../db/schema";

/** The database or the restore's open transaction. */
type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

/**
 * Placement in the instance backup: each job's room map, and the
 * observations (which room a line was found in). The reader worker's cursor
 * is left out; after a restore it starts again from the newest sighting.
 *
 * Both tables hang off jobs with ON DELETE CASCADE, so clearing jobs before a
 * restore clears them too; they are restored after jobs are back.
 */

export const PLACEMENT_TABLES = ["placement_room_map", "placement_observations"] as const;
export type PlacementTable = (typeof PLACEMENT_TABLES)[number];

export async function exportPlacementTables(): Promise<Record<PlacementTable, Record<string, unknown>[]>> {
  const [map, observations] = await Promise.all([
    db.select().from(placementRoomMap),
    db.select().from(placementObservations),
  ]);
  return { placement_room_map: map, placement_observations: observations };
}

export async function restorePlacementTables(
  tx: Executor,
  data: Record<PlacementTable, Record<string, unknown>[]>,
): Promise<void> {
  for (let i = 0; i < data.placement_room_map.length; i += 500) {
    await tx.insert(placementRoomMap).values(data.placement_room_map.slice(i, i + 500) as never);
  }
  // Observation ids come from a sequence the restore would leave behind the
  // restored rows; new ids keep the next insert from colliding.
  const observations = data.placement_observations.map(({ id: _id, ...row }) => row);
  for (let i = 0; i < observations.length; i += 500) {
    await tx.insert(placementObservations).values(observations.slice(i, i + 500) as never);
  }
}
