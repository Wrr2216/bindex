import type { PoolClient } from "pg";
import { pool } from "../../db/client";
import { env } from "../../env";
import { logger } from "../../lib/logger";
import { DuplicateFilter } from "./dedup";
import { DEFAULT_PORTAL_WINDOW_MS, PortalTracker } from "./direction";
import { clampObservedAt, normalizeCode } from "./normalize";
import { resolveCodes } from "./resolve";
import {
  DEFAULT_TECH,
  readSettings,
  type NormalizedRead,
  type SightingDirection,
  type SightingTech,
  type TrackingDevice,
} from "./types";
import { zoneFor } from "./zones";

/**
 * The one way sightings get into the database. Every ingest route and every
 * feature built on the tracking core (BLE presence, GPS, placement) calls
 * recordSightings, so positions, zone changes and "moved" events behave the
 * same whatever the radio.
 *
 * A batch is handled in a fixed number of queries whatever its size: one
 * resolution pass, one insert, one position upsert, and a couple of updates.
 */

export type RecordOptions = {
  /** Receipt time. Defaults to now; tests pin it. */
  now?: Date;
  /**
   * Store every read, even repeats inside the duplicate window. For callers
   * that already smooth their input, such as a presence engine that only
   * reports zone changes.
   */
  keepDuplicates?: boolean;
  /** Battery level the device reported with this batch, 0 to 100. */
  batteryPct?: number | null;
};

export type RecordResult = {
  /** Reads taken in: valid, and above the device's RSSI floor. */
  accepted: number;
  /** Accepted reads that resolved to an asset. */
  matched: number;
  /** Accepted reads that did not. They are still stored, for commissioning. */
  unknown: number;
  /** Sightings written, after duplicate suppression. */
  recorded: number;
  /** Accepted reads not stored because they repeated a recent one. */
  suppressed: number;
  /** Reads dropped before acceptance: below the RSSI floor, or empty. */
  ignored: number;
  /** Zone changes, each written as one "moved" item event. */
  moved: number;
};

type Asset = { itemId: string; unitId: string | null };

type Prepared = {
  code: string | null;
  observedAt: Date;
  tech: SightingTech;
  rssi: number | null;
  antenna: number | null;
  direction: SightingDirection | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  meta: Record<string, unknown> | null;
  explicitZone: string | null | undefined;
  asset: Asset | null;
  locationId: string | null;
  fix: boolean;
  dedupKey: string;
};

type PositionState = {
  itemId: string;
  unitId: string | null;
  tech: SightingTech;
  locationId: string | null;
  previousLocationId: string | null;
  lat: number | null;
  lng: number | null;
  deviceId: string | null;
  observedAt: number;
  enteredAt: Date | null;
  dirty: boolean;
};

type Move = {
  asset: Asset;
  from: string | null;
  to: string;
  applied: boolean;
  tech: SightingTech;
  direction: SightingDirection | null;
};

const duplicates = new DuplicateFilter();
const portals = new PortalTracker();

const assetKey = (a: Asset) => `${a.itemId}/${a.unitId ?? ""}`;
const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Store a batch of reads from one device.
 *
 * - Each read is normalized, and dropped below the device's RSSI floor.
 * - A portal works out which way each tag went (direction.ts).
 * - Codes resolve to assets in one pass (resolve.ts); a code-less read from a
 *   tag or tracker is about the asset the device is attached to.
 * - Each read gets a zone (zones.ts), and a repeat of the same code on the
 *   same device inside the duplicate window is not stored again.
 * - Sightings are inserted, asset positions move forward in time, and each
 *   zone change writes one "moved" item event. Only a device with
 *   updates_location changes the item's recorded location.
 * - The device's last-seen time, position and battery are updated.
 */
