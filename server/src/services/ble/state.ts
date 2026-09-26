import { pool } from "../../db/client";
import type { BleAlertKind } from "../../db/schema";

/**
 * Database side of the presence engine: each tag's state, alerts, and phone
 * rooms. Everything here is a fixed number of queries per call, and the sweeps
 * are safe to run in every replica at once.
 */

export type TagStateRow = {
  tagKey: string;
  deviceId: string | null;
  identity: string;
  itemId: string | null;
  unitId: string | null;
  locationId: string | null;
  previousLocationId: string | null;
  zoneSince: Date | null;
  gatewayId: string | null;
  rssi: number | null;
  lastHeardAt: Date;
  missingSince: Date | null;
  batteryMv: number | null;
  temperatureC: number | null;
};

function rowToState(r: Record<string, unknown>): TagStateRow {
  return {
    tagKey: r.tag_key as string,
    deviceId: (r.device_id as string) ?? null,
    identity: r.identity as string,
    itemId: (r.item_id as string) ?? null,
    unitId: (r.unit_id as string) ?? null,
    locationId: (r.location_id as string) ?? null,
    previousLocationId: (r.previous_location_id as string) ?? null,
    zoneSince: r.zone_since ? new Date(r.zone_since as string) : null,
    gatewayId: (r.gateway_id as string) ?? null,
    rssi: r.rssi == null ? null : Number(r.rssi),
    lastHeardAt: new Date(r.last_heard_at as string),
    missingSince: r.missing_since ? new Date(r.missing_since as string) : null,
    batteryMv: r.battery_mv == null ? null : Number(r.battery_mv),
    temperatureC: r.temperature_c == null ? null : Number(r.temperature_c),
  };
}

export async function loadStates(keys: readonly string[]): Promise<Map<string, TagStateRow>> {
  if (!keys.length) return new Map();
  const { rows } = await pool.query("SELECT * FROM ble_tag_state WHERE tag_key = ANY($1::text[])", [keys]);
  return new Map(rows.map((r) => [r.tag_key as string, rowToState(r)]));
}

export type StateWrite = Omit<TagStateRow, "missingSince" | "previousLocationId">;

/**
 * Upsert tag states. A tag written here was just heard, so it is no longer
 * missing; returns the tags that were, with when they went missing.
 *
 * Only ever moves last_heard_at forward, keeps the stored battery and
 * temperature when a write has none, and remembers the room a tag left.
 */
export async function writeStates(rows: readonly StateWrite[]): Promise<Map<string, Date>> {
  const found = new Map<string, Date>();
  if (!rows.length) return found;
  const { rows: out } = await pool.query<{ tag_key: string; was_missing: Date | null }>(
    `WITH input AS (
       SELECT * FROM unnest($1::text[], $2::uuid[], $3::text[], $4::uuid[], $5::uuid[], $6::uuid[],
                            $7::timestamptz[], $8::uuid[], $9::real[], $10::timestamptz[], $11::int[], $12::real[])
         AS t(tag_key, device_id, identity, item_id, unit_id, location_id,
              zone_since, gateway_id, rssi, last_heard_at, battery_mv, temperature_c)
     ),
     prev AS (
       SELECT s.tag_key, s.missing_since FROM ble_tag_state s JOIN input i USING (tag_key)
     )
     INSERT INTO ble_tag_state AS s (tag_key, device_id, identity, item_id, unit_id, location_id,
                                     zone_since, gateway_id, rssi, last_heard_at, battery_mv, temperature_c, updated_at)
     SELECT i.tag_key, i.device_id, i.identity,
            -- The asset may have been deleted since the batch resolved it.
            (SELECT id FROM items WHERE id = i.item_id), (SELECT id FROM item_units WHERE id = i.unit_id),
            (SELECT id FROM locations WHERE id = i.location_id),
            i.zone_since, (SELECT id FROM tracking_devices WHERE id = i.gateway_id), i.rssi, i.last_heard_at,
            i.battery_mv, i.temperature_c, now()
       FROM input i
      WHERE i.device_id IS NULL OR EXISTS (SELECT 1 FROM tracking_devices d WHERE d.id = i.device_id)
     ON CONFLICT (tag_key) DO UPDATE SET
       device_id = excluded.device_id,
       identity = excluded.identity,
       item_id = excluded.item_id,
       unit_id = excluded.unit_id,
       location_id = excluded.location_id,
       previous_location_id = CASE WHEN excluded.location_id IS DISTINCT FROM s.location_id
                                   THEN s.location_id ELSE s.previous_location_id END,
       zone_since = excluded.zone_since,
       gateway_id = excluded.gateway_id,
       rssi = excluded.rssi,
       last_heard_at = GREATEST(s.last_heard_at, excluded.last_heard_at),
       battery_mv = COALESCE(excluded.battery_mv, s.battery_mv),
       temperature_c = COALESCE(excluded.temperature_c, s.temperature_c),
       missing_since = NULL,
       updated_at = now()
     RETURNING s.tag_key, (SELECT p.missing_since FROM prev p WHERE p.tag_key = s.tag_key) AS was_missing`,
    [
      rows.map((r) => r.tagKey),
      rows.map((r) => r.deviceId),
      rows.map((r) => r.identity),
      rows.map((r) => r.itemId),
      rows.map((r) => r.unitId),
      rows.map((r) => r.locationId),
      rows.map((r) => r.zoneSince),
      rows.map((r) => r.gatewayId),
      rows.map((r) => r.rssi),
      rows.map((r) => r.lastHeardAt),
      rows.map((r) => (r.batteryMv === null ? null : Math.round(r.batteryMv))),
      rows.map((r) => r.temperatureC),
    ],
  );
  for (const r of out) if (r.was_missing) found.set(r.tag_key, new Date(r.was_missing));
  return found;
}

