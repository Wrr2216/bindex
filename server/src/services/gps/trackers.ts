import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import {
  geofences,
  gpsTrackerLinks,
  gpsTrackers,
  jobs,
  locations,
  shipments,
  trackingDevices,
  type GpsTracker,
  type GpsTrackerLink,
  type GpsTrackerStatus,
  type TrackingDevice,
} from "../../db/schema";
import { env } from "../../env";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { actorFromOid, publish } from "../event-backbone";
import { getDeviceRow, listDevices, updateDevice, type DeviceView } from "../tracking";
import { trackerSubject } from "./events";
import { batteryLowFor, readTrackerSettings, type TrackerSettings } from "./settings";

/**
 * GPS trackers as things with a life of their own: which shipment or vehicle
 * each is on, whether a single-use one is waiting to come back, and its GPS
 * options. The device itself (name, token, attachment) stays in the tracking
 * core's registry.
 */

export type Actor = { userOid: string | null; name?: string | null };

/** Not heard from for this long, a tracker is shown as silent. */
export const STALE_AFTER_MS = 60 * 60_000;

export type LinkView = GpsTrackerLink & {
  deviceName: string | null;
  shipmentCode: string | null;
  shipmentName: string | null;
  shipmentStatus: string | null;
  jobId: string | null;
  jobCode: string | null;
  vehicleName: string | null;
  originName: string | null;
  destinationName: string | null;
};

export type TrackerView = DeviceView & {
  gps: TrackerSettings;
  status: GpsTrackerStatus;
  statusAt: string | null;
  lastFixAt: string | null;
  lastFixLat: number | null;
  lastFixLng: number | null;
  lastAccuracyM: number | null;
  batteryLow: boolean;
  stale: boolean;
  links: LinkView[];
};

/** Make sure the tracker has its row, which holds its status and filter memory. */
export async function ensureTracker(deviceId: string): Promise<void> {
  await db.insert(gpsTrackers).values({ deviceId }).onConflictDoNothing();
}

/** The device, or a 404 when it is missing or is not a GPS tracker. */
export async function getTrackerDevice(id: string): Promise<TrackingDevice> {
  const device = await getDeviceRow(id);
  if (device.kind !== "gps_tracker") throw notFound("That device is not a GPS tracker.");
  return device;
}

const originFence = alias(geofences, "origin_fence");
const destinationFence = alias(geofences, "destination_fence");

