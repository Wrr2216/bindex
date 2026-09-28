import { pool } from "../../db/client";
import { notFound } from "../../lib/errors";
import type { SightingDirection, SightingTech, TrackingDeviceKind } from "./types";

/** Read side of the tracking core: positions, history, presence and the live feed. */

export type SightingView = {
  id: number;
  observedAt: string;
  receivedAt: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceKind: TrackingDeviceKind | null;
  tech: SightingTech;
  code: string | null;
  itemId: string | null;
  itemName: string | null;
  itemAssetCode: string | null;
  unitId: string | null;
  unitLabel: string | null;
  unitAssetCode: string | null;
  locationId: string | null;
  locationName: string | null;
  rssi: number | null;
  antenna: number | null;
  direction: SightingDirection | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  meta: Record<string, unknown> | null;
};

export type PositionView = {
  itemId: string;
  itemName: string;
  itemAssetCode: string;
  unitId: string | null;
  unitLabel: string | null;
  unitAssetCode: string | null;
  tech: SightingTech;
  locationId: string | null;
  locationName: string | null;
  previousLocationId: string | null;
  previousLocationName: string | null;
  /** Where the asset is on file, which a reader without updates_location does not change. */
  recordedLocationId: string | null;
  recordedLocationName: string | null;
  lat: number | null;
  lng: number | null;
  deviceId: string | null;
  deviceName: string | null;
  deviceKind: TrackingDeviceKind | null;
  observedAt: string;
  enteredAt: string | null;
};

const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

const SIGHTING_SELECT = `
  SELECT s.*, d.name AS device_name, d.kind AS device_kind,
         i.name AS item_name, i.asset_code AS item_asset_code,
         u.label AS unit_label, u.asset_code AS unit_asset_code,
         l.name AS location_name
    FROM sightings s
    LEFT JOIN tracking_devices d ON d.id = s.device_id
    LEFT JOIN items i ON i.id = s.item_id
    LEFT JOIN item_units u ON u.id = s.unit_id
    LEFT JOIN locations l ON l.id = s.location_id`;

function sightingView(r: Record<string, unknown>): SightingView {
  return {
    id: Number(r.id),
    observedAt: iso(r.observed_at),
    receivedAt: iso(r.received_at),
    deviceId: (r.device_id as string) ?? null,
    deviceName: (r.device_name as string) ?? null,
    deviceKind: (r.device_kind as TrackingDeviceKind) ?? null,
    tech: r.tech as SightingTech,
    code: (r.code as string) ?? null,
    itemId: (r.item_id as string) ?? null,
    itemName: (r.item_name as string) ?? null,
    itemAssetCode: (r.item_asset_code as string) ?? null,
    unitId: (r.unit_id as string) ?? null,
    unitLabel: (r.unit_label as string) ?? null,
    unitAssetCode: (r.unit_asset_code as string) ?? null,
    locationId: (r.location_id as string) ?? null,
    locationName: (r.location_name as string) ?? null,
    rssi: numOrNull(r.rssi),
    antenna: numOrNull(r.antenna),
    direction: (r.direction as SightingDirection) ?? null,
    lat: numOrNull(r.lat),
    lng: numOrNull(r.lng),
    accuracyM: numOrNull(r.accuracy_m),
    speedMps: numOrNull(r.speed_mps),
    headingDeg: numOrNull(r.heading_deg),
    meta: (r.meta as Record<string, unknown>) ?? null,
  };
}

const POSITION_SELECT = `
  SELECT p.*, i.name AS item_name, i.asset_code AS item_asset_code,
         u.label AS unit_label, u.asset_code AS unit_asset_code,
         l.name AS location_name, pl.name AS previous_location_name,
         COALESCE(u.location_id, i.location_id) AS recorded_location_id,
         rl.name AS recorded_location_name,
         d.name AS device_name, d.kind AS device_kind
    FROM asset_positions p
    JOIN items i ON i.id = p.item_id
    LEFT JOIN item_units u ON u.id = p.unit_id
    LEFT JOIN locations l ON l.id = p.location_id
    LEFT JOIN locations pl ON pl.id = p.previous_location_id
    LEFT JOIN locations rl ON rl.id = COALESCE(u.location_id, i.location_id)
    LEFT JOIN tracking_devices d ON d.id = p.device_id`;

function positionView(r: Record<string, unknown>): PositionView {
  return {
    itemId: r.item_id as string,
    itemName: r.item_name as string,
    itemAssetCode: r.item_asset_code as string,
    unitId: (r.unit_id as string) ?? null,
    unitLabel: (r.unit_label as string) ?? null,
    unitAssetCode: (r.unit_asset_code as string) ?? null,
    tech: r.tech as SightingTech,
    locationId: (r.location_id as string) ?? null,
    locationName: (r.location_name as string) ?? null,
    previousLocationId: (r.previous_location_id as string) ?? null,
    previousLocationName: (r.previous_location_name as string) ?? null,
    recordedLocationId: (r.recorded_location_id as string) ?? null,
    recordedLocationName: (r.recorded_location_name as string) ?? null,
    lat: numOrNull(r.lat),
    lng: numOrNull(r.lng),
    deviceId: (r.device_id as string) ?? null,
    deviceName: (r.device_name as string) ?? null,
    deviceKind: (r.device_kind as TrackingDeviceKind) ?? null,
    observedAt: iso(r.observed_at),
    enteredAt: isoOrNull(r.entered_at),
  };
}