export type NewAlert = {
  kind: BleAlertKind;
  tagKey?: string | null;
  deviceId?: string | null;
  itemId?: string | null;
  locationId?: string | null;
  detail: Record<string, unknown>;
};

export async function insertAlerts(alerts: readonly NewAlert[]): Promise<void> {
  if (!alerts.length) return;
  await pool.query(
    `INSERT INTO ble_alerts (kind, tag_key, device_id, item_id, location_id, detail)
     SELECT t.kind, t.tag_key, (SELECT id FROM tracking_devices WHERE id = t.device_id),
            (SELECT id FROM items WHERE id = t.item_id), (SELECT id FROM locations WHERE id = t.location_id),
            t.detail::jsonb
       FROM unnest($1::text[], $2::text[], $3::uuid[], $4::uuid[], $5::uuid[], $6::text[])
         AS t(kind, tag_key, device_id, item_id, location_id, detail)
     ON CONFLICT DO NOTHING`,
    [
      alerts.map((a) => a.kind),
      alerts.map((a) => a.tagKey ?? null),
      alerts.map((a) => a.deviceId ?? null),
      alerts.map((a) => a.itemId ?? null),
      alerts.map((a) => a.locationId ?? null),
      alerts.map((a) => JSON.stringify(a.detail)),
    ],
  );
}

/** Close the open "missing" alerts of tags that have been heard again. */
export async function resolveMissing(tagKeys: readonly string[]): Promise<void> {
  if (!tagKeys.length) return;
  await pool.query(
    `UPDATE ble_alerts SET resolved_at = now()
      WHERE kind = 'missing' AND resolved_at IS NULL AND tag_key = ANY($1::text[])`,
    [tagKeys],
  );
}

export type MissingTag = {
  tagKey: string;
  deviceId: string | null;
  deviceName: string | null;
  identity: string;
  itemId: string | null;
  itemName: string | null;
  unitId: string | null;
  locationId: string | null;
  locationName: string | null;
  lastHeardAt: Date;
  minutes: number;
};

/**
 * Mark tags missing that have not been heard for their timeout (the tag's
 * missingMinutes, else `defaultMinutes`; 0 means never), and open one alert
 * each. Returns the tags that went missing in this call only, so each is
 * reported once however many replicas sweep.
 */