export async function recordSightings(
  device: TrackingDevice,
  reads: readonly NormalizedRead[],
  opts: RecordOptions = {},
): Promise<RecordResult> {
  const now = opts.now ?? new Date();
  const result: RecordResult = {
    accepted: 0,
    matched: 0,
    unknown: 0,
    recorded: 0,
    suppressed: 0,
    ignored: 0,
    moved: 0,
  };
  if (device.disabled) {
    result.ignored = reads.length;
    return result;
  }

  const settings = readSettings(device.settings);
  const attached: Asset | null = device.itemId ? { itemId: device.itemId, unitId: device.unitId ?? null } : null;
  const ownCode = device.externalId ? normalizeCode(device.externalId) : null;

  // 1. Normalize and filter.
  const prepared: (Prepared & { explicitAsset: Asset | null | undefined })[] = [];
  let latestFix: { lat: number; lng: number; at: number } | null = null;
  for (const r of reads) {
    const code = typeof r.code === "string" && r.code.trim() ? normalizeCode(r.code) : null;
    const lat = num(r.lat);
    const lng = num(r.lng);
    const hasPoint = lat !== null && lng !== null;
    if (!code && !hasPoint && !r.asset) {
      result.ignored += 1;
      continue;
    }
    const rssi = num(r.rssi);
    if (settings.rssiFloor != null && rssi !== null && rssi < settings.rssiFloor) {
      result.ignored += 1;
      continue;
    }
    const observedAt = clampObservedAt(r.observedAt ?? null, now);
    if (hasPoint && (!latestFix || observedAt.getTime() >= latestFix.at)) {
      latestFix = { lat: lat!, lng: lng!, at: observedAt.getTime() };
    }
    prepared.push({
      code,
      observedAt,
      tech: r.tech ?? DEFAULT_TECH[device.kind] ?? "rfid",
      rssi,
      antenna: num(r.antenna),
      direction: r.direction ?? null,
      lat: hasPoint ? lat : null,
      lng: hasPoint ? lng : null,
      accuracyM: num(r.accuracyM),
      speedMps: num(r.speedMps),
      headingDeg: num(r.headingDeg),
      meta: r.meta && Object.keys(r.meta).length ? r.meta : null,
      explicitZone: r.locationId,
      explicitAsset: r.asset,
      asset: null,
      locationId: null,
      fix: false,
      dedupKey: "",
    });
  }
  result.accepted = prepared.length;
  // Oldest first, so positions and portal passes see reads in the order they happened.
  prepared.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

  // 2. Direction through a portal.
  const portal = device.kind === "rfid_portal" ? settings.portal : undefined;
  if (portal && Object.keys(portal.sides).length) {
    const windowMs = portal.windowSeconds ? portal.windowSeconds * 1000 : DEFAULT_PORTAL_WINDOW_MS;
    for (const p of prepared) {
      if (p.direction || !p.code) continue;
      p.direction = portals.observe(
        `${device.id}|${p.code}`,
        { antenna: p.antenna, at: p.observedAt.getTime(), rssi: p.rssi },
        portal.sides,
        windowMs,
      );
    }
    if (portals.size > 50_000) portals.sweep(now.getTime(), windowMs);
  }

  // 3. Which asset each read is about.
  const toResolve = new Set<string>();
  for (const p of prepared) {
    if (p.explicitAsset === undefined && p.code && p.code !== ownCode) toResolve.add(p.code);
  }
  const resolved = await resolveCodes(toResolve);
  for (const p of prepared) {
    if (p.explicitAsset !== undefined) p.asset = p.explicitAsset;
    else if (!p.code || p.code === ownCode) p.asset = attached;
    else {
      const hit = resolved.get(p.code);
      p.asset = hit ? { itemId: hit.itemId, unitId: hit.unitId } : null;
    }
    if (p.asset) result.matched += 1;
    else result.unknown += 1;
  }

  // 4. Zones, then duplicate suppression.
  const dedupMs = opts.keepDuplicates ? 0 : (settings.dedupSeconds ?? env.TRACKING_DEDUP_SECONDS) * 1000;
  const kept: Prepared[] = [];
  for (const p of prepared) {
    const zone = zoneFor(device, settings, {
      locationId: p.explicitZone,
      direction: p.direction,
      antenna: p.antenna,
      lat: p.lat,
      lng: p.lng,
    });
    p.locationId = zone.locationId;
    p.fix = zone.fix;
    p.dedupKey = `${device.id}|${p.code ?? ""}|${p.asset ? assetKey(p.asset) : ""}`;
    // A moving tracker is not repeating itself, so its rounded position is
    // part of what makes a read new (four decimals is about ten metres).
    const where = p.lat !== null && p.lng !== null ? `${p.lat.toFixed(4)},${p.lng.toFixed(4)}` : "";
    const sig = `${p.direction ?? ""}|${p.locationId ?? ""}|${p.fix ? 1 : 0}|${where}`;
    if (duplicates.admit(p.dedupKey, p.observedAt.getTime(), sig, dedupMs)) kept.push(p);
    else result.suppressed += 1;
  }

  // 5. Write it all in one transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (kept.length) {
      await insertSightings(client, device.id, now, kept);
      result.recorded = kept.length;
      result.moved = await advancePositions(client, device, kept);
    }
    await client.query(
      `UPDATE tracking_devices
          SET last_seen_at = GREATEST(COALESCE(last_seen_at, $2::timestamptz), $2::timestamptz),
              last_lat = COALESCE($3::float8, last_lat),
              last_lng = COALESCE($4::float8, last_lng),
              battery_pct = COALESCE($5::int, battery_pct)
        WHERE id = $1`,
      [
        device.id,
        now,
        latestFix?.lat ?? null,
        latestFix?.lng ?? null,
        typeof opts.batteryPct === "number" ? Math.round(Math.min(100, Math.max(0, opts.batteryPct))) : null,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    for (const p of kept) duplicates.release(p.dedupKey, p.observedAt.getTime());
    throw err;
  } finally {
    client.release();
  }

  if (result.moved) {
    logger.info("tracking.ingest.moved", { deviceId: device.id, moved: result.moved });
  }
  return result;
}

