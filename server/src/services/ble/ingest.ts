import { inArray } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { trackingDevices, type TrackingDevice } from "../../db/schema";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { publish, type EventActor } from "../event-backbone";
import { readSettings, recordSightings, resolveCodes, updateDeviceStatus, type NormalizedRead } from "../tracking";
import { clampObservedAt } from "../tracking/normalize";
import { interpretAdvert, type GatewayPayload, type Observation } from "./adapters";
import { batteryPctFromMv, macOf } from "./advert";
import { CalibrationStore } from "./calibrate";
import { bleSettings, isOutOfHours, LIVE_MS, presenceConfig, type BleDeviceSettings } from "./config";
import { HeardNearby } from "./heard";
import { PresenceEngine, type ZoneChange } from "./presence";
import { getRegistry, primaryIdentity } from "./registry";
import { insertAlerts, loadStates, resolveMissing, writeStates, type NewAlert, type StateWrite } from "./state";

/**
 * From a gateway's report to positions, moves and alerts.
 *
 * 1. Decode every advertisement (adapters, advert.ts) and drop those below
 *    the gateway's RSSI floor.
 * 2. Work out which tag each one is: a registered ble_tag device by its
 *    identity or MAC (telemetry frames by the MAC their tag last used), or
 *    failing that an item whose identifier is the beacon's identity or MAC.
 *    Everything else goes to the "heard nearby" list and nowhere else.
 * 3. Feed each reading, with the gateway's calibration offset, to the
 *    presence engine (presence.ts), which decides zone changes.
 * 4. Persist through the tracking core's recordSightings: each zone change as
 *    one sighting with the decided zone from the gateway that won it (so
 *    positions, "moved" events and the item's location follow T01's rules,
 *    including that gateway's "Move items when read"), and a tag that stays
 *    put as one sighting per BLE_STORE_SECONDS with no zone, which keeps
 *    "last seen" current without letting a single reading move anything.
 * 5. Keep each tag's state, battery and last-heard time, and publish events.
 *
 * Presence runs on the server's clock. Each batch is shifted so its newest
 * reading lands at the time it arrived, which cancels a gateway clock that
 * runs fast or slow while keeping the spacing of the readings in it; a batch
 * whose newest reading is older than LIVE_MS is a backlog and is stored as
 * history without being judged.
 *
 * Batches are processed one at a time per process, so the engine's decisions
 * reach the database in the order they were made.
 */

export type BleIngestResult = {
  /** Advertisements taken in: decodable and above the RSSI floor. */
  accepted: number;
  /** Accepted advertisements from a known tag. */
  matched: number;
  /** From anything else: kept in memory for "heard nearby" only. */
  unknown: number;
  /** Dropped: below the RSSI floor, or naming nothing. */
  ignored: number;
  /** Entries in the payload that were not advertisements. */
  skipped: number;
  /** Sightings written. */
  recorded: number;
  /** Zone changes the presence engine decided. */
  zoneChanges: number;
  /** "moved" item events written (zone changes of tags attached to an item). */
  moved: number;
};

type Asset = { itemId: string; unitId: string | null };

type TagRef = {
  key: string;
  identity: string;
  device: TrackingDevice | null;
  asset: Asset | null;
  settings: BleDeviceSettings;
};

type Heard = { ref: TagRef; lastAt: number; rssi: number | null; obs: Observation };

type Telemetry = { batteryMv: number | null; batteryPct: number | null; temperatureC: number | null };

export const engine = new PresenceEngine(presenceConfig());
export const calibrations = new CalibrationStore();
export const heardNearby = new HeardNearby();

/** When each tag's last sighting was stored, to pace the "still here" ones. */
const lastStored = new Map<string, number>();
/**
 * The latest battery and temperature per tag. Beacons interleave telemetry
 * frames with their id frames, so the batch that happens to be stored often
 * holds none; this carries the last values forward to it.
 */
const telemetry = new Map<string, Telemetry>();
/** The identity a MAC last advertised, so its telemetry frames find their tag. */
const macAffinity = new Map<string, string>();
/** Item-identifier lookups for unregistered beacons; mostly misses (phones). */
const resolveCache = new Map<string, { asset: Asset | null; at: number }>();
const RESOLVE_TTL_MS = 5 * 60_000;
const MAX_CACHE = 50_000;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHE) map.delete(map.keys().next().value!);
}