export async function listLinks(
  filter: { deviceIds?: string[]; shipmentId?: string; vehicleLocationId?: string; active?: boolean } = {},
): Promise<LinkView[]> {
  const where: SQL[] = [];
  if (filter.deviceIds) {
    if (!filter.deviceIds.length) return [];
    where.push(inArray(gpsTrackerLinks.deviceId, filter.deviceIds));
  }
  if (filter.shipmentId) where.push(eq(gpsTrackerLinks.shipmentId, filter.shipmentId));
  if (filter.vehicleLocationId) where.push(eq(gpsTrackerLinks.vehicleLocationId, filter.vehicleLocationId));
  if (filter.active) where.push(isNull(gpsTrackerLinks.endedAt));
  const rows = await db
    .select({
      link: gpsTrackerLinks,
      deviceName: trackingDevices.name,
      shipmentCode: shipments.code,
      shipmentName: shipments.name,
      shipmentStatus: shipments.status,
      jobId: shipments.jobId,
      jobCode: jobs.code,
      vehicleName: locations.name,
      originName: originFence.name,
      destinationName: destinationFence.name,
    })
    .from(gpsTrackerLinks)
    .leftJoin(trackingDevices, eq(trackingDevices.id, gpsTrackerLinks.deviceId))
    .leftJoin(shipments, eq(shipments.id, gpsTrackerLinks.shipmentId))
    .leftJoin(jobs, eq(jobs.id, shipments.jobId))
    .leftJoin(locations, eq(locations.id, gpsTrackerLinks.vehicleLocationId))
    .leftJoin(originFence, eq(originFence.id, gpsTrackerLinks.originGeofenceId))
    .leftJoin(destinationFence, eq(destinationFence.id, gpsTrackerLinks.destinationGeofenceId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(gpsTrackerLinks.assignedAt));
  return rows.map(({ link, ...rest }) => ({ ...link, ...rest }));
}

function trackerView(device: DeviceView, row: GpsTracker | undefined, links: LinkView[], now: number): TrackerView {
  const gps = readTrackerSettings(device.settings);
  const heard = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : null;
  return {
    ...device,
    gps,
    status: row?.status ?? "available",
    statusAt: row?.statusAt ? row.statusAt.toISOString() : null,
    lastFixAt: row?.lastFixAt ? row.lastFixAt.toISOString() : null,
    lastFixLat: row?.lastLat ?? null,
    lastFixLng: row?.lastLng ?? null,
    lastAccuracyM: row?.lastAccuracyM ?? null,
    batteryLow: device.batteryPct !== null && device.batteryPct <= batteryLowFor(gps),
    stale: row?.status !== "disposed" && (heard === null || now - heard > STALE_AFTER_MS),
    links,
  };
}

export async function listTrackers(): Promise<TrackerView[]> {
  const devices = await listDevices({ kinds: ["gps_tracker"] });
  const ids = devices.map((d) => d.id);
  const [rows, links] = await Promise.all([
    ids.length ? db.select().from(gpsTrackers).where(inArray(gpsTrackers.deviceId, ids)) : [],
    listLinks({ deviceIds: ids, active: true }),
  ]);
  const byDevice = new Map(rows.map((r) => [r.deviceId, r]));
  const now = Date.now();
  return devices.map((d) =>
    trackerView(
      d,
      byDevice.get(d.id),
      links.filter((l) => l.deviceId === d.id),
      now,
    ),
  );
}

export async function getTracker(id: string): Promise<TrackerView> {
  await getTrackerDevice(id);
  const [device] = (await listDevices({ kinds: ["gps_tracker"] })).filter((d) => d.id === id);
  if (!device) throw notFound("That device is not a GPS tracker.");
  const [[row], links] = await Promise.all([
    db.select().from(gpsTrackers).where(eq(gpsTrackers.deviceId, id)).limit(1),
    listLinks({ deviceIds: [id] }),
  ]);
  return trackerView(device, row, links, Date.now());
}

/** Change a tracker's GPS options, keeping every other device setting as it is. */
export async function updateTrackerSettings(id: string, patch: Partial<TrackerSettings>): Promise<TrackerView> {
  const device = await getTrackerDevice(id);
  const current = readTrackerSettings(device.settings);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  await updateDevice(id, { settings: { ...device.settings, gps: next } });
  return getTracker(id);
}

async function setStatus(deviceId: string, status: GpsTrackerStatus): Promise<GpsTrackerStatus | null> {
  await ensureTracker(deviceId);
  const [before] = await db.select({ status: gpsTrackers.status }).from(gpsTrackers).where(eq(gpsTrackers.deviceId, deviceId));
  if (before?.status === status) return null;
  await db
    .update(gpsTrackers)
    .set({ status, statusAt: new Date(), updatedAt: new Date() })
    .where(eq(gpsTrackers.deviceId, deviceId));
  return before?.status ?? "available";
}

/**
 * Put a tracker's status in line with its links. With a link it is assigned.
 * Without one it is available, unless it is a single-use tracker whose
 * shipment has just been delivered, which then waits to be returned.
 */
export async function refreshTrackerStatus(deviceId: string, opts: { delivered?: boolean } = {}): Promise<GpsTrackerStatus> {
  const device = await getDeviceRow(deviceId);
  const [row] = await db.select().from(gpsTrackers).where(eq(gpsTrackers.deviceId, deviceId)).limit(1);
  if (row?.status === "disposed") return "disposed";
  const [active] = await db
    .select({ id: gpsTrackerLinks.id })
    .from(gpsTrackerLinks)
    .where(and(eq(gpsTrackerLinks.deviceId, deviceId), isNull(gpsTrackerLinks.endedAt)))
    .limit(1);
  let status: GpsTrackerStatus;
  if (active) status = "assigned";
  else if (opts.delivered && readTrackerSettings(device.settings).singleUse) status = "awaiting_return";
  else if (row?.status === "awaiting_return") status = "awaiting_return";
  else status = "available";
  await setStatus(deviceId, status);
  return status;
}

export type LinkInput = {
  deviceId: string;
  shipmentId?: string | null;
  vehicleLocationId?: string | null;
  originGeofenceId?: string | null;
  destinationGeofenceId?: string | null;
};

/**
 * Put a tracker on a shipment, or fit it to a vehicle so it follows every open
 * shipment travelling on that vehicle.
 */
export async function createLink(input: LinkInput, actor: Actor): Promise<LinkView> {
  if (Boolean(input.shipmentId) === Boolean(input.vehicleLocationId)) {
    throw badRequest("Link the tracker to a shipment or to a vehicle, not both.");
  }
  const device = await getTrackerDevice(input.deviceId);
  if (device.disabled) throw badRequest(`${device.name} is disabled. Enable it in Readers and devices first.`);
  await ensureTracker(device.id);
  const [tracker] = await db.select().from(gpsTrackers).where(eq(gpsTrackers.deviceId, device.id)).limit(1);
  if (tracker?.status === "disposed") {
    throw badRequest(`${device.name} was disposed of. Put it back in service before assigning it.`);
  }
  if (tracker?.status === "awaiting_return") {
    throw badRequest(`${device.name} is waiting to be returned from its last shipment. Mark it returned first.`);
  }
  if (input.shipmentId) {
    const [shipment] = await db.select().from(shipments).where(eq(shipments.id, input.shipmentId)).limit(1);
    if (!shipment) throw notFound("Shipment not found");
    if (shipment.status === "delivered" || shipment.status === "closed") {
      throw badRequest(`${shipment.code} is already ${shipment.status}. Pick a shipment that has not been delivered.`);
    }
  } else {
    const [vehicle] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, input.vehicleLocationId!))
      .limit(1);
    if (!vehicle) throw notFound("Vehicle location not found");
  }
  for (const fenceId of [input.originGeofenceId, input.destinationGeofenceId]) {
    if (!fenceId) continue;
    const [fence] = await db.select({ id: geofences.id }).from(geofences).where(eq(geofences.id, fenceId)).limit(1);
    if (!fence) throw badRequest("A geofence picked no longer exists. Pick it again.");
  }

  let link: GpsTrackerLink;
  try {
    [link] = (await db
      .insert(gpsTrackerLinks)
      .values({
        deviceId: device.id,
        shipmentId: input.shipmentId ?? null,
        vehicleLocationId: input.vehicleLocationId ?? null,
        originGeofenceId: input.originGeofenceId ?? null,
        destinationGeofenceId: input.destinationGeofenceId ?? null,
        assignedBy: actor.name ?? actor.userOid,
      })
      .returning()) as [GpsTrackerLink];
  } catch (err) {
    if (isUniqueViolation(err, "uq_gps_tracker_links_shipment")) {
      throw conflict(`${device.name} is already on that shipment.`);
    }
    if (isUniqueViolation(err, "uq_gps_tracker_links_vehicle")) {
      throw conflict(`${device.name} is already fitted to a vehicle. Take it off that one first.`);
    }
    throw err;
  }
  await setStatus(device.id, "assigned");
  const [view] = await listLinks({ deviceIds: [device.id] }).then((all) => all.filter((l) => l.id === link.id));
  logger.info("gps.tracker.assigned", { deviceId: device.id, shipmentId: link.shipmentId, vehicle: link.vehicleLocationId });
  await publish(
    "tracker.assigned",
    {
      deviceId: device.id,
      deviceName: device.name,
      linkId: link.id,
      shipmentId: link.shipmentId,
      shipmentCode: view?.shipmentCode ?? null,
      vehicleLocationId: link.vehicleLocationId,
      vehicleName: view?.vehicleName ?? null,
    },
    { actor: actorFromOid(actor.userOid, actor.name ?? null), subject: trackerSubject(device.id) },
  );
  return view!;
}