async function insertSightings(client: PoolClient, deviceId: string, receivedAt: Date, rows: Prepared[]) {
  await client.query(
    `INSERT INTO sightings (observed_at, received_at, device_id, tech, code, item_id, unit_id, location_id,
                            rssi, antenna, direction, lat, lng, accuracy_m, speed_mps, heading_deg, meta)
     SELECT t.observed_at, $1, $2, t.tech, t.code, t.item_id, t.unit_id, t.location_id,
            t.rssi, t.antenna, t.direction, t.lat, t.lng, t.accuracy_m, t.speed_mps, t.heading_deg, t.meta::jsonb
       FROM unnest($3::timestamptz[], $4::text[], $5::text[], $6::uuid[], $7::uuid[], $8::uuid[],
                   $9::real[], $10::int[], $11::text[], $12::float8[], $13::float8[], $14::real[],
                   $15::real[], $16::real[], $17::text[])
         AS t(observed_at, tech, code, item_id, unit_id, location_id, rssi, antenna, direction,
              lat, lng, accuracy_m, speed_mps, heading_deg, meta)`,
    [
      receivedAt,
      deviceId,
      rows.map((r) => r.observedAt),
      rows.map((r) => r.tech),
      rows.map((r) => r.code),
      rows.map((r) => r.asset?.itemId ?? null),
      rows.map((r) => r.asset?.unitId ?? null),
      rows.map((r) => r.locationId),
      rows.map((r) => r.rssi),
      rows.map((r) => r.antenna),
      rows.map((r) => r.direction),
      rows.map((r) => r.lat),
      rows.map((r) => r.lng),
      rows.map((r) => r.accuracyM),
      rows.map((r) => r.speedMps),
      rows.map((r) => r.headingDeg),
      rows.map((r) => (r.meta ? JSON.stringify(r.meta) : null)),
    ],
  );
}

/**
 * Move each sighted asset's position forward and apply zone changes. Returns
 * the number of "moved" events written.
 *
 * An asset's current zone is its tracked zone once it has had a fix, and its
 * recorded location before that, so the first read by a zone reader only
 * counts as a move when it disagrees with what is on file.
 */