let queue: Promise<unknown> = Promise.resolve();

/** Run batches one after another, whichever route or broker they came from. */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export const deviceActor = (d: Pick<TrackingDevice, "id" | "name">): EventActor => ({
  kind: "device",
  id: d.id,
  name: d.name,
});

/** The asset a tag device follows. */
const assetOf = (d: TrackingDevice): Asset | null => (d.itemId ? { itemId: d.itemId, unitId: d.unitId ?? null } : null);

function tagRef(d: TrackingDevice): TagRef {
  return { key: d.id, identity: primaryIdentity(d), device: d, asset: assetOf(d), settings: bleSettings(d.settings) };
}

/**
 * The device as recordSightings should see it for engine output: its RSSI
 * floor has already been applied to the raw readings (engine values are
 * smoothed and offset, and must not be filtered again), and for "still here"
 * sightings its zone is removed, so that they update last seen but never
 * decide a zone on their own.
 */
function forRecording(d: TrackingDevice, unzoned: boolean): TrackingDevice {
  const settings = { ...(d.settings ?? {}) };
  delete settings.rssiFloor;
  return { ...d, settings, ...(unzoned ? { locationId: null } : {}) };
}

/**
 * Shift a batch onto the server's clock. Returns each observation's time in
 * epoch ms, or null for a backlog reading the engine must not judge.
 */
function alignTimes(obs: readonly Observation[], now: number): (number | null)[] {
  let newest = -Infinity;
  for (const o of obs) if (o.at) newest = Math.max(newest, o.at.getTime());
  const skew = Number.isFinite(newest) && now - newest <= LIVE_MS ? now - newest : 0;
  return obs.map((o) => {
    if (!o.at) return now;
    const at = Math.min(o.at.getTime() + skew, now);
    return at >= now - LIVE_MS ? at : null;
  });
}

/** Resolve beacons with no ble_tag device through item identifiers, cached. */
async function resolveUnregistered(codes: string[], now: number): Promise<Map<string, Asset | null>> {
  const out = new Map<string, Asset | null>();
  const ask: string[] = [];
  for (const c of codes) {
    const hit = resolveCache.get(c);
    if (hit && now - hit.at < RESOLVE_TTL_MS) out.set(c, hit.asset);
    else ask.push(c);
  }
  if (ask.length) {
    // A MAC stored on an item is usually written bare ("AA:BB:…"), which the
    // tracking core's matching compares without separators.
    const query = new Set<string>();
    for (const c of ask) {
      query.add(c);
      const mac = macOf(c);
      if (mac) query.add(mac);
    }
    const found = await resolveCodes(query);
    for (const c of ask) {
      const hit = found.get(c) ?? (macOf(c) ? found.get(macOf(c)!) : undefined);
      const asset = hit ? { itemId: hit.itemId, unitId: hit.unitId } : null;
      remember(resolveCache, c, { asset, at: now });
      out.set(c, asset);
    }
  }
  return out;
}

