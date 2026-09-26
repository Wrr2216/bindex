import { and, eq, isNull, notInArray } from "drizzle-orm";
import { db } from "../../db/client";
import {
  gpsTrackerLinks,
  jobs,
  shipments,
  type GpsTrackerLink,
  type RecentFix,
  type Shipment,
  type ShipmentStatus,
  type TrackingDevice,
} from "../../db/schema";
import { HttpError, describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { publish } from "../event-backbone";
import {
  SHIPMENT_STATUSES,
  onShipmentStatusChanged,
  setShipmentMetadata,
  setShipmentStatus,
} from "../jobs-core";
import { deviceActor, shipmentSubject } from "./events";
import { distanceToFenceM, type CompiledFence, type FenceTransition } from "./fence";
import { fenceForLocation } from "./geofences";
import { haversineM } from "./geo";
import { averageSpeedMps, estimateArrival } from "./route";
import { endLinksForShipment } from "./trackers";

/**
 * Shipments followed by GPS. What a tracker's fixes and fence crossings mean
 * for each shipment it travels with: leaving the origin puts the shipment in
 * transit, entering the destination asks someone to confirm delivery, fences
 * on the way are milestones, and the route figures (distance so far, straight
 * line still to go, ETA) are kept current.
 *
 * Everything this feature knows about a shipment lives under `gps` in the
 * shipment's metadata, written through the jobs core, so the portal and any
 * API client read it with the shipment.
 */

/** A crossing of one fence by one tracker, confirmed. */
export type Crossing = { fence: CompiledFence; transition: FenceTransition };

/** What `shipment.metadata.gps` holds. Times are ISO strings. */
export type ShipmentGps = {
  originGeofenceId: string | null;
  originName: string | null;
  destinationGeofenceId: string | null;
  destinationName: string | null;
  /** When a tracker left the origin fence. */
  departedAt: string | null;
  /** When a tracker entered the destination fence. */
  arrivedAt: string | null;
  /** Metres travelled since departure, along the fixes. */
  travelledM: number;
  /** The last fix counted into travelledM. */
  countedUntil: string | null;
  /** Straight-line metres from the last fix to the destination fence. */
  remainingM: number | null;
  /** Average over the last half hour. */
  speedMps: number | null;
  /** Estimated arrival, from remainingM and speedMps. Null when stopped. */
  eta: string | null;
  lastFix: { lat: number; lng: number; at: string; deviceId: string } | null;
  /**
   * A status change the tracker suggests and a person should confirm:
   * delivered on arrival, or in transit when it could not be set on departure
   * because lines were not loaded.
   */
  prompt: { status: ShipmentStatus; at: string; geofenceId: string | null; reason: string | null } | null;
  /** Fences entered on the way, newest last. */
  waypoints: { geofenceId: string; name: string; at: string }[];
  updatedAt: string | null;
};

const MAX_WAYPOINTS = 20;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function readShipmentGps(metadata: unknown): ShipmentGps {
  const g = isRecord(metadata) && isRecord(metadata.gps) ? metadata.gps : {};
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const last = isRecord(g.lastFix) ? g.lastFix : null;
  const prompt = isRecord(g.prompt) ? g.prompt : null;
  return {
    originGeofenceId: s(g.originGeofenceId),
    originName: s(g.originName),
    destinationGeofenceId: s(g.destinationGeofenceId),
    destinationName: s(g.destinationName),
    departedAt: s(g.departedAt),
    arrivedAt: s(g.arrivedAt),
    travelledM: n(g.travelledM) ?? 0,
    countedUntil: s(g.countedUntil),
    remainingM: n(g.remainingM),
    speedMps: n(g.speedMps),
    eta: s(g.eta),
    lastFix:
      last && n(last.lat) !== null && n(last.lng) !== null && s(last.at)
        ? { lat: n(last.lat)!, lng: n(last.lng)!, at: s(last.at)!, deviceId: s(last.deviceId) ?? "" }
        : null,
    prompt:
      prompt && typeof prompt.status === "string" && (SHIPMENT_STATUSES as readonly string[]).includes(prompt.status)
        ? {
            status: prompt.status as ShipmentStatus,
            at: s(prompt.at) ?? new Date(0).toISOString(),
            geofenceId: s(prompt.geofenceId),
            reason: s(prompt.reason),
          }
        : null,
    waypoints: Array.isArray(g.waypoints)
      ? g.waypoints.filter(isRecord).map((w) => ({ geofenceId: s(w.geofenceId) ?? "", name: s(w.name) ?? "", at: s(w.at) ?? "" }))
      : [],
    updatedAt: s(g.updatedAt),
  };
}

const rank = (s: ShipmentStatus) => SHIPMENT_STATUSES.indexOf(s);
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null) => (s ? new Date(s).getTime() : null);