async function assertItem(itemId: string): Promise<void> {
  const { rows } = await pool.query("SELECT 1 FROM items WHERE id = $1", [itemId]);
  if (!rows.length) throw notFound("Item not found");
}

/** An item's latest positions: the item itself and each unit with its own tag. */
export async function getItemPositions(itemId: string): Promise<PositionView[]> {
  await assertItem(itemId);
  const { rows } = await pool.query(`${POSITION_SELECT} WHERE p.item_id = $1 ORDER BY p.observed_at DESC`, [
    itemId,
  ]);
  return rows.map(positionView);
}

/** A cursor for the next (older) page: "<observed_at ISO>,<id>". */
export type SightingPage = { sightings: SightingView[]; next: string | null };

/** An item's sightings, newest first, a page at a time. */
export async function listItemSightings(
  itemId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<SightingPage> {
  await assertItem(itemId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  let beforeAt: string | null = null;
  let beforeId: number | null = null;
  if (opts.before) {
    const [at, id] = opts.before.split(",");
    if (at && id && !Number.isNaN(Date.parse(at)) && /^\d+$/.test(id)) {
      beforeAt = at;
      beforeId = Number(id);
    }
  }
  const { rows } = await pool.query(
    `${SIGHTING_SELECT}
      WHERE s.item_id = $1
        AND ($2::timestamptz IS NULL OR s.observed_at < $2::timestamptz
             OR (s.observed_at = $2::timestamptz AND s.id < $3::bigint))
      ORDER BY s.observed_at DESC, s.id DESC
      LIMIT $4`,
    [itemId, beforeAt, beforeId, limit],
  );
  const sightings = rows.map(sightingView);
  const last = sightings[sightings.length - 1];
  return {
    sightings,
    next: sightings.length === limit && last ? `${last.observedAt},${last.id}` : null,
  };
}

/**
 * Assets whose latest position is in a zone or anything nested inside it.
 * `withinMinutes` limits it to assets seen recently; without it, this is
 * everything whose last known zone is here.
 */
export async function listPresent(
  locationId: string,
  opts: { withinMinutes?: number; limit?: number } = {},
): Promise<PositionView[]> {
  const { rows: found } = await pool.query("SELECT 1 FROM locations WHERE id = $1", [locationId]);
  if (!found.length) throw notFound("Location not found");
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const since = opts.withinMinutes ? new Date(Date.now() - opts.withinMinutes * 60_000) : null;
  // UNION rather than UNION ALL, so a parent loop cannot recurse forever.
  const { rows } = await pool.query(
    `WITH RECURSIVE zone AS (
       SELECT id FROM locations WHERE id = $1
       UNION
       SELECT l.id FROM locations l JOIN zone z ON l.parent_id = z.id
     )
     ${POSITION_SELECT}
      WHERE p.location_id IN (SELECT id FROM zone)
        AND ($2::timestamptz IS NULL OR p.observed_at >= $2::timestamptz)
      ORDER BY p.observed_at DESC
      LIMIT $3`,
    [locationId, since, limit],
  );
  return rows.map(positionView);
}

export type FeedPage = { cursor: number; sightings: SightingView[] };

/**
 * Recent sightings across devices, oldest first, for a live view that polls
 * with the cursor it was last given. Without `since`, the latest `limit`.
 */
export async function getFeed(opts: { since?: number; deviceId?: string; limit?: number } = {}): Promise<FeedPage> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const deviceId = opts.deviceId ?? null;
  if (opts.since === undefined) {
    const { rows } = await pool.query(
      `SELECT * FROM (${SIGHTING_SELECT}
         WHERE ($1::uuid IS NULL OR s.device_id = $1::uuid)
         ORDER BY s.id DESC LIMIT $2) recent
       ORDER BY id ASC`,
      [deviceId, limit],
    );
    const sightings = rows.map(sightingView);
    if (sightings.length) return { cursor: sightings[sightings.length - 1]!.id, sightings };
    const { rows: top } = await pool.query<{ id: string | null }>("SELECT max(id) AS id FROM sightings");
    return { cursor: Number(top[0]?.id ?? 0), sightings };
  }
  const { rows } = await pool.query(
    `${SIGHTING_SELECT}
      WHERE s.id > $1 AND ($2::uuid IS NULL OR s.device_id = $2::uuid)
      ORDER BY s.id ASC LIMIT $3`,
    [opts.since, deviceId, limit],
  );
  const sightings = rows.map(sightingView);
  const cursor = sightings.length ? sightings[sightings.length - 1]!.id : opts.since;
  return { cursor, sightings };
}
