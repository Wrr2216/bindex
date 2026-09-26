import { pool } from "../../db/client";
import { badRequest, notFound } from "../../lib/errors";
import type { LocationRole } from "../../db/schema";

/**
 * Location profiles: the few facts about a place that only operations
 * insights need. Zones get a distance to the dock (slotting) and coordinates
 * (impossible travel); vehicles get what they can carry (load planning).
 */

export const LOCATION_ROLES: readonly LocationRole[] = ["dock", "pick", "storage", "staging", "vehicle"];

export type ProfileInput = {
  role?: LocationRole | null;
  distanceToDockM?: number | null;
  lat?: number | null;
  lng?: number | null;
  maxKg?: number | null;
  maxM3?: number | null;
  interiorLengthM?: number | null;
  interiorWidthM?: number | null;
  interiorHeightM?: number | null;
  notes?: string | null;
};

export type ProfileView = Required<ProfileInput> & {
  locationId: string;
  locationName: string;
  parentId: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

const num = (v: unknown): number | null => (v == null ? null : Number(v));

function view(r: Record<string, unknown>): ProfileView {
  return {
    locationId: r.location_id as string,
    locationName: r.location_name as string,
    parentId: (r.parent_id as string) ?? null,
    role: (r.role as LocationRole) ?? null,
    distanceToDockM: num(r.distance_to_dock_m),
    lat: num(r.lat),
    lng: num(r.lng),
    maxKg: num(r.max_kg),
    maxM3: num(r.max_m3),
    interiorLengthM: num(r.interior_length_m),
    interiorWidthM: num(r.interior_width_m),
    interiorHeightM: num(r.interior_height_m),
    notes: (r.notes as string) ?? null,
    updatedAt: new Date(r.updated_at as string).toISOString(),
    updatedBy: (r.updated_by as string) ?? null,
  };
}

const SELECT = `
  SELECT p.*, l.name AS location_name, l.parent_id
    FROM ops_location_profiles p JOIN locations l ON l.id = p.location_id`;

export async function listProfiles(): Promise<ProfileView[]> {
  const { rows } = await pool.query(`${SELECT} ORDER BY l.name`);
  return rows.map(view);
}

export async function getProfile(locationId: string): Promise<ProfileView | null> {
  const { rows } = await pool.query(`${SELECT} WHERE p.location_id = $1`, [locationId]);
  return rows[0] ? view(rows[0]) : null;
}

const COLUMNS: [keyof ProfileInput, string][] = [
  ["role", "role"],
  ["distanceToDockM", "distance_to_dock_m"],
  ["lat", "lat"],
  ["lng", "lng"],
  ["maxKg", "max_kg"],
  ["maxM3", "max_m3"],
  ["interiorLengthM", "interior_length_m"],
  ["interiorWidthM", "interior_width_m"],
  ["interiorHeightM", "interior_height_m"],
  ["notes", "notes"],
];

/**
 * Create or change a profile. Fields left out keep their value; null clears
 * one. A profile with nothing left in it is removed.
 */
export async function saveProfile(locationId: string, input: ProfileInput, userOid: string | null): Promise<ProfileView | null> {
  const loc = await pool.query("SELECT 1 FROM locations WHERE id = $1", [locationId]);
  if (!loc.rows[0]) throw notFound("That place does not exist.");
  const current = await getProfile(locationId);
  const next: Record<string, unknown> = {};
  for (const [field] of COLUMNS) {
    next[field] = input[field] !== undefined ? input[field] : current ? current[field] : null;
  }
  if ((next.lat === null) !== (next.lng === null)) {
    throw badRequest("Give both latitude and longitude, or neither.");
  }
  if (COLUMNS.every(([field]) => next[field] === null || next[field] === "")) {
    await deleteProfile(locationId);
    return null;
  }
  const values = COLUMNS.map(([field]) => next[field] ?? null);
  await pool.query(
    `INSERT INTO ops_location_profiles (location_id, ${COLUMNS.map(([, c]) => c).join(", ")}, updated_by, updated_at)
     VALUES ($1, ${COLUMNS.map((_, i) => `$${i + 2}`).join(", ")}, $${COLUMNS.length + 2}, now())
     ON CONFLICT (location_id) DO UPDATE SET
       ${COLUMNS.map(([, c]) => `${c} = excluded.${c}`).join(", ")},
       updated_by = excluded.updated_by, updated_at = now()`,
    [locationId, ...values, userOid],
  );
  return getProfile(locationId);
}

export async function deleteProfile(locationId: string): Promise<void> {
  await pool.query("DELETE FROM ops_location_profiles WHERE location_id = $1", [locationId]);
}
