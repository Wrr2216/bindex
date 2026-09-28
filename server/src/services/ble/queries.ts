import { pool } from "../../db/client";
import { notFound } from "../../lib/errors";
import { bleSettings, type BleDeviceSettings } from "./config";
import { engine, heardNearby } from "./ingest";
import type { HeardBy } from "./presence";
import { identitiesOf } from "./registry";

/**
 * Read side of BLE presence: who is in which room, what has gone quiet, which
 * batteries need replacing, and what an item's tag is hearing right now.
 */

export const BLE_KINDS = ["ble_gateway", "ble_beacon", "ble_tag", "mobile"] as const;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

export type TagPresence = {
  tagKey: string;
  tagId: string | null;
  tagName: string | null;
  identity: string;
  itemId: string | null;
  itemName: string | null;
  itemAssetCode: string | null;
  unitId: string | null;
  unitLabel: string | null;
  locationId: string | null;
  locationName: string | null;
  previousLocationId: string | null;
  previousLocationName: string | null;
  zoneSince: string | null;
  gatewayId: string | null;
  gatewayName: string | null;
  rssi: number | null;
  lastHeardAt: string;
  missingSince: string | null;
  batteryPct: number | null;
  batteryMv: number | null;
  temperatureC: number | null;
};

const PRESENCE_SELECT = `
  SELECT s.*, d.name AS tag_name, d.battery_pct,
         i.name AS item_name, i.asset_code AS item_asset_code,
         COALESCE(u.label, u.asset_code) AS unit_label,
         l.name AS location_name, pl.name AS previous_location_name, g.name AS gateway_name
    FROM ble_tag_state s
    LEFT JOIN tracking_devices d ON d.id = s.device_id
    LEFT JOIN items i ON i.id = s.item_id
    LEFT JOIN item_units u ON u.id = s.unit_id
    LEFT JOIN locations l ON l.id = s.location_id
    LEFT JOIN locations pl ON pl.id = s.previous_location_id
    LEFT JOIN tracking_devices g ON g.id = s.gateway_id`;

function presenceView(r: Record<string, unknown>): TagPresence {
  return {
    tagKey: r.tag_key as string,
    tagId: (r.device_id as string) ?? null,
    tagName: (r.tag_name as string) ?? null,
    identity: r.identity as string,
    itemId: (r.item_id as string) ?? null,
    itemName: (r.item_name as string) ?? null,
    itemAssetCode: (r.item_asset_code as string) ?? null,
    unitId: (r.unit_id as string) ?? null,
    unitLabel: (r.unit_label as string) ?? null,
    locationId: (r.location_id as string) ?? null,
    locationName: (r.location_name as string) ?? null,
    previousLocationId: (r.previous_location_id as string) ?? null,
    previousLocationName: (r.previous_location_name as string) ?? null,
    zoneSince: iso(r.zone_since),
    gatewayId: (r.gateway_id as string) ?? null,
    gatewayName: (r.gateway_name as string) ?? null,
    rssi: numOrNull(r.rssi),
    lastHeardAt: iso(r.last_heard_at)!,
    missingSince: iso(r.missing_since),
    batteryPct: numOrNull(r.battery_pct),
    batteryMv: numOrNull(r.battery_mv),
    temperatureC: numOrNull(r.temperature_c),
  };
}

export type ZoneOccupancy = {
  locationId: string | null;
  locationName: string | null;
  gateways: { id: string; name: string; lastSeenAt: string | null; disabled: boolean }[];
  present: TagPresence[];
  missing: TagPresence[];
};

/**
 * Every room with a gateway or a tag in it, and what is there now. Tags that
 * have gone missing are listed under the room they were last in. Tags heard
 * only by gateways without a zone are under a room with no id.
 */
