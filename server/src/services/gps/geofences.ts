import { asc, eq, inArray } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { geofenceStates, geofences, locations, type Geofence, type GeofenceKind } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { actorFromOid, publish } from "../event-backbone";
import { geofenceSubject } from "./events";
import { compileFence, GeometryError, normalizeGeometry, type CompiledFence } from "./fence";

/**
 * Geofence records and the in-memory set the ingest tests fixes against.
 * Fences are read on every GPS batch, so the compiled set is cached and
 * rebuilt when this process changes a fence, or after CACHE_MS for changes
 * made by another replica.
 */

export type GeofenceInput = {
  name: string;
  kind: GeofenceKind;
  geometry: unknown;
  radiusM?: number | null;
  locationId?: string | null;
  active?: boolean;
  dwellSeconds?: number;
  color?: string | null;
  notes?: string | null;
};

export type GeofenceView = Geofence & { locationName: string | null; areaM2: number };

/** Who changed a fence. */
export type FenceActor = { userOid: string | null; name?: string | null };

/** What an audit entry says about a fence: enough to redraw it. */
const described = (f: Geofence) => ({
  name: f.name,
  kind: f.kind,
  geometry: f.geometry,
  radiusM: f.radiusM,
  locationId: f.locationId,
  active: f.active,
  dwellSeconds: f.dwellSeconds,
});

const CACHE_MS = 30_000;
let cache: { at: number; fences: CompiledFence[] } | null = null;

export function invalidateFences(): void {
  cache = null;
}

/** Every active fence, compiled. A stored fence that no longer compiles is skipped and logged. */
export async function activeFences(now = Date.now()): Promise<CompiledFence[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.fences;
  const rows = await db.select().from(geofences).where(eq(geofences.active, true));
  const fences: CompiledFence[] = [];
  for (const row of rows) {
    try {
      fences.push(compileFence(row));
    } catch (err) {
      logger.warn("gps.geofence.invalid", { id: row.id, err: String(err) });
    }
  }
  cache = { at: now, fences };
  return fences;
}

async function views(rows: Geofence[]): Promise<GeofenceView[]> {
  const locIds = [...new Set(rows.map((r) => r.locationId).filter((v): v is string => !!v))];
  const locs = locIds.length
    ? await db.select({ id: locations.id, name: locations.name }).from(locations).where(inArray(locations.id, locIds))
    : [];
  const name = new Map(locs.map((l) => [l.id, l.name]));
  return rows.map((r) => {
    let areaM2 = 0;
    try {
      areaM2 = compileFence(r).areaM2;
    } catch {
      // Shown with no area; the editor lets someone redraw it.
    }
    return { ...r, locationName: r.locationId ? (name.get(r.locationId) ?? null) : null, areaM2 };
  });
}

export async function listGeofences(opts: { includeInactive?: boolean } = {}): Promise<GeofenceView[]> {
  const rows = await db
    .select()
    .from(geofences)
    .where(opts.includeInactive ? undefined : eq(geofences.active, true))
    .orderBy(asc(geofences.name));
  return views(rows);
}

export async function getGeofenceRow(id: string): Promise<Geofence> {
  const [row] = await db.select().from(geofences).where(eq(geofences.id, id)).limit(1);
  if (!row) throw notFound("Geofence not found");
  return row;
}

export async function getGeofence(id: string): Promise<GeofenceView> {
  return (await views([await getGeofenceRow(id)]))[0]!;
}

function shape(kind: GeofenceKind, geometry: unknown, radiusM: number | null | undefined) {
  try {
    return normalizeGeometry(kind, geometry, radiusM);
  } catch (err) {
    if (err instanceof GeometryError) throw badRequest(err.message);
    throw err;
  }
}

