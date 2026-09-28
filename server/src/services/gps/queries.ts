import { asc, eq, getTableColumns, inArray } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { jobs, locations, shipments, shipmentStatusHistory } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { activeFences, getGeofence, type GeofenceView } from "./geofences";
import { readShipmentGps, shipmentFences, type ShipmentGps } from "./shipments";
import { listLinks, type LinkView } from "./trackers";

/** Read side: trails, crossings and the shipment map. */

export type TrailPoint = {
  id: number;
  at: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  deviceId: string | null;
  locationId: string | null;
  /** Why the fix was not believed: "jump" or "invalid". */
  rejected: string | null;
  outOfOrder: boolean;
};

export type Trail = { points: TrailPoint[]; truncated: boolean };

export const MAX_TRAIL_POINTS = 5000;

function trailPoint(r: Record<string, unknown>): TrailPoint {
  const meta = (r.meta as Record<string, unknown> | null) ?? {};
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: Number(r.id),
    at: new Date(r.observed_at as string).toISOString(),
    lat: Number(r.lat),
    lng: Number(r.lng),
    accuracyM: num(r.accuracy_m),
    speedMps: num(r.speed_mps),
    headingDeg: num(r.heading_deg),
    deviceId: (r.device_id as string) ?? null,
    locationId: (r.location_id as string) ?? null,
    rejected: typeof meta.rejected === "string" ? meta.rejected : null,
    outOfOrder: meta.outOfOrder === true,
  };
}

type Range = { from?: Date; to?: Date; limit?: number; includeRejected?: boolean };

/**
 * Points in time order. When there are more than the limit, the latest ones
 * are returned and `truncated` says so.
 */
async function trail(where: string, params: unknown[], range: Range): Promise<Trail> {
  const limit = Math.min(Math.max(range.limit ?? 2000, 1), MAX_TRAIL_POINTS);
  const n = params.length;
  const { rows } = await pool.query(
    `SELECT id, observed_at, lat, lng, accuracy_m, speed_mps, heading_deg, device_id, location_id, meta
       FROM sightings
      WHERE ${where}
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND ($${n + 1}::timestamptz IS NULL OR observed_at >= $${n + 1})
        AND ($${n + 2}::timestamptz IS NULL OR observed_at <= $${n + 2})
        AND ($${n + 3}::boolean OR meta IS NULL OR NOT (meta ? 'rejected'))
      ORDER BY observed_at DESC, id DESC
      LIMIT $${n + 4}`,
    [...params, range.from ?? null, range.to ?? null, range.includeRejected ?? false, limit + 1],
  );
  const truncated = rows.length > limit;
  return { points: rows.slice(0, limit).reverse().map(trailPoint), truncated };
}

/** A tracker's own fixes, rejected ones included and flagged on request. */
export function trackerTrail(deviceId: string, range: Range): Promise<Trail> {
  return trail("device_id = $1 AND tech = 'gps'", [deviceId], range);
}

/** Where an item has been, from any device that reported coordinates for it. */
export async function itemTrail(itemId: string, range: Range): Promise<Trail> {
  const { rows } = await pool.query("SELECT 1 FROM items WHERE id = $1", [itemId]);
  if (!rows.length) throw notFound("Item not found");
  return trail("item_id = $1", [itemId], { ...range, includeRejected: false });
}

export type GeofenceEventView = {
  id: number;
  geofenceId: string | null;
  geofenceName: string;
  locationId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  itemId: string | null;
  itemName: string | null;
  shipmentIds: string[];
  kind: "entered" | "exited";
  occurredAt: string;
  confirmedAt: string;
  lat: number | null;
  lng: number | null;
  auditId: number | null;
};

export async function listGeofenceEvents(
  filter: { geofenceId?: string; deviceId?: string; shipmentId?: string; itemId?: string; before?: number; limit?: number } = {},
): Promise<{ events: GeofenceEventView[]; next: number | null }> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const { rows } = await pool.query(
    `SELECT e.*, d.name AS device_name, i.name AS item_name
       FROM geofence_events e
       LEFT JOIN tracking_devices d ON d.id = e.device_id
       LEFT JOIN items i ON i.id = e.item_id
      WHERE ($1::uuid IS NULL OR e.geofence_id = $1)
        AND ($2::uuid IS NULL OR e.device_id = $2)
        AND ($3::uuid IS NULL OR $3 = ANY(e.shipment_ids))
        AND ($4::uuid IS NULL OR e.item_id = $4)
        AND ($5::bigint IS NULL OR e.id < $5)
      ORDER BY e.id DESC
      LIMIT $6`,
    [
      filter.geofenceId ?? null,
      filter.deviceId ?? null,
      filter.shipmentId ?? null,
      filter.itemId ?? null,
      filter.before ?? null,
      limit,
    ],
  );
  const events = rows.map(
    (r): GeofenceEventView => ({
      id: Number(r.id),
      geofenceId: r.geofence_id ?? null,
      geofenceName: r.geofence_name,
      locationId: r.location_id ?? null,
      deviceId: r.device_id ?? null,
      deviceName: r.device_name ?? null,
      itemId: r.item_id ?? null,
      itemName: r.item_name ?? null,
      shipmentIds: r.shipment_ids ?? [],
      kind: r.kind,
      occurredAt: new Date(r.occurred_at).toISOString(),
      confirmedAt: new Date(r.confirmed_at).toISOString(),
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
      auditId: r.audit_id == null ? null : Number(r.audit_id),
    }),
  );
  return { events, next: events.length === limit ? events[events.length - 1]!.id : null };
}