async function finishLinks(where: SQL, reason: string, actor: Actor): Promise<GpsTrackerLink[]> {
  return db
    .update(gpsTrackerLinks)
    .set({ endedAt: new Date(), endReason: reason, endedBy: actor.name ?? actor.userOid })
    .where(and(where, isNull(gpsTrackerLinks.endedAt)))
    .returning();
}

async function announceEnded(ended: GpsTrackerLink[], reason: string, actor: Actor, delivered = false) {
  const devices = [...new Set(ended.map((l) => l.deviceId))];
  const statuses = new Map<string, GpsTrackerStatus>();
  for (const id of devices) statuses.set(id, await refreshTrackerStatus(id, { delivered }));
  const views = await listLinks({ deviceIds: devices });
  for (const link of ended) {
    const view = views.find((v) => v.id === link.id);
    await publish(
      "tracker.unassigned",
      {
        deviceId: link.deviceId,
        deviceName: view?.deviceName ?? null,
        linkId: link.id,
        shipmentId: link.shipmentId,
        shipmentCode: view?.shipmentCode ?? null,
        vehicleLocationId: link.vehicleLocationId,
        reason,
        status: statuses.get(link.deviceId) ?? null,
      },
      { actor: actorFromOid(actor.userOid, actor.name ?? null), subject: trackerSubject(link.deviceId) },
    );
  }
}

