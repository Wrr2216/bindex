import type { PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { trackingDevices, type GpsTracker, type RecentFix, type TrackingDevice } from "../../db/schema";
import { HttpError, describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { notify } from "../../lib/notify";
import { publish } from "../event-backbone";
import {
  createDevice,
  getDeviceRow,
  recordSightings,
  updateDeviceStatus,
  type NormalizedRead,
  type RecordResult,
} from "../tracking";
import { clampObservedAt } from "../tracking/normalize";
import { deviceActor, geofenceSubject, trackerSubject } from "./events";
import {
  OUTSIDE,
  containment,
  stepFence,
  zoneFromFences,
  type CompiledFence,
  type FenceState,
} from "./fence";
import { screenFix, type FilterState, type FixPoint } from "./filter";
import { activeFences } from "./geofences";
import { toMps, type GpsReport } from "./protocols";
import { pushRecent } from "./route";
import { batteryLowFor, maxSpeedFor, readTrackerSettings } from "./settings";
import { applyShipmentProgress, trackedShipments, type Crossing } from "./shipments";

/**
 * From tracker reports to stored history, positions, fence crossings and
 * shipment milestones.
 *
 * For each tracker, oldest report first:
 *
 * 1. Each fix is screened (filter.ts). Believed fixes go on; a fix older than
 *    the last believed one is stored as history only; a jump or a fix the
 *    tracker marks invalid is stored flagged and attached to no asset, so it
 *    moves nothing.
 * 2. Believed fixes are tested against every active fence (fence.ts), which
 *    confirms entries and exits after each fence's dwell time.
 * 3. Everything is stored through the tracking core's recordSightings, with
 *    the zone set to the location of the smallest linked fence the tracker is
 *    inside (or none), so the attached asset's position, "moved" events and,
 *    with "Move items when read", its recorded location follow.
 * 4. The tracker's memory and the crossings are committed; then, and only
 *    then, events are published and shipments are updated.
 *
 * Batches for one tracker are handled one at a time in this process. As with
 * the tracking core's duplicate filter, a tracker should post to one replica.
 */

export type GpsIngestResult = {
  deviceId: string;
  /** Fixes in the batch. */
  fixes: number;
  /** Believed and in order. */
  accepted: number;
  /** Older than a fix already taken; stored as history. */
  outOfOrder: number;
  /** Jumps, and fixes the tracker marked invalid; stored flagged. */
  rejected: number;
  entered: number;
  exited: number;
} & Pick<RecordResult, "recorded" | "suppressed" | "moved">;

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call with the same key has finished. */
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

type Accepted = FixPoint & { speedMps: number | null; reanchored: boolean };

type Plan = {
  reads: NormalizedRead[];
  accepted: Accepted[];
  crossings: Crossing[];
  filter: FilterState;
  states: Map<string, FenceState>;
  touched: Set<string>;
  batteryPct: number | null;
  latestReportAt: Date | null;
  counts: { fixes: number; accepted: number; outOfOrder: number; rejected: number };
};

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * Decide what each report means, without touching the database. Exported for
 * tests.
 */
export function planBatch(
  device: Pick<TrackingDevice, "settings">,
  tracker: Pick<
    GpsTracker,
    | "lastLat"
    | "lastLng"
    | "lastAccuracyM"
    | "lastFixAt"
    | "rejectStreak"
    | "rejectLat"
    | "rejectLng"
    | "rejectAccuracyM"
    | "rejectAt"
    | "evaluatedAt"
  > | null,
  stored: Map<string, FenceState>,
  fences: readonly CompiledFence[],
  reports: readonly GpsReport[],
  now: Date,
): Plan {
  const settings = readTrackerSettings(device.settings);
  const maxSpeed = maxSpeedFor(settings);
  let filter: FilterState = {
    last:
      tracker?.lastFixAt && tracker.lastLat !== null && tracker.lastLng !== null
        ? { lat: tracker.lastLat, lng: tracker.lastLng, at: new Date(tracker.lastFixAt).getTime(), accuracyM: tracker.lastAccuracyM }
        : null,
    rejectStreak: tracker?.rejectStreak ?? 0,
    lastRejected:
      tracker?.rejectAt && tracker.rejectLat !== null && tracker.rejectLng !== null
        ? { lat: tracker.rejectLat, lng: tracker.rejectLng, at: new Date(tracker.rejectAt).getTime(), accuracyM: tracker.rejectAccuracyM }
        : null,
  };
  // Fences drawn or redrawn since this tracker was last tested have never
  // seen it; its next fix tells them which side it is on, without an event.
  // Both times are the server's, so a tracker's clock or a buffered upload
  // cannot confuse them.
  const evaluatedAt = tracker?.evaluatedAt ? new Date(tracker.evaluatedAt).getTime() : null;
  const states = new Map(stored);
  const touched = new Set<string>();
  const plan: Plan = {
    reads: [],
    accepted: [],
    crossings: [],
    filter,
    states,
    touched,
    batteryPct: null,
    latestReportAt: null,
    counts: { fixes: 0, accepted: 0, outOfOrder: 0, rejected: 0 },
  };

  const ordered = reports
    .map((r) => ({ r, at: clampObservedAt(r.at, now) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  for (const { r, at } of ordered) {
    if (r.batteryPct !== null) plan.batteryPct = r.batteryPct;
    if (!plan.latestReportAt || at > plan.latestReportAt) plan.latestReportAt = at;
    const f = r.fix;
    if (!f) continue;
    plan.counts.fixes += 1;
    const speedMps = toMps(f.speed, settings.speedUnit);
    const base: NormalizedRead = {
      tech: "gps",
      observedAt: at,
      lat: f.lat,
      lng: f.lng,
      accuracyM: f.accuracyM,
      speedMps: speedMps === null ? null : round(speedMps, 2),
      headingDeg: f.headingDeg,
      meta: { ...(r.meta ?? {}), ...(f.altitudeM !== null ? { altitudeM: f.altitudeM } : {}) },
    };
    if (!f.valid) {
      plan.reads.push({ ...base, asset: null, locationId: null, meta: { ...base.meta, rejected: "invalid" } });
      plan.counts.rejected += 1;
      continue;
    }
    const point: FixPoint = { lat: f.lat, lng: f.lng, at: at.getTime(), accuracyM: f.accuracyM };
    const screened = screenFix(filter, point, maxSpeed);
    filter = screened.state;
    const verdict = screened.result;
    if (verdict.verdict === "out_of_order") {
      plan.reads.push({ ...base, locationId: null, meta: { ...base.meta, outOfOrder: true } });
      plan.counts.outOfOrder += 1;
      continue;
    }
    if (verdict.verdict === "jump") {
      plan.reads.push({
        ...base,
        asset: null,
        locationId: null,
        meta: { ...base.meta, rejected: "jump", impliedSpeedMps: round(verdict.impliedSpeedMps) },
      });
      plan.counts.rejected += 1;
      continue;
    }

    for (const fence of fences) {
      const side = containment(fence, point, f.accuracyM);
      let st = states.get(fence.id);
      if (!st) {
        if (evaluatedAt === null || evaluatedAt < fence.geometryAt) {
          st = side === "inside" ? { inside: true, since: point.at, pending: null } : OUTSIDE;
          states.set(fence.id, st);
          if (st.inside) touched.add(fence.id);
          continue;
        }
        st = OUTSIDE;
      }
      const step = stepFence(st, side, point, fence.dwellMs);
      if (step.state !== st) {
        states.set(fence.id, step.state);
        touched.add(fence.id);
      }
      if (step.transition) plan.crossings.push({ fence, transition: step.transition });
    }
    const zone = zoneFromFences(fences, (id) => states.get(id)?.inside === true);
    plan.reads.push({
      ...base,
      locationId: zone?.locationId ?? null,
      meta: verdict.reanchored ? { ...base.meta, reanchored: true } : base.meta,
    });
    plan.accepted.push({ ...point, speedMps, reanchored: verdict.reanchored });
    plan.counts.accepted += 1;
  }
  plan.filter = filter;
  for (const r of plan.reads) if (r.meta && !Object.keys(r.meta).length) r.meta = null;
  return plan;
}

async function loadState(deviceId: string): Promise<{ tracker: GpsTracker | null; states: Map<string, FenceState> }> {
  const [{ rows: trackers }, { rows: stateRows }] = await Promise.all([
    pool.query(`SELECT * FROM gps_trackers WHERE device_id = $1`, [deviceId]),
    pool.query(`SELECT * FROM geofence_states WHERE device_id = $1`, [deviceId]),
  ]);
  const t = trackers[0] as Record<string, unknown> | undefined;
  const tracker: GpsTracker | null = t
    ? {
        deviceId: t.device_id as string,
        status: t.status as GpsTracker["status"],
        statusAt: t.status_at as Date,
        lastLat: t.last_lat as number | null,
        lastLng: t.last_lng as number | null,
        lastAccuracyM: t.last_accuracy_m as number | null,
        lastFixAt: t.last_fix_at as Date | null,
        rejectStreak: t.reject_streak as number,
        rejectLat: t.reject_lat as number | null,
        rejectLng: t.reject_lng as number | null,
        rejectAccuracyM: t.reject_accuracy_m as number | null,
        rejectAt: t.reject_at as Date | null,
        recent: (t.recent as RecentFix[]) ?? [],
        batteryAlerted: t.battery_alerted as boolean,
        evaluatedAt: t.evaluated_at as Date | null,
        updatedAt: t.updated_at as Date,
      }
    : null;
  const states = new Map<string, FenceState>();
  for (const s of stateRows as Record<string, unknown>[]) {
    states.set(s.geofence_id as string, {
      inside: s.inside as boolean,
      since: s.since ? new Date(s.since as string).getTime() : null,
      pending:
        s.pending_inside === null || s.pending_since === null
          ? null
          : {
              inside: s.pending_inside as boolean,
              since: new Date(s.pending_since as string).getTime(),
              lat: s.pending_lat as number,
              lng: s.pending_lng as number,
            },
    });
  }
  return { tracker, states };
}

type EventRow = { id: number; crossing: Crossing };

async function commitState(
  client: PoolClient,
  deviceId: string,
  now: Date,
  plan: Plan,
  recent: RecentFix[],
  battery: { alerted: boolean },
  device: TrackingDevice,
  shipmentIds: string[],
): Promise<EventRow[]> {
  const f = plan.filter;
  const d = (ms: number | null | undefined) => (ms == null ? null : new Date(ms));
  await client.query(
    `INSERT INTO gps_trackers (device_id, last_lat, last_lng, last_accuracy_m, last_fix_at, reject_streak,
                               reject_lat, reject_lng, reject_accuracy_m, reject_at, recent, battery_alerted,
                               evaluated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, now())
     ON CONFLICT (device_id) DO UPDATE SET
       last_lat = excluded.last_lat, last_lng = excluded.last_lng, last_accuracy_m = excluded.last_accuracy_m,
       last_fix_at = excluded.last_fix_at, reject_streak = excluded.reject_streak, reject_lat = excluded.reject_lat,
       reject_lng = excluded.reject_lng, reject_accuracy_m = excluded.reject_accuracy_m, reject_at = excluded.reject_at,
       recent = excluded.recent, battery_alerted = excluded.battery_alerted,
       evaluated_at = COALESCE(excluded.evaluated_at, gps_trackers.evaluated_at), updated_at = now()`,
    [
      deviceId,
      f.last?.lat ?? null,
      f.last?.lng ?? null,
      f.last?.accuracyM ?? null,
      d(f.last?.at),
      f.rejectStreak,
      f.lastRejected?.lat ?? null,
      f.lastRejected?.lng ?? null,
      f.lastRejected?.accuracyM ?? null,
      d(f.lastRejected?.at),
      JSON.stringify(recent),
      battery.alerted,
      plan.counts.accepted ? now : null,
    ],
  );

  const gone: string[] = [];
  const kept: { id: string; s: FenceState }[] = [];
  for (const id of plan.touched) {
    const s = plan.states.get(id)!;
    if (!s.inside && !s.pending) gone.push(id);
    else kept.push({ id, s });
  }
  if (gone.length) {
    await client.query(`DELETE FROM geofence_states WHERE device_id = $1 AND geofence_id = ANY($2::uuid[])`, [
      deviceId,
      gone,
    ]);
  }
  if (kept.length) {
    // A fence deleted since the batch started is skipped rather than failing it.
    await client.query(
      `INSERT INTO geofence_states (device_id, geofence_id, inside, since, pending_inside, pending_since,
                                    pending_lat, pending_lng, updated_at)
       SELECT $1, t.geofence_id, t.inside, t.since, t.pending_inside, t.pending_since, t.pending_lat, t.pending_lng, now()
         FROM unnest($2::uuid[], $3::boolean[], $4::timestamptz[], $5::boolean[], $6::timestamptz[],
                     $7::float8[], $8::float8[])
           AS t(geofence_id, inside, since, pending_inside, pending_since, pending_lat, pending_lng)
        WHERE EXISTS (SELECT 1 FROM geofences g WHERE g.id = t.geofence_id)
       ON CONFLICT (device_id, geofence_id) DO UPDATE SET
         inside = excluded.inside, since = excluded.since, pending_inside = excluded.pending_inside,
         pending_since = excluded.pending_since, pending_lat = excluded.pending_lat,
         pending_lng = excluded.pending_lng, updated_at = now()`,
      [
        deviceId,
        kept.map((k) => k.id),
        kept.map((k) => k.s.inside),
        kept.map((k) => d(k.s.since)),
        kept.map((k) => k.s.pending?.inside ?? null),
        kept.map((k) => d(k.s.pending?.since)),
        kept.map((k) => k.s.pending?.lat ?? null),
        kept.map((k) => k.s.pending?.lng ?? null),
      ],
    );
  }

  const events: EventRow[] = [];
  for (const c of plan.crossings) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO geofence_events (geofence_id, geofence_name, location_id, device_id, item_id, unit_id,
                                    shipment_ids, kind, occurred_at, confirmed_at, lat, lng)
       SELECT $1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10, $11, $12
        WHERE EXISTS (SELECT 1 FROM geofences WHERE id = $1)
       RETURNING id`,
      [
        c.fence.id,
        c.fence.name,
        c.fence.locationId,
        deviceId,
        device.itemId,
        device.unitId,
        shipmentIds,
        c.transition.kind,
        new Date(c.transition.occurredAt),
        new Date(c.transition.confirmedAt),
        c.transition.lat,
        c.transition.lng,
      ],
    );
    if (rows[0]) events.push({ id: Number(rows[0].id), crossing: c });
  }
  return events;
}

/**
 * Store one tracker's reports. See the module comment for the order of work.
 */
export function ingestTrackerReports(
  device: TrackingDevice,
  reports: readonly GpsReport[],
  opts: { now?: Date } = {},
): Promise<GpsIngestResult> {
  return serialize(device.id, () => ingestOne(device, reports, opts.now ?? new Date()));
}

async function ingestOne(device: TrackingDevice, reports: readonly GpsReport[], now: Date): Promise<GpsIngestResult> {
  const [fences, { tracker, states }, tracked] = await Promise.all([
    activeFences(now.getTime()),
    loadState(device.id),
    trackedShipments(device.id),
  ]);
  const plan = planBatch(device, tracker, states, fences, reports, now);

  // 1. The evidence first. If this fails nothing else is written, and the
  // tracker's resend is judged against the same memory.
  const stored = await recordSightings(device, plan.reads, { now, batteryPct: plan.batteryPct });
  // recordSightings shows the batch's newest coordinates on the device, which
  // may be a jump or a late fix; the device shows the last believed one.
  if (plan.counts.fixes && plan.filter.last) {
    await updateDeviceStatus(device.id, { lat: plan.filter.last.lat, lng: plan.filter.last.lng });
  }

  // A re-anchor means the fixes before it were wrong (or this tracker was
  // moved while switched off), so the track starts again from there.
  const restart = plan.accepted.map((a) => a.reanchored).lastIndexOf(true);
  const previousRecent = restart >= 0 ? [] : (tracker?.recent ?? []);
  const accepted = plan.accepted.slice(Math.max(0, restart)).map((a) => ({ lat: a.lat, lng: a.lng, at: a.at }));
  const recent = pushRecent(previousRecent, accepted);
  const settings = readTrackerSettings(device.settings);
  const threshold = batteryLowFor(settings);
  let alerted = tracker?.batteryAlerted ?? false;
  let batteryLow = false;
  if (plan.batteryPct !== null) {
    if (plan.batteryPct <= threshold && !alerted) {
      alerted = true;
      batteryLow = true;
    } else if (plan.batteryPct >= Math.min(100, threshold + 10)) {
      // Charged or replaced: warn again next time it runs down.
      alerted = false;
    }
  }

  // 2. The tracker's memory and the crossings, together.
  const shipmentIds = tracked.map((t) => t.shipment.id);
  const client = await pool.connect();
  let events: EventRow[];
  try {
    await client.query("BEGIN");
    events = await commitState(client, device.id, now, plan, recent, { alerted }, device, shipmentIds);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // 3. After commit: tell the world, then move shipments along.
  const actor = deviceActor(device);
  for (const { id, crossing } of events) {
    const { fence, transition } = crossing;
    const entry = await publish(
      `geofence.${transition.kind}`,
      {
        eventId: id,
        geofenceId: fence.id,
        geofenceName: fence.name,
        locationId: fence.locationId,
        deviceId: device.id,
        deviceName: device.name,
        itemId: device.itemId,
        unitId: device.unitId,
        shipmentIds,
        occurredAt: new Date(transition.occurredAt).toISOString(),
        confirmedAt: new Date(transition.confirmedAt).toISOString(),
        lat: transition.lat,
        lng: transition.lng,
      },
      { actor, subject: geofenceSubject(fence.id) },
    );
    if (entry) await pool.query(`UPDATE geofence_events SET audit_id = $2 WHERE id = $1`, [id, entry.id]);
  }
  if (tracked.length && (plan.accepted.length || plan.crossings.length)) {
    await applyShipmentProgress({
      device,
      tracked,
      crossings: events.map((e) => e.crossing),
      track: [...previousRecent, ...accepted],
      fences,
      now,
    });
  }
  if (batteryLow) await warnBattery(device, plan.batteryPct!, threshold);

  if (plan.counts.rejected) {
    logger.info("gps.ingest.rejected", { deviceId: device.id, rejected: plan.counts.rejected });
  }
  return {
    deviceId: device.id,
    ...plan.counts,
    entered: events.filter((e) => e.crossing.transition.kind === "entered").length,
    exited: events.filter((e) => e.crossing.transition.kind === "exited").length,
    recorded: stored.recorded,
    suppressed: stored.suppressed,
    moved: stored.moved,
  };
}

async function warnBattery(device: TrackingDevice, pct: number, threshold: number): Promise<void> {
  logger.info("gps.tracker.battery_low", { deviceId: device.id, pct });
  await publish(
    "tracker.battery_low",
    { deviceId: device.id, deviceName: device.name, batteryPct: pct, threshold, itemId: device.itemId },
    { actor: deviceActor(device), subject: trackerSubject(device.id) },
  );
  // Best effort: Pushover or Wazuh when configured, silently nothing otherwise.
  await notify({
    title: "Tracker battery low",
    message: `${device.name} is at ${pct}% battery. Charge or replace it before its next trip.`,
  }).catch((err) => logger.warn("gps.notify.failed", { err: describeError(err) }));
}

/**
 * The GPS tracker a payload names by its own id (IMEI, Traccar uniqueId),
 * registered on first sight when `register` is set, as the reader bridge's
 * readers are. Null when there is none and registering is not allowed.
 */
export async function trackerForKey(
  key: string,
  opts: { name?: string | null; register: boolean },
): Promise<TrackingDevice | null> {
  const externalId = key.trim().slice(0, 200);
  if (!externalId) return null;
  const find = async () => {
    const [row] = await db
      .select()
      .from(trackingDevices)
      .where(and(eq(trackingDevices.kind, "gps_tracker"), eq(trackingDevices.externalId, externalId)))
      .limit(1);
    return row ?? null;
  };
  const found = await find();
  if (found || !opts.register) return found;
  try {
    const { device } = await createDevice(
      { kind: "gps_tracker", name: opts.name?.trim() || `Tracker ${externalId}`, externalId },
      { issueToken: false },
    );
    logger.info("gps.tracker.auto_registered", { id: device.id, externalId });
    return getDeviceRow(device.id);
  } catch (err) {
    // Another request registered it first.
    if (err instanceof HttpError && err.status === 409) return find();
    throw err;
  }
}

export type PayloadResult = Omit<GpsIngestResult, "deviceId"> & {
  deviceId: string;
  /** Trackers the payload reported for. */
  trackers: number;
  /** Messages with nothing to store. */
  skipped: number;
  /** Reports for other trackers from a device not allowed to relay them. */
  refused: number;
};

/**
 * Store a whole payload for the device that posted it.
 *
 * A tracker posting for itself (its own token, or the OsmAnd app on a phone)
 * owns every report, whatever id the app puts in them. A relay (a Traccar
 * server, or anything posting with the shared INGEST_TOKEN) reports for many
 * trackers, matched by their own ids and registered the first time they
 * appear. `forward` is for payloads that always name a tracker (Traccar's
 * forwarding): from a device that is not a relay, only reports carrying its
 * own id are taken, so one tracker's token cannot write another's history.
 */
export async function ingestPayload(
  auth: TrackingDevice,
  via: "device" | "ingest",
  payload: { reports: GpsReport[]; skipped: number },
  mode: "own" | "forward",
  opts: { now?: Date } = {},
): Promise<PayloadResult> {
  const relay = via === "ingest" || readTrackerSettings(auth.settings).relay;
  const own = auth.externalId?.trim() ?? null;
  const groups = new Map<string, { device: TrackingDevice; reports: GpsReport[] }>();
  const add = (device: TrackingDevice, r: GpsReport) => {
    const g = groups.get(device.id) ?? { device, reports: [] };
    g.reports.push(r);
    groups.set(device.id, g);
  };
  let refused = 0;
  const byKey = new Map<string, TrackingDevice | null>();
  for (const r of payload.reports) {
    const key = r.deviceKey?.trim() || null;
    if (!key || key === own || (!relay && mode === "own")) {
      add(auth, r);
      continue;
    }
    if (!relay) {
      refused += 1;
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, await trackerForKey(key, { name: r.deviceName, register: true }));
    const target = byKey.get(key);
    if (target && !target.disabled) add(target, r);
    else refused += 1;
  }

  const total: PayloadResult = {
    deviceId: auth.id,
    trackers: groups.size,
    fixes: 0,
    accepted: 0,
    outOfOrder: 0,
    rejected: 0,
    entered: 0,
    exited: 0,
    recorded: 0,
    suppressed: 0,
    moved: 0,
    skipped: payload.skipped,
    refused,
  };
  for (const { device, reports } of groups.values()) {
    const r = await ingestTrackerReports(device, reports, opts);
    for (const k of ["fixes", "accepted", "outOfOrder", "rejected", "entered", "exited", "recorded", "suppressed", "moved"] as const) {
      total[k] += r[k];
    }
  }
  // A relay reporting only for others is still heard.
  if (!groups.has(auth.id)) await updateDeviceStatus(auth.id, { seenAt: opts.now ?? new Date() });
  return total;
}
