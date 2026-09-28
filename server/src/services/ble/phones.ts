import type { TrackingDevice } from "../../db/schema";
import { env } from "../../env";
import { pool } from "../../db/client";
import { updateDeviceStatus } from "../tracking";
import { clampObservedAt } from "../tracking/normalize";
import { interpretAdvert, type GatewayPayload } from "./adapters";
import { bleSettings, phonePresenceConfig } from "./config";
import { serial } from "./ingest";
import { PresenceEngine } from "./presence";
import { getRegistry } from "./registry";
import { writePhoneRoom } from "./state";

/**
 * Pattern B: room beacons stay put, the phone moves. A phone (a companion app,
 * or an Android beacon-scanner app with HTTP logging) posts the beacons it
 * hears; the strongest room beacon, smoothed and with hysteresis like the
 * gateway path, is the room its person is in. Scans on that person's other
 * screens can then default to that room (GET /api/ble/me/room).
 *
 * Only the current room is kept, for BLE_PHONE_ROOM_SECONDS after the last
 * report, and no sighting history: this is where a person is, which Bindex has
 * no need to remember.
 */

export const phoneEngine = new PresenceEngine(phonePresenceConfig());

export type PhoneResult = {
  accepted: number;
  /** Beacons recognised as registered room beacons with a zone. */
  matched: number;
  room: { locationId: string; name: string | null; since: string | null; expiresAt: string } | null;
};

export function processPhoneReport(
  phone: TrackingDevice,
  payload: GatewayPayload,
  opts: { now?: Date } = {},
): Promise<PhoneResult> {
  return serial(async () => {
    const now = opts.now ?? new Date();
    const registry = await getRegistry();
    let matched = 0;
    let latest = -Infinity;
    const beaconFor = new Map<string, string>();
    for (const raw of payload.adverts) {
      const o = interpretAdvert(raw);
      const beacon =
        (o.identity && registry.beacons.get(o.identity)) || (o.mac && registry.beacons.get(o.mac)) || null;
      if (!beacon?.locationId || o.rssi === null) continue;
      matched += 1;
      const at = clampObservedAt(o.at, now, 0).getTime();
      latest = Math.max(latest, at);
      beaconFor.set(beacon.locationId, beacon.id);
      phoneEngine.observe(phone.id, beacon.id, beacon.locationId, o.rssi + bleSettings(beacon.settings).rssiOffset, at);
    }
    await updateDeviceStatus(phone.id, { seenAt: now, batteryPct: payload.batteryPct ?? null });

    const snap = phoneEngine.snapshot(phone.id);
    if (!matched || !snap?.zoneId) return { accepted: payload.adverts.length, matched, room: null };

    const best = snap.heard.find((h) => h.zoneId === snap.zoneId);
    const observedAt = new Date(latest);
    const expiresAt = new Date(latest + env.BLE_PHONE_ROOM_SECONDS * 1000);
    const settings = bleSettings(phone.settings);
    const since = await writePhoneRoom({
      deviceId: phone.id,
      userOid: settings.userOid,
      locationId: snap.zoneId,
      beaconId: best?.gatewayId ?? beaconFor.get(snap.zoneId) ?? null,
      rssi: best?.rssi ?? null,
      observedAt,
      expiresAt,
    });
    const { rows } = await pool.query<{ name: string }>("SELECT name FROM locations WHERE id = $1", [snap.zoneId]);
    return {
      accepted: payload.adverts.length,
      matched,
      room: {
        locationId: snap.zoneId,
        name: rows[0]?.name ?? null,
        since: since?.toISOString() ?? null,
        expiresAt: expiresAt.toISOString(),
      },
    };
  });
}

export type MyRoom = {
  locationId: string;
  locationName: string;
  since: string;
  observedAt: string;
  expiresAt: string;
  phoneId: string;
  phoneName: string | null;
  beaconName: string | null;
};

/** The room the person's phone last placed them in, while it is current. */
export async function roomForUser(userOid: string, now = new Date()): Promise<MyRoom | null> {
  const { rows } = await pool.query(
    `SELECT r.*, l.name AS location_name, d.name AS phone_name, b.name AS beacon_name
       FROM ble_phone_rooms r
       JOIN locations l ON l.id = r.location_id
       LEFT JOIN tracking_devices d ON d.id = r.device_id
       LEFT JOIN tracking_devices b ON b.id = r.beacon_id
      WHERE r.user_oid = $1 AND r.expires_at > $2
      ORDER BY r.observed_at DESC
      LIMIT 1`,
    [userOid, now],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    locationId: r.location_id,
    locationName: r.location_name,
    since: new Date(r.entered_at).toISOString(),
    observedAt: new Date(r.observed_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    phoneId: r.device_id,
    phoneName: r.phone_name ?? null,
    beaconName: r.beacon_name ?? null,
  };
}
