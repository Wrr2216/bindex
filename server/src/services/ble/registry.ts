import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { trackingDevices, type TrackingDevice } from "../../db/schema";
import { canonicalIdentity, macIdentity } from "./advert";
import { bleSettings } from "./config";

/**
 * Which registered device an identity belongs to. Tags and room beacons are
 * looked up on every advertisement, so the registry is loaded once and kept
 * for a few seconds; changes made through the BLE routes clear it at once,
 * and changes made elsewhere (the tracking core's device screen) show up
 * within REGISTRY_TTL_MS.
 */

export type BleRegistry = {
  /** Enabled ble_tag devices, by every identity they answer to. */
  tags: Map<string, TrackingDevice>;
  /** Enabled ble_beacon devices, likewise. */
  beacons: Map<string, TrackingDevice>;
};

const REGISTRY_TTL_MS = 5_000;

let cache: { registry: BleRegistry; at: number } | null = null;
let loading: Promise<BleRegistry> | null = null;

/**
 * The identities a device answers to: its external id in canonical form, and
 * the MAC its telemetry comes from when that is set separately.
 */
export function identitiesOf(device: Pick<TrackingDevice, "externalId" | "settings">): string[] {
  const out: string[] = [];
  const id = device.externalId ? canonicalIdentity(device.externalId) : null;
  if (id) out.push(id);
  const mac = bleSettings(device.settings).bleMac;
  const macId = mac ? macIdentity(mac) : null;
  if (macId && !out.includes(macId)) out.push(macId);
  return out;
}

/** The identity to store on a tag's sightings: its canonical external id. */
export function primaryIdentity(device: Pick<TrackingDevice, "id" | "externalId" | "settings">): string {
  return identitiesOf(device)[0] ?? `device:${device.id}`;
}

async function load(): Promise<BleRegistry> {
  const rows = await db
    .select()
    .from(trackingDevices)
    .where(and(inArray(trackingDevices.kind, ["ble_tag", "ble_beacon"]), eq(trackingDevices.disabled, false)));
  const registry: BleRegistry = { tags: new Map(), beacons: new Map() };
  for (const d of rows) {
    const map = d.kind === "ble_tag" ? registry.tags : registry.beacons;
    for (const id of identitiesOf(d)) map.set(id, d);
  }
  return registry;
}

export async function getRegistry(now = Date.now()): Promise<BleRegistry> {
  if (cache && now - cache.at < REGISTRY_TTL_MS) return cache.registry;
  loading ??= load()
    .then((registry) => {
      cache = { registry, at: Date.now() };
      return registry;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function invalidateRegistry(): void {
  cache = null;
}