export async function occupancy(): Promise<ZoneOccupancy[]> {
  const [tags, gateways] = await Promise.all([
    pool.query(`${PRESENCE_SELECT} ORDER BY l.name NULLS LAST, COALESCE(i.name, d.name, s.identity)`),
    pool.query(
      `SELECT g.id, g.name, g.location_id, g.last_seen_at, g.disabled, l.name AS location_name
         FROM tracking_devices g JOIN locations l ON l.id = g.location_id
        WHERE g.kind = 'ble_gateway'
        ORDER BY l.name, g.name`,
    ),
  ]);
  const zones = new Map<string, ZoneOccupancy>();
  const zoneFor = (id: string | null, name: string | null) => {
    const key = id ?? "";
    let z = zones.get(key);
    if (!z) {
      z = { locationId: id, locationName: name, gateways: [], present: [], missing: [] };
      zones.set(key, z);
    }
    return z;
  };
  for (const g of gateways.rows) {
    zoneFor(g.location_id, g.location_name).gateways.push({
      id: g.id,
      name: g.name,
      lastSeenAt: iso(g.last_seen_at),
      disabled: g.disabled,
    });
  }
  for (const row of tags.rows) {
    const t = presenceView(row);
    const z = zoneFor(t.locationId, t.locationName);
    (t.missingSince ? z.missing : z.present).push(t);
  }
  return [...zones.values()].sort((a, b) => {
    if (!a.locationId) return 1;
    if (!b.locationId) return -1;
    return (a.locationName ?? "").localeCompare(b.locationName ?? "");
  });
}

export type QuietTag = {
  tagKey: string;
  tagId: string | null;
  tagName: string | null;
  identity: string | null;
  itemId: string | null;
  itemName: string | null;
  lastHeardAt: string | null;
  locationId: string | null;
  locationName: string | null;
  missingSince: string | null;
  batteryPct: number | null;
};

/**
 * Tags not heard for `hours`, and registered tags never heard at all, the
 * longest-silent first. What a "where did the pallet jack go" check needs.
 */
export async function notSeen(hours: number): Promise<QuietTag[]> {
  const cutoff = new Date(Date.now() - hours * 60 * 60_000);
  const { rows } = await pool.query(
    `SELECT COALESCE(s.tag_key, d.id::text) AS tag_key, d.id AS tag_id, d.name AS tag_name,
            COALESCE(s.identity, d.external_id) AS identity,
            COALESCE(d.item_id, s.item_id) AS item_id, i.name AS item_name,
            COALESCE(s.last_heard_at, d.last_seen_at) AS last_heard_at,
            s.location_id, l.name AS location_name, s.missing_since, d.battery_pct
       FROM tracking_devices d
       LEFT JOIN ble_tag_state s ON s.device_id = d.id
       LEFT JOIN items i ON i.id = COALESCE(d.item_id, s.item_id)
       LEFT JOIN locations l ON l.id = s.location_id
      WHERE d.kind = 'ble_tag' AND NOT d.disabled
        AND (COALESCE(s.last_heard_at, d.last_seen_at) IS NULL OR COALESCE(s.last_heard_at, d.last_seen_at) < $1)
     UNION ALL
     SELECT s.tag_key, NULL, NULL, s.identity, s.item_id, i.name, s.last_heard_at,
            s.location_id, l.name, s.missing_since, NULL
       FROM ble_tag_state s
       LEFT JOIN items i ON i.id = s.item_id
       LEFT JOIN locations l ON l.id = s.location_id
      WHERE s.device_id IS NULL AND s.last_heard_at < $1
      ORDER BY last_heard_at NULLS FIRST
      LIMIT 1000`,
    [cutoff],
  );
  return rows.map((r) => ({
    tagKey: r.tag_key,
    tagId: r.tag_id ?? null,
    tagName: r.tag_name ?? null,
    identity: r.identity ?? null,
    itemId: r.item_id ?? null,
    itemName: r.item_name ?? null,
    lastHeardAt: iso(r.last_heard_at),
    locationId: r.location_id ?? null,
    locationName: r.location_name ?? null,
    missingSince: iso(r.missing_since),
    batteryPct: numOrNull(r.battery_pct),
  }));
}

export type BatteryRow = {
  id: string;
  kind: string;
  name: string;
  externalId: string | null;
  batteryPct: number;
  batteryMv: number | null;
  lastSeenAt: string | null;
  itemId: string | null;
  itemName: string | null;
  locationId: string | null;
  locationName: string | null;
};