export async function sweepMissing(now: Date, defaultMinutes: number): Promise<MissingTag[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `WITH due AS (
         SELECT s.tag_key, m.minutes
           FROM ble_tag_state s
           LEFT JOIN tracking_devices d ON d.id = s.device_id
           CROSS JOIN LATERAL (
             SELECT CASE WHEN d.settings->>'missingMinutes' ~ '^[0-9]+(\\.[0-9]+)?$'
                         THEN (d.settings->>'missingMinutes')::float8 ELSE $2::float8 END AS minutes
           ) m
          WHERE s.missing_since IS NULL
            AND (d.id IS NULL OR NOT d.disabled)
            AND m.minutes > 0
            AND s.last_heard_at < $1::timestamptz - make_interval(secs => m.minutes * 60)
          FOR UPDATE OF s SKIP LOCKED
       )
       UPDATE ble_tag_state s SET missing_since = $1, updated_at = now()
         FROM due
        WHERE s.tag_key = due.tag_key
       RETURNING s.*, due.minutes,
                 (SELECT name FROM tracking_devices WHERE id = s.device_id) AS device_name,
                 (SELECT name FROM items WHERE id = s.item_id) AS item_name,
                 (SELECT name FROM locations WHERE id = s.location_id) AS location_name`,
      [now, defaultMinutes],
    );
    const missing: MissingTag[] = rows.map((r) => ({
      tagKey: r.tag_key,
      deviceId: r.device_id ?? null,
      deviceName: r.device_name ?? null,
      identity: r.identity,
      itemId: r.item_id ?? null,
      itemName: r.item_name ?? null,
      unitId: r.unit_id ?? null,
      locationId: r.location_id ?? null,
      locationName: r.location_name ?? null,
      lastHeardAt: new Date(r.last_heard_at),
      minutes: Number(r.minutes),
    }));
    if (missing.length) {
      await client.query(
        `INSERT INTO ble_alerts (kind, tag_key, device_id, item_id, location_id, detail)
         SELECT 'missing', t.tag_key, t.device_id, t.item_id, t.location_id, t.detail::jsonb
           FROM unnest($1::text[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[])
             AS t(tag_key, device_id, item_id, location_id, detail)
         ON CONFLICT DO NOTHING`,
        [
          missing.map((m) => m.tagKey),
          missing.map((m) => m.deviceId),
          missing.map((m) => m.itemId),
          missing.map((m) => m.locationId),
          missing.map((m) =>
            JSON.stringify({
              identity: m.identity,
              tagName: m.deviceName,
              itemName: m.itemName,
              locationName: m.locationName,
              lastHeardAt: m.lastHeardAt.toISOString(),
              minutes: m.minutes,
            }),
          ),
        ],
      );
    }
    await client.query("COMMIT");
    return missing;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type LowBattery = {
  deviceId: string;
  kind: string;
  name: string;
  batteryPct: number;
  itemId: string | null;
  itemName: string | null;
};

/**
 * Open a battery alert for each BLE device at or below `thresholdPct` that
 * does not already have one, and close alerts for devices whose battery has
 * been replaced (10 points of headroom, so a level wobbling around the
 * threshold is not reported over and over). Returns the new alerts.
 */
export async function sweepBattery(thresholdPct: number): Promise<LowBattery[]> {
  await pool.query(
    `UPDATE ble_alerts a SET resolved_at = now()
      WHERE a.kind = 'battery_low' AND a.resolved_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tracking_devices d
                         WHERE d.id = a.device_id AND NOT d.disabled
                           AND d.battery_pct IS NOT NULL AND d.battery_pct <= $1 + 10)`,
    [thresholdPct],
  );
  const { rows } = await pool.query(
    `WITH low AS (
       SELECT d.id, d.kind, d.name, d.battery_pct, d.item_id, i.name AS item_name
         FROM tracking_devices d
         LEFT JOIN items i ON i.id = d.item_id
        WHERE d.kind IN ('ble_tag', 'ble_beacon', 'ble_gateway') AND NOT d.disabled
          AND d.battery_pct IS NOT NULL AND d.battery_pct <= $1
     )
     INSERT INTO ble_alerts (kind, device_id, item_id, detail)
     SELECT 'battery_low', low.id, low.item_id,
            jsonb_build_object('name', low.name, 'kind', low.kind, 'batteryPct', low.battery_pct,
                               'itemName', low.item_name)
       FROM low
     ON CONFLICT (device_id) WHERE kind = 'battery_low' AND resolved_at IS NULL DO NOTHING
     RETURNING device_id, item_id, detail`,
    [thresholdPct],
  );
  return rows.map((r) => ({
    deviceId: r.device_id,
    kind: r.detail.kind,
    name: r.detail.name,
    batteryPct: Number(r.detail.batteryPct),
    itemId: r.item_id ?? null,
    itemName: r.detail.itemName ?? null,
  }));
}