function explain(err: unknown): never {
  for (let cur: unknown = err, depth = 0; cur && depth < 10; depth++) {
    if ((cur as { code?: string }).code === "23503") {
      throw badRequest("The location picked no longer exists. Pick it again.");
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  throw err;
}

export async function createGeofence(input: GeofenceInput, actor: FenceActor): Promise<GeofenceView> {
  const name = input.name.trim();
  if (!name) throw badRequest("Give the geofence a name, such as the site or yard it outlines.");
  const { geometry, radiusM } = shape(input.kind, input.geometry, input.radiusM);
  try {
    const [row] = await db
      .insert(geofences)
      .values({
        name,
        kind: input.kind,
        geometry,
        radiusM,
        locationId: input.locationId ?? null,
        active: input.active ?? true,
        dwellSeconds: input.dwellSeconds ?? 30,
        color: input.color ?? null,
        notes: input.notes?.trim() || null,
        // The application's clock, which is what trackers' evaluation times use.
        geometryAt: new Date(),
        createdBy: actor.userOid,
      })
      .returning();
    invalidateFences();
    logger.info("gps.geofence.created", { id: row!.id, kind: row!.kind });
    await publish("geofence.created", described(row!), {
      actor: actorFromOid(actor.userOid, actor.name ?? null),
      subject: geofenceSubject(row!.id),
    });
    return (await views([row!]))[0]!;
  } catch (err) {
    explain(err);
  }
}

/**
 * Change a fence. A new shape, or switching it on or off, forgets which side
 * every tracker was on: the next fix from each tells it again without firing
 * an entry or exit, so redrawing a yard never announces that every truck in it
 * just arrived.
 */
export async function updateGeofence(id: string, patch: Partial<GeofenceInput>, actor: FenceActor): Promise<GeofenceView> {
  const existing = await getGeofenceRow(id);
  const set: Partial<typeof geofences.$inferInsert> = { updatedAt: new Date() };
  const changed: string[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw badRequest("A geofence needs a name.");
    set.name = name;
  }
  const kind = patch.kind ?? existing.kind;
  const reshaped = patch.kind !== undefined || patch.geometry !== undefined || patch.radiusM !== undefined;
  if (reshaped) {
    const { geometry, radiusM } = shape(
      kind,
      patch.geometry ?? existing.geometry,
      patch.radiusM === undefined ? existing.radiusM : patch.radiusM,
    );
    set.kind = kind;
    set.geometry = geometry;
    set.radiusM = radiusM;
  }
  if (patch.locationId !== undefined) set.locationId = patch.locationId;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.dwellSeconds !== undefined) set.dwellSeconds = patch.dwellSeconds;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  const resetStates = reshaped || (patch.active !== undefined && patch.active !== existing.active);
  if (resetStates) set.geometryAt = new Date();
  for (const key of Object.keys(patch) as (keyof GeofenceInput)[]) if (patch[key] !== undefined) changed.push(key);

  try {
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(geofences).set(set).where(eq(geofences.id, id)).returning();
      if (resetStates) await tx.delete(geofenceStates).where(eq(geofenceStates.geofenceId, id));
      return updated!;
    });
    invalidateFences();
    await publish(
      "geofence.updated",
      { ...described(row), changed, statesReset: resetStates },
      { actor: actorFromOid(actor.userOid, actor.name ?? null), subject: geofenceSubject(id) },
    );
    return (await views([row]))[0]!;
  } catch (err) {
    explain(err);
  }
}

export async function deleteGeofence(id: string, actor: FenceActor): Promise<void> {
  const [row] = await db.delete(geofences).where(eq(geofences.id, id)).returning();
  if (!row) throw notFound("Geofence not found");
  invalidateFences();
  logger.info("gps.geofence.deleted", { id });
  await publish("geofence.deleted", described(row), {
    actor: actorFromOid(actor.userOid, actor.name ?? null),
    subject: geofenceSubject(id),
  });
}

/**
 * The fence standing for a location: the location's own, or else its nearest
 * ancestor's, so a job going to "HQ / Level 5 / Finance" arrives when it
 * enters the fence drawn around HQ. When one location has several fences the
 * smallest wins. Null when nothing up the tree has a fence.
 */
export async function fenceForLocation(
  locationId: string | null,
  fences: readonly CompiledFence[],
): Promise<CompiledFence | null> {
  if (!locationId) return null;
  const linked = fences.filter((f) => f.locationId);
  if (!linked.length) return null;
  // UNION stops a parent loop from recursing forever.
  const { rows } = await pool.query<{ id: string; depth: number }>(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM locations WHERE id = $1
       UNION
       SELECT l.id, l.parent_id, up.depth + 1 FROM locations l JOIN up ON l.id = up.parent_id WHERE up.depth < 50
     )
     SELECT id, depth FROM up ORDER BY depth`,
    [locationId],
  );
  for (const { id } of rows) {
    const candidates = linked.filter((f) => f.locationId === id);
    if (candidates.length) return candidates.reduce((a, b) => (b.areaM2 < a.areaM2 ? b : a));
  }
  return null;
}