/** BLE devices whose battery is at or below `belowPct`, flattest first. */
export async function lowBatteries(belowPct: number): Promise<BatteryRow[]> {
  const { rows } = await pool.query(
    `SELECT d.id, d.kind, d.name, d.external_id, d.battery_pct, d.last_seen_at, d.item_id, i.name AS item_name,
            COALESCE(d.location_id, s.location_id) AS location_id, l.name AS location_name, s.battery_mv
       FROM tracking_devices d
       LEFT JOIN ble_tag_state s ON s.device_id = d.id
       LEFT JOIN items i ON i.id = d.item_id
       LEFT JOIN locations l ON l.id = COALESCE(d.location_id, s.location_id)
      WHERE d.kind IN ('ble_tag', 'ble_beacon', 'ble_gateway') AND NOT d.disabled
        AND d.battery_pct IS NOT NULL AND d.battery_pct <= $1
      ORDER BY d.battery_pct, d.name`,
    [belowPct],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    externalId: r.external_id ?? null,
    batteryPct: Number(r.battery_pct),
    batteryMv: numOrNull(r.battery_mv),
    lastSeenAt: iso(r.last_seen_at),
    itemId: r.item_id ?? null,
    itemName: r.item_name ?? null,
    locationId: r.location_id ?? null,
    locationName: r.location_name ?? null,
  }));
}

export type LiveHeard = HeardBy & { gatewayName: string | null; zoneName: string | null };

export type ItemBlePresence = TagPresence & {
  /** What the engine in this process hears now; empty after a restart until the tag is heard. */
  heard: LiveHeard[];
  candidateZoneId: string | null;
  candidateZoneName: string | null;
};

async function namesOf(deviceIds: string[], locationIds: string[]) {
  const [d, l] = await Promise.all([
    deviceIds.length
      ? pool.query<{ id: string; name: string }>("SELECT id, name FROM tracking_devices WHERE id = ANY($1::uuid[])", [
          deviceIds,
        ])
      : { rows: [] },
    locationIds.length
      ? pool.query<{ id: string; name: string }>("SELECT id, name FROM locations WHERE id = ANY($1::uuid[])", [
          locationIds,
        ])
      : { rows: [] },
  ]);
  return { device: new Map(d.rows.map((r) => [r.id, r.name])), location: new Map(l.rows.map((r) => [r.id, r.name])) };
}

/**
 * An item's Bluetooth presence: each tag on it (registered tags attached to
 * it, and tags known through its identifiers), the room each is in, and which
 * gateways hear it now.
 */
export async function itemPresence(
  itemId: string,
  now = Date.now(),
): Promise<{ tags: ItemBlePresence[]; attached: number }> {
  const { rows: found } = await pool.query("SELECT 1 FROM items WHERE id = $1", [itemId]);
  if (!found.length) throw notFound("Item not found");
  const [{ rows }, { rows: devices }] = await Promise.all([
    pool.query(`${PRESENCE_SELECT} WHERE s.item_id = $1 ORDER BY s.last_heard_at DESC`, [itemId]),
    pool.query(
      `SELECT d.id, d.name, d.external_id, d.battery_pct, d.last_seen_at FROM tracking_devices d
        WHERE d.kind = 'ble_tag' AND d.item_id = $1 AND NOT d.disabled`,
      [itemId],
    ),
  ]);
  const tags = rows.map(presenceView);
  // A tag attached but never heard still belongs on the card.
  for (const d of devices) {
    if (tags.some((t) => t.tagId === d.id)) continue;
    tags.push({
      tagKey: d.id,
      tagId: d.id,
      tagName: d.name,
      identity: d.external_id ?? "",
      itemId,
      itemName: null,
      itemAssetCode: null,
      unitId: null,
      unitLabel: null,
      locationId: null,
      locationName: null,
      previousLocationId: null,
      previousLocationName: null,
      zoneSince: null,
      gatewayId: null,
      gatewayName: null,
      rssi: null,
      lastHeardAt: iso(d.last_seen_at) ?? "",
      missingSince: null,
      batteryPct: numOrNull(d.battery_pct),
      batteryMv: null,
      temperatureC: null,
    });
  }
  const snaps = new Map(tags.map((t) => [t.tagKey, engine.snapshot(t.tagKey, now)]));
  const gatewayIds = new Set<string>();
  const zoneIds = new Set<string>();
  for (const s of snaps.values()) {
    for (const h of s?.heard ?? []) {
      gatewayIds.add(h.gatewayId);
      if (h.zoneId) zoneIds.add(h.zoneId);
    }
    if (s?.candidate) zoneIds.add(s.candidate.zoneId);
  }
  const n = await namesOf([...gatewayIds], [...zoneIds]);
  return {
    attached: devices.length,
    tags: tags.map((t) => {
      const s = snaps.get(t.tagKey);
      return {
        ...t,
        heard: (s?.heard ?? [])
          .filter((h) => h.rssi !== null)
          .map((h) => ({
            ...h,
            rssi: h.rssi === null ? null : Math.round(h.rssi * 10) / 10,
            gatewayName: n.device.get(h.gatewayId) ?? null,
            zoneName: h.zoneId ? (n.location.get(h.zoneId) ?? null) : null,
          })),
        candidateZoneId: s?.candidate?.zoneId ?? null,
        candidateZoneName: s?.candidate ? (n.location.get(s.candidate.zoneId) ?? null) : null,
      };
    }),
  };
}