export type AlertRow = {
  id: number;
  kind: BleAlertKind;
  tagKey: string | null;
  deviceId: string | null;
  itemId: string | null;
  locationId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
  notifiedAt: string | null;
};

const alertRow = (r: Record<string, unknown>): AlertRow => ({
  id: Number(r.id),
  kind: r.kind as BleAlertKind,
  tagKey: (r.tag_key as string) ?? null,
  deviceId: (r.device_id as string) ?? null,
  itemId: (r.item_id as string) ?? null,
  locationId: (r.location_id as string) ?? null,
  detail: (r.detail as Record<string, unknown>) ?? {},
  createdAt: new Date(r.created_at as string).toISOString(),
  resolvedAt: r.resolved_at ? new Date(r.resolved_at as string).toISOString() : null,
  notifiedAt: r.notified_at ? new Date(r.notified_at as string).toISOString() : null,
});

/**
 * Claim alerts not yet sent in a digest. Claiming marks them sent before the
 * digest goes out, so two replicas never send the same alert; a digest that
 * then fails to deliver is not retried, like every other best-effort alert.
 * Alerts older than a day are claimed but left out, so switching notifications
 * on later does not replay a backlog.
 */
export async function claimDigest(limit = 200): Promise<AlertRow[]> {
  const { rows } = await pool.query(
    `UPDATE ble_alerts SET notified_at = now()
      WHERE id IN (SELECT id FROM ble_alerts WHERE notified_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [limit],
  );
  const dayAgo = Date.now() - 24 * 60 * 60_000;
  return rows
    .map(alertRow)
    .filter((a) => new Date(a.createdAt).getTime() >= dayAgo)
    .sort((a, b) => a.id - b.id);
}

export async function listAlerts(opts: { open?: boolean; limit?: number; before?: number } = {}): Promise<AlertRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { rows } = await pool.query(
    `SELECT * FROM ble_alerts
      WHERE ($1::boolean IS NOT TRUE OR (resolved_at IS NULL AND kind <> 'after_hours_move'))
        AND ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC LIMIT $3`,
    [opts.open ?? false, opts.before ?? null, limit],
  );
  return rows.map(alertRow);
}

/** Resolved and old alerts go after `days`; open ones stay until they resolve. */
export async function pruneAlerts(days = 90): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM ble_alerts
      WHERE created_at < now() - make_interval(days => $1::int)
        AND (resolved_at IS NOT NULL OR kind = 'after_hours_move')`,
    [days],
  );
  return rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

export type PhoneRoomWrite = {
  deviceId: string;
  userOid: string | null;
  locationId: string;
  beaconId: string | null;
  rssi: number | null;
  observedAt: Date;
  expiresAt: Date;
};

/** Store a phone's current room. Returns when it entered that room. */
export async function writePhoneRoom(r: PhoneRoomWrite): Promise<Date | null> {
  const { rows } = await pool.query<{ entered_at: Date }>(
    `INSERT INTO ble_phone_rooms AS p (device_id, user_oid, location_id, beacon_id, rssi, entered_at, observed_at, expires_at)
     SELECT $1, $2, $3, (SELECT id FROM tracking_devices WHERE id = $4), $5, $6, $6, $7
      WHERE EXISTS (SELECT 1 FROM locations WHERE id = $3)
     ON CONFLICT (device_id) DO UPDATE SET
       user_oid = excluded.user_oid,
       -- Staying in the same room (and not having expired) keeps the arrival time.
       entered_at = CASE WHEN p.location_id = excluded.location_id AND p.expires_at > excluded.observed_at
                         THEN p.entered_at ELSE excluded.entered_at END,
       location_id = excluded.location_id,
       beacon_id = excluded.beacon_id,
       rssi = excluded.rssi,
       observed_at = GREATEST(p.observed_at, excluded.observed_at),
       expires_at = GREATEST(p.expires_at, excluded.expires_at)
     RETURNING entered_at`,
    [r.deviceId, r.userOid, r.locationId, r.beaconId, r.rssi, r.observedAt, r.expiresAt],
  );
  return rows[0]?.entered_at ? new Date(rows[0].entered_at) : null;
}

export async function prunePhoneRooms(): Promise<number> {
  const { rowCount } = await pool.query("DELETE FROM ble_phone_rooms WHERE expires_at < now() - interval '1 day'");
  return rowCount ?? 0;
}