async function devicesById(ids: string[]): Promise<Map<string, TrackingDevice>> {
  if (!ids.length) return new Map();
  const rows = await db.select().from(trackingDevices).where(inArray(trackingDevices.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

async function names(itemIds: string[], locationIds: string[]) {
  const [items, locs] = await Promise.all([
    itemIds.length
      ? pool.query<{ id: string; name: string }>("SELECT id, name FROM items WHERE id = ANY($1::uuid[])", [itemIds])
      : { rows: [] },
    locationIds.length
      ? pool.query<{ id: string; name: string }>("SELECT id, name FROM locations WHERE id = ANY($1::uuid[])", [
          locationIds,
        ])
      : { rows: [] },
  ]);
  return {
    item: new Map(items.rows.map((r) => [r.id, r.name])),
    location: new Map(locs.rows.map((r) => [r.id, r.name])),
  };
}

/** Process one gateway report. Serialized; see the module comment. */
export function processGatewayReport(
  gateway: TrackingDevice,
  payload: GatewayPayload,
  opts: { now?: Date } = {},
): Promise<BleIngestResult> {
  return serial(() => ingest(gateway, payload, opts.now ?? new Date()));
}

async function ingest(gateway: TrackingDevice, payload: GatewayPayload, now: Date): Promise<BleIngestResult> {
  const nowMs = now.getTime();
  const result: BleIngestResult = {
    accepted: 0,
    matched: 0,
    unknown: 0,
    ignored: 0,
    skipped: payload.skipped,
    recorded: 0,
    zoneChanges: 0,
    moved: 0,
  };
  if (gateway.disabled) {
    result.ignored = payload.adverts.length;
    return result;
  }
  const floor = readSettings(gateway.settings).rssiFloor;
  const offset = bleSettings(gateway.settings).rssiOffset;

  // 1. Decode and filter.
  const obs: Observation[] = [];
  for (const raw of payload.adverts) {
    const o = interpretAdvert(raw);
    if ((!o.identity && !o.mac) || (o.rssi !== null && floor != null && o.rssi < floor)) {
      result.ignored += 1;
      continue;
    }
    obs.push(o);
  }
  result.accepted = obs.length;
  const times = alignTimes(obs, nowMs);

  // 2. Which tag each one is.
  const registry = await getRegistry();
  const refs: (TagRef | null)[] = obs.map((o) => {
    if (o.identity && o.mac) remember(macAffinity, o.mac, o.identity);
    const viaMac = o.mac && !o.identity ? macAffinity.get(o.mac) : undefined;
    const d =
      (o.identity && registry.tags.get(o.identity)) ||
      (o.mac && registry.tags.get(o.mac)) ||
      (viaMac && registry.tags.get(viaMac)) ||
      null;
    return d ? tagRef(d) : null;
  });
  const codeOf = (o: Observation) => o.identity ?? (o.mac ? macAffinity.get(o.mac) : undefined) ?? o.mac!;
  const unresolved = [...new Set(obs.filter((_, i) => !refs[i]).map(codeOf))];
  if (unresolved.length) {
    const assets = await resolveUnregistered(unresolved, nowMs);
    obs.forEach((o, i) => {
      if (refs[i]) return;
      const asset = assets.get(codeOf(o));
      if (asset) refs[i] = { key: codeOf(o), identity: codeOf(o), device: null, asset, settings: bleSettings({}) };
    });
  }

  // 3. Seed tags the engine has not seen since it started, then judge.
  const keys = [...new Set(refs.filter((r): r is TagRef => !!r).map((r) => r.key))];
  const unseeded = keys.filter((k) => !engine.has(k));
  const stored = await loadStates(unseeded);
  for (const k of unseeded) {
    const s = stored.get(k);
    engine.seed(k, s?.locationId ?? null, s?.zoneSince?.getTime() ?? null);
    if (s && !lastStored.has(k)) lastStored.set(k, s.lastHeardAt.getTime());
  }

  const heard = new Map<string, Heard>();
  const changes: { change: ZoneChange; ref: TagRef }[] = [];
  const backlog: NormalizedRead[] = [];
  const calibrating = calibrations.active;
  obs.forEach((o, i) => {
    const ref = refs[i];
    const at = times[i] ?? null;
    if (!ref) {
      result.unknown += 1;
      heardNearby.add(gateway.id, o, at ?? nowMs);
      return;
    }
    result.matched += 1;
    if (at === null) {
      backlog.push({
        code: ref.identity,
        asset: ref.asset,
        tech: "ble",
        rssi: o.rssi,
        observedAt: o.at,
        meta: { frame: o.frame, backlog: true },
      });
      return;
    }
    if (o.rssi !== null) {
      const change = engine.observe(ref.key, gateway.id, gateway.locationId, o.rssi + offset, at);
      if (change) changes.push({ change, ref });
      if (calibrating) calibrations.feed(ref.key, gateway.id, o.rssi, at);
    }
    if (o.batteryMv !== null || o.batteryPct !== null || o.temperatureC !== null) {
      const t = telemetry.get(ref.key);
      remember(telemetry, ref.key, {
        batteryMv: o.batteryMv ?? t?.batteryMv ?? null,
        batteryPct: o.batteryPct ?? t?.batteryPct ?? null,
        temperatureC: o.temperatureC ?? t?.temperatureC ?? null,
      });
    }
    const h = heard.get(ref.key);
    if (!h || at >= h.lastAt) heard.set(ref.key, { ref, lastAt: at, rssi: o.rssi, obs: o });
  });
  result.zoneChanges = changes.length;

  // 4a. Zone changes, each from the gateway that won it.
  const winners = await devicesById(
    [...new Set(changes.map((c) => c.change.gatewayId))].filter((id) => id !== gateway.id),
  );
  winners.set(gateway.id, gateway);
  const byWinner = new Map<string, NormalizedRead[]>();
  for (const { change, ref } of changes) {
    const reads = byWinner.get(change.gatewayId) ?? [];
    reads.push({
      code: ref.identity,
      asset: ref.asset,
      tech: "ble",
      rssi: Math.round(change.rssi * 10) / 10,
      // Decided now, whatever time the deciding reading carried, so it can
      // never be older than a sighting already stored for the asset.
      observedAt: now,
      locationId: change.to,
      meta: { presence: "zone", from: change.from, scores: change.scores },
    });
    byWinner.set(change.gatewayId, reads);
  }
  for (const [winnerId, reads] of byWinner) {
    const winner = winners.get(winnerId) ?? gateway;
    const r = await recordSightings(forRecording(winner, false), reads, { keepDuplicates: true, now });
    result.recorded += r.recorded;
    result.moved += r.moved;
  }

  // 4b. "Still here", paced per tag; and the gateway's own status.
  const storeMs = env.BLE_STORE_SECONDS * 1000;
  const changedKeys = new Set(changes.map((c) => c.ref.key));
  const due: Heard[] = [];
  for (const h of heard.values()) {
    const last = lastStored.get(h.ref.key) ?? -Infinity;
    if (changedKeys.has(h.ref.key) || h.lastAt - last >= storeMs) due.push(h);
  }
  const stillHere: NormalizedRead[] = due.map((h) => ({
    code: h.ref.identity,
    asset: h.ref.asset,
    tech: "ble",
    rssi: h.rssi,
    observedAt: new Date(h.lastAt),
    meta: {
      frame: h.obs.frame,
      ...(h.obs.mac && h.obs.mac !== h.ref.identity ? { mac: macOf(h.obs.mac) } : {}),
      ...(engine.zoneOf(h.ref.key) ? { zone: engine.zoneOf(h.ref.key) } : {}),
    },
  }));
  const r = await recordSightings(forRecording(gateway, true), [...stillHere, ...backlog], {
    keepDuplicates: true,
    batteryPct: payload.batteryPct ?? null,
    now,
  });
  result.recorded += r.recorded;
  if (payload.lat !== undefined && payload.lng !== undefined) {
    await updateDeviceStatus(gateway.id, { lat: payload.lat, lng: payload.lng });
  }

  // 5. Tag state, the tag devices' own status, and events.
  const writes: StateWrite[] = due.map((h) => {
    const snap = engine.snapshot(h.ref.key);
    const change = changes.filter((c) => c.ref.key === h.ref.key).at(-1)?.change;
    const t = telemetry.get(h.ref.key);
    return {
      tagKey: h.ref.key,
      deviceId: h.ref.device?.id ?? null,
      identity: h.ref.identity,
      itemId: h.ref.asset?.itemId ?? null,
      unitId: h.ref.asset?.unitId ?? null,
      locationId: snap?.zoneId ?? null,
      zoneSince: snap?.since != null ? new Date(snap.since) : null,
      gatewayId: change?.gatewayId ?? snap?.heard[0]?.gatewayId ?? gateway.id,
      rssi: change ? change.rssi : (snap?.heard[0]?.rssi ?? h.rssi),
      lastHeardAt: new Date(h.lastAt),
      batteryMv: t?.batteryMv ?? null,
      temperatureC: t?.temperatureC ?? null,
    };
  });
  const found = await writeStates(writes);
  for (const h of due) lastStored.set(h.ref.key, h.lastAt);
  if (lastStored.size > MAX_CACHE) lastStored.delete(lastStored.keys().next().value!);

  await Promise.all(
    due
      .filter((h) => h.ref.device)
      .map((h) => {
        const s = h.ref.settings;
        const t = telemetry.get(h.ref.key);
        const pct =
          t?.batteryPct ?? batteryPctFromMv(t?.batteryMv, s.batteryFullMv ?? undefined, s.batteryEmptyMv ?? undefined);
        return updateDeviceStatus(h.ref.device!.id, { seenAt: new Date(h.lastAt), batteryPct: pct });
      }),
  );

  if (changes.length || found.size) await announce(gateway, changes, found, due, winners);
  if (changes.length) {
    logger.info("ble.ingest.zone_changes", { gatewayId: gateway.id, changes: changes.length, moved: result.moved });
  }
  return result;
}

/** Publish zone changes and returns, and raise out-of-hours alerts. After commit. */
async function announce(
  gateway: TrackingDevice,
  changes: { change: ZoneChange; ref: TagRef }[],
  found: Map<string, Date>,
  heard: Heard[],
  winners: Map<string, TrackingDevice>,
): Promise<void> {
  try {
    const refs = new Map<string, TagRef>();
    for (const c of changes) refs.set(c.ref.key, c.ref);
    for (const h of heard) refs.set(h.ref.key, h.ref);
    const itemIds = [...new Set([...refs.values()].map((r) => r.asset?.itemId).filter((v): v is string => !!v))];
    const locIds = new Set<string>();
    for (const { change } of changes) {
      locIds.add(change.to);
      if (change.from) locIds.add(change.from);
    }
    for (const key of found.keys()) {
      const z = engine.zoneOf(key);
      if (z) locIds.add(z);
    }
    const n = await names(itemIds, [...locIds]);
    const subject = (ref: TagRef) =>
      ref.asset
        ? { type: "item", id: ref.asset.itemId }
        : ref.device
          ? { type: "tracking_device", id: ref.device.id }
          : null;
    const tagData = (ref: TagRef) => ({
      tagId: ref.device?.id ?? null,
      tagName: ref.device?.name ?? null,
      identity: ref.identity,
      itemId: ref.asset?.itemId ?? null,
      unitId: ref.asset?.unitId ?? null,
      itemName: ref.asset ? (n.item.get(ref.asset.itemId) ?? null) : null,
    });

    const alerts: NewAlert[] = [];
    // Published in order, so a move comes before the alert about it.
    const events: (() => Promise<unknown>)[] = [];
    for (const { change, ref } of changes) {
      const winner = winners.get(change.gatewayId) ?? gateway;
      const data = {
        ...tagData(ref),
        from: change.from,
        fromName: change.from ? (n.location.get(change.from) ?? null) : null,
        to: change.to,
        toName: n.location.get(change.to) ?? null,
        gatewayId: winner.id,
        gatewayName: winner.name,
        rssi: Math.round(change.rssi * 10) / 10,
      };
      events.push(() => publish("ble.tag_zone_changed", data, { actor: deviceActor(winner), subject: subject(ref) }));
      // Leaving a room out of hours; a tag's first placement is not leaving anywhere.
      if (change.from && ref.settings.afterHoursAlert && isOutOfHours(new Date(change.at))) {
        alerts.push({
          kind: "after_hours_move",
          tagKey: ref.key,
          deviceId: ref.device?.id ?? null,
          itemId: ref.asset?.itemId ?? null,
          locationId: change.to,
          detail: { ...data, at: new Date(change.at).toISOString() },
        });
        events.push(() =>
          publish("ble.tag_moved_after_hours", data, { actor: deviceActor(winner), subject: subject(ref) }),
        );
      }
    }
    for (const [key, since] of found) {
      const ref = refs.get(key);
      if (!ref) continue;
      const zone = engine.zoneOf(key);
      events.push(() =>
        publish(
          "ble.tag_found",
          {
            ...tagData(ref),
            missingSince: since.toISOString(),
            locationId: zone,
            locationName: zone ? (n.location.get(zone) ?? null) : null,
            gatewayId: gateway.id,
            gatewayName: gateway.name,
          },
          { actor: deviceActor(gateway), subject: subject(ref) },
        ),
      );
    }
    await Promise.all([insertAlerts(alerts), resolveMissing([...found.keys()])]);
    for (const event of events) await event();
  } catch (err) {
    // The sightings are stored; failing to announce them must not fail the post.
    logger.warn("ble.ingest.announce_failed", { gatewayId: gateway.id, err: describeError(err) });
  }
}

/** For tests: forget everything held in memory. */
export function resetBleState(): void {
  engine.clear();
  heardNearby.clear();
  lastStored.clear();
  telemetry.clear();
  macAffinity.clear();
  resolveCache.clear();
}