/** Take a tracker off a shipment or vehicle by hand. */
export async function endLink(id: string, actor: Actor): Promise<LinkView> {
  const ended = await finishLinks(eq(gpsTrackerLinks.id, id), "manual", actor);
  if (!ended.length) {
    const [exists] = await db.select({ id: gpsTrackerLinks.id }).from(gpsTrackerLinks).where(eq(gpsTrackerLinks.id, id));
    if (!exists) throw notFound("Tracker link not found");
    throw badRequest("That tracker has already been taken off.");
  }
  await announceEnded(ended, "manual", actor);
  const [view] = (await listLinks({ deviceIds: [ended[0]!.deviceId] })).filter((l) => l.id === id);
  return view!;
}

/** On delivery: every tracker travelling with the shipment comes off it. */
export async function endLinksForShipment(shipmentId: string, reason: string, actor: Actor): Promise<string[]> {
  const ended = await finishLinks(eq(gpsTrackerLinks.shipmentId, shipmentId), reason, actor);
  if (ended.length) await announceEnded(ended, reason, actor, reason === "delivered");
  return ended.map((l) => l.deviceId);
}

/**
 * Return a tracker to service (after it came back, or was found) or dispose of
 * it. Disposing takes it off whatever it was on.
 */
export async function setTrackerStatus(
  id: string,
  status: "available" | "disposed",
  actor: Actor,
  note?: string | null,
): Promise<TrackerView> {
  const device = await getTrackerDevice(id);
  await ensureTracker(id);
  const [row] = await db.select().from(gpsTrackers).where(eq(gpsTrackers.deviceId, id)).limit(1);
  const from = row?.status ?? "available";
  if (status === "available" && from === "assigned") {
    throw badRequest(`${device.name} is on a shipment or vehicle. Take it off there instead.`);
  }
  if (from === status) return getTracker(id);
  if (status === "disposed") {
    const ended = await finishLinks(eq(gpsTrackerLinks.deviceId, id), "disposed", actor);
    await setStatus(id, "disposed");
    if (ended.length) await announceEnded(ended, "disposed", actor);
  } else {
    await setStatus(id, "available");
  }
  await publish(
    "tracker.status_changed",
    { deviceId: id, deviceName: device.name, from, to: status, note: note?.trim() || null },
    { actor: actorFromOid(actor.userOid, actor.name ?? null), subject: trackerSubject(id) },
  );
  return getTracker(id);
}

/** Default battery threshold, for the client. */
export const defaultBatteryLowPct = () => env.GPS_BATTERY_LOW_PCT;
