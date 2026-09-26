import { and, asc, eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { trackingDevices, type TrackingDevice } from "../../db/schema";
import { badRequest } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { createDevice, getDeviceRow, updateDevice, type DeviceView } from "../tracking";
import { canonicalIdentity, formatMac } from "./advert";
import { BLE_SETTING_KEYS, type BleDeviceSettings } from "./config";
import { engine } from "./ingest";
import { phoneEngine } from "./phones";
import { invalidateRegistry } from "./registry";

/**
 * Registering gateways, tags, room beacons and phones with their BLE options.
 * A thin layer over the tracking core's registry (createDevice/updateDevice):
 * it writes tag and beacon ids in canonical form, so what a gateway hears
 * matches what was typed, and merges BLE options into the device's settings
 * without touching keys other features keep there.
 */

export type BleKind = "ble_gateway" | "ble_beacon" | "ble_tag" | "mobile";

export type BleDeviceInput = {
  kind: BleKind;
  name: string;
  /** Tags and beacons: ibeacon:…, eddystone:…, a MAC… Gateways: serial or MAC. */
  externalId?: string | null;
  locationId?: string | null;
  itemId?: string | null;
  unitId?: string | null;
  updatesLocation?: boolean;
  disabled?: boolean;
  /** BLE options to set; null or undefined clears one back to its default. */
  ble?: BleOptionsPatch;
};

export type BleOptionsPatch = { [K in keyof BleDeviceSettings]?: BleDeviceSettings[K] | null };

const IDENTIFIED: BleKind[] = ["ble_tag", "ble_beacon"];

/** The id to store: canonical for what a gateway hears, as typed otherwise. */
function externalIdFor(kind: BleKind, raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  const s = raw?.trim() ?? "";
  if (!s) {
    if (IDENTIFIED.includes(kind)) {
      throw badRequest("Give the beacon's id: an iBeacon UUID, major and minor, an Eddystone namespace and instance, or its MAC.");
    }
    return null;
  }
  if (!IDENTIFIED.includes(kind)) return formatMac(s) ?? s;
  const id = canonicalIdentity(s);
  if (!id) {
    throw badRequest(
      `"${s}" is not a beacon id Bindex can read. Use ibeacon:<UUID>:<major>:<minor>, eddystone:<20 hex>:<12 hex>, or a MAC such as AC:23:3F:A1:B2:C3.`,
    );
  }
  return id;
}

function mergeSettings(stored: Record<string, unknown>, ble: BleOptionsPatch | undefined) {
  const out: Record<string, unknown> = { ...stored };
  if (!ble) return out;
  for (const key of BLE_SETTING_KEYS) {
    if (!(key in ble)) continue;
    const v = ble[key];
    if (v === null || v === undefined || v === "") delete out[key];
    else out[key] = key === "bleMac" && typeof v === "string" ? (formatMac(v) ?? v) : v;
  }
  if (ble.bleMac && !formatMac(String(ble.bleMac))) {
    throw badRequest(`"${ble.bleMac}" is not a MAC address. Use six pairs of hex digits, such as AC:23:3F:A1:B2:C3.`);
  }
  return out;
}

export async function createBleDevice(input: BleDeviceInput): Promise<{ device: DeviceView; token: string | null }> {
  const result = await createDevice({
    kind: input.kind,
    name: input.name,
    externalId: externalIdFor(input.kind, input.externalId ?? null) ?? null,
    locationId: input.kind === "ble_tag" ? null : (input.locationId ?? null),
    itemId: input.kind === "ble_tag" ? (input.itemId ?? null) : null,
    unitId: input.kind === "ble_tag" ? (input.unitId ?? null) : null,
    updatesLocation: input.updatesLocation ?? false,
    disabled: input.disabled ?? false,
    settings: mergeSettings({}, input.ble),
  });
  invalidateRegistry();
  return result;
}

export async function updateBleDevice(id: string, patch: Partial<BleDeviceInput>): Promise<DeviceView> {
  const existing = await getDeviceRow(id);
  const kind = (patch.kind ?? existing.kind) as BleKind;
  const view = await updateDevice(id, {
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.externalId !== undefined ? { externalId: externalIdFor(kind, patch.externalId) } : {}),
    ...(patch.locationId !== undefined ? { locationId: patch.locationId } : {}),
    ...(patch.itemId !== undefined ? { itemId: patch.itemId } : {}),
    ...(patch.unitId !== undefined ? { unitId: patch.unitId } : {}),
    ...(patch.updatesLocation !== undefined ? { updatesLocation: patch.updatesLocation } : {}),
    ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    ...(patch.ble !== undefined ? { settings: mergeSettings(existing.settings ?? {}, patch.ble) } : {}),
  });
  invalidateRegistry();
  // A tag re-pointed at another item, or a gateway moved to another room,
  // starts over rather than carrying readings from before.
  if (patch.itemId !== undefined || patch.externalId !== undefined || patch.disabled) engine.forget(id);
  if (existing.kind === "mobile") phoneEngine.forget(id);
  return view;
}

const macHex = (s: string) => formatMac(s)?.replace(/:/g, "") ?? null;

/**
 * The gateway a report names (by serial or MAC, in any notation), or null.
 * Used for posts made with INGEST_TOKEN and for MQTT, where the payload or
 * topic says which gateway it is.
 */
export async function findGateway(externalId: string): Promise<TrackingDevice | null> {
  const id = externalId.trim();
  const hex = macHex(id);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM tracking_devices
      WHERE kind = 'ble_gateway'
        AND (external_id = $1 OR ($2::text IS NOT NULL AND upper(regexp_replace(external_id, '[^0-9A-Fa-f]', '', 'g')) = $2))
      ORDER BY created_at LIMIT 1`,
    [id, hex],
  );
  return rows[0] ? getDeviceRow(rows[0].id) : null;
}

/**
 * Find a gateway, or register it the first time it reports, with no zone and
 * no token. The same courtesy the tracking core extends to a reader posting
 * with INGEST_TOKEN: it appears in the device list, ready to be given a room.
 */
export async function findOrCreateGateway(externalId: string): Promise<TrackingDevice> {
  const found = await findGateway(externalId);
  if (found) return found;
  const id = formatMac(externalId) ?? externalId.trim().slice(0, 200);
  const [created] = await db
    .insert(trackingDevices)
    .values({ kind: "ble_gateway", name: `Gateway ${id}`, externalId: id })
    .onConflictDoNothing()
    .returning();
  if (created) {
    logger.info("ble.gateway.auto_created", { id: created.id, externalId: id });
    invalidateRegistry();
    return created;
  }
  // Another request registered it first.
  const [raced] = await db
    .select()
    .from(trackingDevices)
    .where(and(eq(trackingDevices.kind, "ble_gateway"), eq(trackingDevices.externalId, id)))
    .orderBy(asc(trackingDevices.createdAt))
    .limit(1);
  if (!raced) throw new Error(`Could not register gateway ${id}`);
  return raced;
}
