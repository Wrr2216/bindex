import type { NormalizedRead, TrackingDevice, TrackingDeviceSettings } from "./types";

/**
 * Where a read puts an asset.
 *
 * `fix` says whether the read tells us where the asset is at all. A handheld
 * with no zone, or a portal read before the tag has crossed from one side to
 * the other, is a sighting without a fix: it proves the asset was seen, not
 * where it now is. A fix with a null zone means "somewhere outside every known
 * zone", which is what a GPS point or a portal exit with no outside zone says.
 */
export type ZoneDecision = { locationId: string | null; fix: boolean };

export function zoneFor(
  device: Pick<TrackingDevice, "kind" | "locationId">,
  settings: Pick<TrackingDeviceSettings, "antennaZones" | "portal">,
  read: Pick<NormalizedRead, "locationId" | "direction" | "antenna" | "lat" | "lng">,
): ZoneDecision {
  // A caller that already decided (BLE presence, a geofence) is authoritative.
  if (read.locationId !== undefined) return { locationId: read.locationId, fix: true };

  if (device.kind === "rfid_portal") {
    const portal = settings.portal;
    if (read.direction === "in") {
      return { locationId: portal?.inLocationId ?? device.locationId ?? null, fix: true };
    }
    if (read.direction === "out") return { locationId: portal?.outLocationId ?? null, fix: true };
    return { locationId: null, fix: false };
  }

  if (read.antenna !== null && read.antenna !== undefined) {
    const zone = settings.antennaZones?.[String(read.antenna)];
    if (zone) return { locationId: zone, fix: true };
  }
  if (device.locationId) return { locationId: device.locationId, fix: true };
  if (typeof read.lat === "number" && typeof read.lng === "number") return { locationId: null, fix: true };
  return { locationId: null, fix: false };
}