export type TrackedShipment = {
  shipment: Shipment;
  link: GpsTrackerLink;
  originLocationId: string | null;
  destinationLocationId: string | null;
};

/** Open shipments a tracker follows: its own links, and those on the vehicle it is fitted to. */
export async function trackedShipments(deviceId: string): Promise<TrackedShipment[]> {
  const open = notInArray(shipments.status, ["delivered", "closed"]);
  const select = {
    shipment: shipments,
    link: gpsTrackerLinks,
    originLocationId: jobs.originLocationId,
    destinationLocationId: jobs.destinationLocationId,
  };
  const active = and(eq(gpsTrackerLinks.deviceId, deviceId), isNull(gpsTrackerLinks.endedAt));
  const [direct, byVehicle] = await Promise.all([
    db
      .select(select)
      .from(gpsTrackerLinks)
      .innerJoin(shipments, eq(shipments.id, gpsTrackerLinks.shipmentId))
      .innerJoin(jobs, eq(jobs.id, shipments.jobId))
      .where(and(active, open)),
    db
      .select(select)
      .from(gpsTrackerLinks)
      .innerJoin(shipments, eq(shipments.vehicleLocationId, gpsTrackerLinks.vehicleLocationId))
      .innerJoin(jobs, eq(jobs.id, shipments.jobId))
      .where(and(active, open)),
  ]);
  const seen = new Set<string>();
  return [...direct, ...byVehicle].filter((t) => !seen.has(t.shipment.id) && seen.add(t.shipment.id));
}

/** Origin and destination fences: the link's own, else the job's locations' (or their ancestors'). */
export async function shipmentFences(
  ref: {
    originGeofenceId: string | null;
    destinationGeofenceId: string | null;
    originLocationId: string | null;
    destinationLocationId: string | null;
  },
  fences: readonly CompiledFence[],
): Promise<{ origin: CompiledFence | null; destination: CompiledFence | null }> {
  const byId = (id: string | null) => (id ? (fences.find((f) => f.id === id) ?? null) : null);
  const origin = byId(ref.originGeofenceId) ?? (await fenceForLocation(ref.originLocationId, fences));
  const destination = byId(ref.destinationGeofenceId) ?? (await fenceForLocation(ref.destinationLocationId, fences));
  return { origin, destination };
}

export type ProgressInput = {
  device: TrackingDevice;
  tracked: TrackedShipment[];
  crossings: Crossing[];
  /** Accepted fixes: the tracker's recent window before this batch, then this batch, oldest first. */
  track: RecentFix[];
  fences: readonly CompiledFence[];
  now: Date;
};

/**
 * Apply one batch's crossings and fixes to every shipment the tracker follows.
 * Runs after the fixes are stored. A failure on one shipment is logged and
 * does not stop the others, or the ingest.
 */
export async function applyShipmentProgress(input: ProgressInput): Promise<void> {
  for (const t of input.tracked) {
    try {
      await progressOne(input, t);
    } catch (err) {
      logger.warn("gps.shipment.progress_failed", { shipmentId: t.shipment.id, err: describeError(err) });
    }
  }
}