async function advancePositions(client: PoolClient, device: TrackingDevice, rows: Prepared[]): Promise<number> {
  const sighted = rows.filter((r): r is Prepared & { asset: Asset } => r.asset !== null);
  if (!sighted.length) return 0;

  const itemIds = [...new Set(sighted.map((r) => r.asset.itemId))];
  const unitIds = [...new Set(sighted.map((r) => r.asset.unitId).filter((u): u is string => !!u))];
  // Lock the items first, in a fixed order, so two devices reporting the same
  // asset at once take turns instead of both writing the same move.
  const itemRows = await client.query<{ id: string; location_id: string | null }>(
    `SELECT id, location_id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
    [itemIds],
  );
  const unitRows = unitIds.length
    ? await client.query<{ id: string; item_id: string; location_id: string | null }>(
        `SELECT id, item_id, location_id FROM item_units WHERE id = ANY($1::uuid[])`,
        [unitIds],
      )
    : { rows: [] as { id: string; item_id: string; location_id: string | null }[] };
  const positions = await client.query<{
    item_id: string;
    unit_id: string | null;
    tech: SightingTech;
    location_id: string | null;
    previous_location_id: string | null;
    lat: number | null;
    lng: number | null;
    device_id: string | null;
    observed_at: Date;
    entered_at: Date | null;
  }>(
    `SELECT item_id, unit_id, tech, location_id, previous_location_id, lat, lng, device_id, observed_at, entered_at
       FROM asset_positions WHERE item_id = ANY($1::uuid[])`,
    [itemIds],
  );

  // Where each asset is on file. An asset that has gone (deleted since it was
  // resolved, or named by a caller that got it wrong) is left alone.
  const recorded = new Map<string, string | null>();
  for (const i of itemRows.rows) recorded.set(`${i.id}/`, i.location_id);
  for (const u of unitRows.rows) recorded.set(`${u.item_id}/${u.id}`, u.location_id);

  const states = new Map<string, PositionState>();
  for (const p of positions.rows) {
    states.set(`${p.item_id}/${p.unit_id ?? ""}`, {
      itemId: p.item_id,
      unitId: p.unit_id,
      tech: p.tech,
      locationId: p.location_id,
      previousLocationId: p.previous_location_id,
      lat: p.lat,
      lng: p.lng,
      deviceId: p.device_id,
      observedAt: new Date(p.observed_at).getTime(),
      enteredAt: p.entered_at ? new Date(p.entered_at) : null,
      dirty: false,
    });
  }

  const moves: Move[] = [];
  for (const r of sighted) {
    const key = assetKey(r.asset);
    if (!recorded.has(key)) continue;
    let st = states.get(key);
    if (!st) {
      st = {
        itemId: r.asset.itemId,
        unitId: r.asset.unitId,
        tech: r.tech,
        locationId: null,
        previousLocationId: null,
        lat: null,
        lng: null,
        deviceId: null,
        observedAt: -Infinity,
        enteredAt: null,
        dirty: false,
      };
      states.set(key, st);
    }
    const at = r.observedAt.getTime();
    // Only ever forward: a late batch must not rewind the position.
    if (at <= st.observedAt) continue;

    st.observedAt = at;
    st.tech = r.tech;
    st.deviceId = device.id;
    st.dirty = true;
    if (r.lat !== null && r.lng !== null) {
      st.lat = r.lat;
      st.lng = r.lng;
    }
    if (!r.fix) continue;
    // A zone fix without coordinates supersedes coordinates from an older fix.
    if (r.lat === null || r.lng === null) {
      st.lat = null;
      st.lng = null;
    }

    const current = st.enteredAt ? st.locationId : (recorded.get(key) ?? null);
    if (!st.enteredAt || r.locationId !== st.locationId) {
      if (r.locationId !== current) st.previousLocationId = current;
      st.locationId = r.locationId;
      st.enteredAt = r.observedAt;
    }
    // Leaving every known zone is a position, not a move: nothing says where
    // the asset now belongs.
    if (r.locationId && r.locationId !== current) {
      const applied = device.updatesLocation && recorded.get(key) !== r.locationId;
      if (applied) recorded.set(key, r.locationId);
      moves.push({ asset: r.asset, from: current, to: r.locationId, applied, tech: r.tech, direction: r.direction });
    }
  }

  const dirty = [...states.values()].filter((s) => s.dirty);
  if (dirty.length) {
    await client.query(
      `INSERT INTO asset_positions (item_id, unit_id, tech, location_id, previous_location_id, lat, lng,
                                    device_id, observed_at, entered_at, updated_at)
       SELECT t.item_id, t.unit_id, t.tech, t.location_id, t.previous_location_id, t.lat, t.lng,
              t.device_id, t.observed_at, t.entered_at, now()
         FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::uuid[], $5::uuid[], $6::float8[], $7::float8[],
                     $8::uuid[], $9::timestamptz[], $10::timestamptz[])
           AS t(item_id, unit_id, tech, location_id, previous_location_id, lat, lng, device_id, observed_at, entered_at)
       ON CONFLICT (item_id, (COALESCE(unit_id, '00000000-0000-0000-0000-000000000000'::uuid)))
       DO UPDATE SET tech = excluded.tech,
                     location_id = excluded.location_id,
                     previous_location_id = excluded.previous_location_id,
                     lat = excluded.lat,
                     lng = excluded.lng,
                     device_id = excluded.device_id,
                     observed_at = excluded.observed_at,
                     entered_at = excluded.entered_at,
                     updated_at = now()
       WHERE asset_positions.observed_at < excluded.observed_at`,
      [
        dirty.map((s) => s.itemId),
        dirty.map((s) => s.unitId),
        dirty.map((s) => s.tech),
        dirty.map((s) => s.locationId),
        dirty.map((s) => s.previousLocationId),
        dirty.map((s) => s.lat),
        dirty.map((s) => s.lng),
        dirty.map((s) => s.deviceId),
        dirty.map((s) => new Date(s.observedAt)),
        dirty.map((s) => s.enteredAt),
      ],
    );
  }

  if (!moves.length) return 0;

  // The recorded location ends up at the last zone applied for each asset.
  const finalItem = new Map<string, string>();
  const finalUnit = new Map<string, string>();
  for (const m of moves) {
    if (!m.applied) continue;
    if (m.asset.unitId) finalUnit.set(m.asset.unitId, m.to);
    else finalItem.set(m.asset.itemId, m.to);
  }
  if (finalItem.size) {
    await client.query(
      `UPDATE items i SET location_id = v.loc, updated_at = now()
         FROM unnest($1::uuid[], $2::uuid[]) AS v(id, loc) WHERE i.id = v.id`,
      [[...finalItem.keys()], [...finalItem.values()]],
    );
  }
  if (finalUnit.size) {
    await client.query(
      `UPDATE item_units u SET location_id = v.loc, updated_at = now()
         FROM unnest($1::uuid[], $2::uuid[]) AS v(id, loc) WHERE u.id = v.id`,
      [[...finalUnit.keys()], [...finalUnit.values()]],
    );
  }

  await client.query(
    `INSERT INTO item_events (item_id, user_oid, action, detail)
     SELECT t.item_id, NULL, 'moved', t.detail::jsonb
       FROM unnest($1::uuid[], $2::text[]) AS t(item_id, detail)`,
    [
      moves.map((m) => m.asset.itemId),
      moves.map((m) =>
        JSON.stringify({
          source: "tracking",
          tech: m.tech,
          deviceId: device.id,
          deviceName: device.name,
          from: m.from,
          to: m.to,
          applied: m.applied,
          ...(m.asset.unitId ? { unitId: m.asset.unitId } : {}),
          ...(m.direction ? { direction: m.direction } : {}),
        }),
      ),
    ],
  );
  return moves.length;
}

/** For tests: forget duplicate and portal state between cases. */
export function resetIngestState(): void {
  duplicates.clear();
  portals.clear();
}