export type BleDeviceView = {
  id: string;
  kind: string;
  name: string;
  externalId: string | null;
  identities: string[];
  locationId: string | null;
  locationName: string | null;
  itemId: string | null;
  itemName: string | null;
  unitId: string | null;
  updatesLocation: boolean;
  disabled: boolean;
  hasToken: boolean;
  tokenLast4: string | null;
  batteryPct: number | null;
  lastSeenAt: string | null;
  lastLat: number | null;
  lastLng: number | null;
  ble: BleDeviceSettings;
  /** Tags: where the engine last placed it. */
  presence: { locationId: string | null; locationName: string | null; missingSince: string | null } | null;
  /** Phones: the room it last reported, while current. */
  room: { locationId: string; locationName: string; expiresAt: string } | null;
};

/** Gateways, room beacons, tags and phones, with their BLE options and state. */
export async function listBleDevices(): Promise<BleDeviceView[]> {
  const { rows } = await pool.query(
    `SELECT d.*, l.name AS location_name, i.name AS item_name,
            s.location_id AS tag_location_id, sl.name AS tag_location_name, s.missing_since,
            r.location_id AS room_id, rl.name AS room_name, r.expires_at AS room_expires_at
       FROM tracking_devices d
       LEFT JOIN locations l ON l.id = d.location_id
       LEFT JOIN items i ON i.id = d.item_id
       LEFT JOIN ble_tag_state s ON s.device_id = d.id
       LEFT JOIN locations sl ON sl.id = s.location_id
       LEFT JOIN ble_phone_rooms r ON r.device_id = d.id AND r.expires_at > now()
       LEFT JOIN locations rl ON rl.id = r.location_id
      WHERE d.kind = ANY($1::text[])
      ORDER BY d.kind, d.name`,
    [[...BLE_KINDS]],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    externalId: r.external_id ?? null,
    identities: identitiesOf({ externalId: r.external_id, settings: r.settings }),
    locationId: r.location_id ?? null,
    locationName: r.location_name ?? null,
    itemId: r.item_id ?? null,
    itemName: r.item_name ?? null,
    unitId: r.unit_id ?? null,
    updatesLocation: r.updates_location,
    disabled: r.disabled,
    hasToken: Boolean(r.token_hash),
    tokenLast4: r.token_last4 ?? null,
    batteryPct: numOrNull(r.battery_pct),
    lastSeenAt: iso(r.last_seen_at),
    lastLat: numOrNull(r.last_lat),
    lastLng: numOrNull(r.last_lng),
    ble: bleSettings(r.settings),
    presence:
      r.kind === "ble_tag"
        ? {
            locationId: r.tag_location_id ?? null,
            locationName: r.tag_location_name ?? null,
            missingSince: iso(r.missing_since),
          }
        : null,
    room: r.room_id ? { locationId: r.room_id, locationName: r.room_name, expiresAt: iso(r.room_expires_at)! } : null,
  }));
}

/** Unregistered advertisers heard lately, for registering a tag from a list. */
export function heardList(opts: { gatewayId?: string; beaconsOnly?: boolean }) {
  return heardNearby.list(opts);
}