async function progressOne(input: ProgressInput, t: TrackedShipment): Promise<void> {
  const { device, crossings, track, fences, now } = input;
  const shipment = t.shipment;
  const { origin, destination } = await shipmentFences(
    {
      originGeofenceId: t.link.originGeofenceId,
      destinationGeofenceId: t.link.destinationGeofenceId,
      originLocationId: t.originLocationId,
      destinationLocationId: t.destinationLocationId,
    },
    fences,
  );
  const gps = readShipmentGps(shipment.metadata);
  const before = JSON.stringify(gps);
  gps.originGeofenceId = origin?.id ?? null;
  gps.originName = origin?.name ?? null;
  gps.destinationGeofenceId = destination?.id ?? null;
  gps.destinationName = destination?.name ?? null;
  let status = shipment.status;
  const actor = deviceActor(device);
  const base = { code: shipment.code, jobId: shipment.jobId, name: shipment.name, deviceId: device.id, deviceName: device.name };

  for (const { fence, transition } of [...crossings].sort((a, b) => a.transition.occurredAt - b.transition.occurredAt)) {
    const where = { lat: transition.lat, lng: transition.lng, geofenceId: fence.id, geofenceName: fence.name };
    if (transition.kind === "exited" && fence.id === origin?.id && !gps.departedAt) {
      gps.departedAt = iso(transition.occurredAt);
      let statusApplied = false;
      let refusal: string | null = null;
      if (rank(status) < rank("in_transit")) {
        try {
          const updated = await setShipmentStatus(shipment.id, "in_transit", {}, {
            userOid: null,
            name: `GPS: ${device.name}`,
          });
          status = updated.status;
          statusApplied = true;
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          // Lines not loaded yet: the truck has gone, so say so and let a
          // person decide rather than forcing past the manifest.
          refusal = err.message;
          gps.prompt = { status: "in_transit", at: gps.departedAt, geofenceId: fence.id, reason: err.message };
        }
      }
      logger.info("gps.shipment.departed", { shipmentId: shipment.id, statusApplied });
      await publish(
        "shipment.departed",
        { ...base, ...where, departedAt: gps.departedAt, status, statusApplied, refusal },
        { actor, subject: shipmentSubject(shipment.id) },
      );
    } else if (transition.kind === "entered" && fence.id === destination?.id && !gps.arrivedAt) {
      gps.arrivedAt = iso(transition.occurredAt);
      if (rank(status) < rank("delivered")) {
        gps.prompt = { status: "delivered", at: gps.arrivedAt, geofenceId: fence.id, reason: null };
      }
      logger.info("gps.shipment.arrived", { shipmentId: shipment.id });
      await publish(
        "shipment.arrived",
        { ...base, ...where, arrivedAt: gps.arrivedAt, status, deliveryPrompted: gps.prompt?.status === "delivered" },
        { actor, subject: shipmentSubject(shipment.id) },
      );
    } else if (
      transition.kind === "entered" &&
      fence.id !== origin?.id &&
      fence.id !== destination?.id &&
      gps.departedAt &&
      !gps.arrivedAt
    ) {
      const at = iso(transition.occurredAt);
      gps.waypoints = [...gps.waypoints, { geofenceId: fence.id, name: fence.name, at }].slice(-MAX_WAYPOINTS);
      await publish(
        "shipment.waypoint_reached",
        { ...base, ...where, at, status },
        { actor, subject: shipmentSubject(shipment.id) },
      );
    }
  }

  // Distance: every stretch between consecutive fixes after departure, each
  // counted once even when several trackers report for the same shipment.
  const departed = ms(gps.departedAt);
  let counted = ms(gps.countedUntil) ?? -Infinity;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1]!;
    const b = track[i]!;
    if (departed === null || a.at < departed || a.at < counted || b.at <= counted) continue;
    gps.travelledM += haversineM(a, b);
    counted = b.at;
  }
  if (counted > -Infinity) gps.countedUntil = iso(counted);

  const last = track[track.length - 1];
  if (last && (!gps.lastFix || last.at > new Date(gps.lastFix.at).getTime())) {
    gps.lastFix = { lat: last.lat, lng: last.lng, at: iso(last.at), deviceId: device.id };
  }
  if (gps.lastFix) {
    gps.remainingM = destination ? Math.round(distanceToFenceM(destination, gps.lastFix)) : null;
    const windowStart = new Date(gps.lastFix.at).getTime() - 30 * 60_000;
    gps.speedMps = averageSpeedMps(track.filter((f) => f.at >= windowStart));
    const eta = estimateArrival(gps.remainingM, gps.speedMps, now.getTime());
    gps.eta = eta === null ? null : iso(eta);
  }
  gps.travelledM = Math.round(gps.travelledM);
  if (JSON.stringify(gps) === before) return;
  gps.updatedAt = now.toISOString();
  await setShipmentMetadata(shipment.id, "gps", gps);
}

/** Clear a suggestion someone has dealt with, or chose to ignore. */
export async function dismissPrompt(shipmentId: string): Promise<ShipmentGps> {
  const [row] = await db.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
  if (!row) throw new HttpError(404, "not_found", "Shipment not found");
  const gps = readShipmentGps(row.metadata);
  if (!gps.prompt) return gps;
  gps.prompt = null;
  gps.updatedAt = new Date().toISOString();
  await setShipmentMetadata(shipmentId, "gps", gps);
  return gps;
}

let wired = false;

/**
 * When a shipment is delivered, its trackers come off it (single-use ones then
 * wait to be returned) and any delivery prompt is cleared. When someone sets it
 * in transit, a departure prompt is cleared. Registered once, when this module
 * first loads.
 */
export function wireShipmentHooks(): void {
  if (wired) return;
  wired = true;
  onShipmentStatusChanged(async ({ shipment, to, userOid, actor }) => {
    const gps = readShipmentGps(shipment.metadata);
    if (rank(to) >= rank("delivered")) {
      await endLinksForShipment(shipment.id, "delivered", { userOid, name: actor });
    }
    if (gps.prompt && rank(to) >= rank(gps.prompt.status)) {
      // Re-read: the row in the event predates this listener's own writes.
      await dismissPrompt(shipment.id);
    }
  });
}