export type ShipmentMap = {
  shipment: {
    id: string;
    code: string;
    name: string;
    status: string;
    jobId: string;
    jobCode: string;
    jobName: string;
    vehicleLocationId: string | null;
    vehicleName: string | null;
    departedAt: string | null;
    arrivedAt: string | null;
    eta: string | null;
    distanceKm: number | null;
  };
  gps: ShipmentGps;
  origin: GeofenceView | null;
  destination: GeofenceView | null;
  links: LinkView[];
  /** Fixes of every tracker that has been on it, while it was on it. */
  trails: { deviceId: string; deviceName: string | null; points: TrailPoint[]; truncated: boolean }[];
  events: GeofenceEventView[];
  history: { fromStatus: string | null; toStatus: string; actor: string | null; reason: string | null; at: string }[];
};

/** Everything the shipment map screen shows, in one call. */
export async function shipmentMap(shipmentId: string): Promise<ShipmentMap> {
  const [row] = await db
    .select({
      ...getTableColumns(shipments),
      jobCode: jobs.code,
      jobName: jobs.name,
      originLocationId: jobs.originLocationId,
      destinationLocationId: jobs.destinationLocationId,
      vehicleName: locations.name,
    })
    .from(shipments)
    .innerJoin(jobs, eq(jobs.id, shipments.jobId))
    .leftJoin(locations, eq(locations.id, shipments.vehicleLocationId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  if (!row) throw notFound("Shipment not found");

  const direct = await listLinks({ shipmentId });
  const vehicle = row.vehicleLocationId ? await listLinks({ vehicleLocationId: row.vehicleLocationId }) : [];
  const links = [...direct, ...vehicle];
  const fences = await activeFences();
  const current = links.find((l) => !l.endedAt && l.shipmentId) ?? links[0];
  const { origin, destination } = await shipmentFences(
    {
      originGeofenceId: current?.originGeofenceId ?? null,
      destinationGeofenceId: current?.destinationGeofenceId ?? null,
      originLocationId: row.originLocationId,
      destinationLocationId: row.destinationLocationId,
    },
    fences,
  );
  const view = async (id: string | undefined) => (id ? getGeofence(id).catch(() => null) : null);

  const gps = readShipmentGps(row.metadata);
  // Fixes carry the tracker's own times, and a tracker that buffered while
  // out of coverage can report the start of the trip after it was linked, so
  // the trail starts at the departure its fixes showed if that came first.
  const departed = [gps.departedAt ? new Date(gps.departedAt) : null, row.departedAt].filter(
    (d): d is Date => d !== null,
  );
  const since = (l: LinkView) => {
    // A vehicle tracker is only this shipment's while the shipment is moving.
    const start = l.vehicleLocationId ? (departed[0] ?? row.createdAt) : l.assignedAt;
    return new Date(Math.min(start.getTime(), ...departed.map((d) => d.getTime())));
  };
  const byDevice = new Map<string, { from: Date; to: Date | null; name: string | null }>();
  for (const l of links) {
    const from = new Date(since(l));
    const to = l.endedAt ? new Date(l.endedAt) : row.arrivedAt && l.vehicleLocationId ? new Date(row.arrivedAt) : null;
    const prev = byDevice.get(l.deviceId);
    byDevice.set(l.deviceId, {
      from: prev && prev.from < from ? prev.from : from,
      to: prev ? (prev.to === null || to === null ? null : prev.to > to ? prev.to : to) : to,
      name: l.deviceName,
    });
  }
  const trails = await Promise.all(
    [...byDevice].map(async ([deviceId, r]) => ({
      deviceId,
      deviceName: r.name,
      ...(await trackerTrail(deviceId, { from: r.from, to: r.to ?? undefined, limit: 3000 })),
    })),
  );

  const [events, history] = await Promise.all([
    listGeofenceEvents({ shipmentId, limit: 100 }),
    db
      .select()
      .from(shipmentStatusHistory)
      .where(eq(shipmentStatusHistory.shipmentId, shipmentId))
      .orderBy(asc(shipmentStatusHistory.createdAt)),
  ]);

  return {
    shipment: {
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      jobId: row.jobId,
      jobCode: row.jobCode,
      jobName: row.jobName,
      vehicleLocationId: row.vehicleLocationId,
      vehicleName: row.vehicleName,
      departedAt: row.departedAt?.toISOString() ?? null,
      arrivedAt: row.arrivedAt?.toISOString() ?? null,
      eta: row.eta?.toISOString() ?? null,
      distanceKm: row.distanceKm,
    },
    gps,
    origin: await view(origin?.id),
    destination: await view(destination?.id),
    links,
    trails,
    events: events.events,
    history: history.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      actor: h.actor,
      reason: h.reason,
      at: h.createdAt.toISOString(),
    })),
  };
}

/** Open shipments, for the "put this tracker on…" picker. */
export async function openShipments(): Promise<
  { id: string; code: string; name: string; status: string; jobCode: string; jobName: string }[]
> {
  return db
    .select({
      id: shipments.id,
      code: shipments.code,
      name: shipments.name,
      status: shipments.status,
      jobCode: jobs.code,
      jobName: jobs.name,
    })
    .from(shipments)
    .innerJoin(jobs, eq(jobs.id, shipments.jobId))
    .where(inArray(shipments.status, ["planned", "staged", "loaded", "in_transit"]))
    .orderBy(asc(shipments.code));
}
