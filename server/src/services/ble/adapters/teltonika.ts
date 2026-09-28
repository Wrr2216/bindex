import { checkSize, parseJsonBody } from "../../tracking/adapters/common";
import { finiteOrNull, parseTimestamp } from "../../tracking/normalize";
import { canonicalIdentity, eddystoneIdentity, formatMac, ibeaconIdentity } from "../advert";
import {
  AdapterError,
  arrayIn,
  batteryLevel,
  isRecord,
  nonEmptyString,
  type GatewayPayload,
  type RawAdvert,
} from "./common";

const EXPECTED =
  'Teltonika records as JSON: [{ "ident": "<IMEI>", "timestamp": 1790000000, "position.latitude": 54.6, "position.longitude": 25.2, "ble.beacons": [{ "id": "<beacon id hex>", "rssi": -70 }] }]';

/**
 * Teltonika FMB/FMC trackers (and TAT/FMT asset trackers) scanning for beacons,
 * after a TCP-to-HTTP forwarder has decoded their Codec 8 records into JSON, as
 * flespi and similar services do.
 *
 * A record names the tracker by `ident` (its IMEI), carries its time and GPS
 * position, and lists the beacons it heard under "ble.beacons" (or
 * ble.beacons nested, or "beacons"). A beacon id is what the tracker reports:
 * 40 hex digits for an iBeacon (UUID, major, minor), 32 for an Eddystone-UID
 * (namespace, instance), 12 for a bare MAC, or an identity already written the
 * Bindex way. Records with no beacons (plain GPS records) are skipped.
 *
 * Built from Teltonika's beacon (AVL ID 385) layout and flespi's documented
 * JSON; not yet verified on hardware.
 */
export function parseTeltonika(body: unknown): GatewayPayload {
  const payload = parseJsonBody(body, EXPECTED);
  const records = arrayIn(payload, ["result", "messages", "records", "data"]) ?? (isRecord(payload) ? [payload] : null);
  if (!records) throw new AdapterError(`Expected ${EXPECTED}`);

  const out: GatewayPayload = { adverts: [], skipped: 0 };
  let latestFix = -Infinity;
  records.forEach((r, i) => {
    if (!isRecord(r)) throw new AdapterError(`Record ${i} is not an object. Expected ${EXPECTED}`);
    const ident = nonEmptyString(r.ident ?? r.imei ?? (isRecord(r.device) ? r.device.ident : undefined));
    if (ident) out.gatewayId ??= ident;
    const at = parseTimestamp(r.timestamp ?? r["server.timestamp"]);

    const position = isRecord(r.position) ? r.position : {};
    const lat = finiteOrNull(r["position.latitude"] ?? position.latitude);
    const lng = finiteOrNull(r["position.longitude"] ?? position.longitude);
    const when = at?.getTime() ?? 0;
    if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && when >= latestFix) {
      out.lat = lat;
      out.lng = lng;
      latestFix = when;
    }
    const battery = batteryLevel(r["battery.level"]);
    if (battery !== undefined) out.batteryPct = battery;

    const ble = isRecord(r.ble) ? r.ble : {};
    const beacons = r["ble.beacons"] ?? ble.beacons ?? r.beacons;
    if (!Array.isArray(beacons) || !beacons.length) {
      out.skipped += 1;
      return;
    }
    checkSize(out.adverts.length + beacons.length);
    for (const b of beacons) {
      if (!isRecord(b)) continue;
      const id = nonEmptyString(b.id ?? b["beacon.id"] ?? b.uuid);
      if (!id) continue;
      const advert: RawAdvert = {
        ...beaconId(id),
        rssi: finiteOrNull(b.rssi ?? b["beacon.rssi"]),
        at,
        batteryMv: voltsToMv(b["battery.voltage"] ?? b.voltage),
        temperatureC: finiteOrNull(b.temperature ?? b["temperature"]),
      };
      out.adverts.push(advert);
    }
  });
  return out;
}

/** What a Teltonika beacon id says about the beacon. */
function beaconId(id: string): Pick<RawAdvert, "identity" | "mac"> {
  const hex = id.replace(/[\s-]/g, "");
  if (/^[0-9a-f]{40}$/i.test(hex)) {
    return {
      identity: ibeaconIdentity(hex.slice(0, 32), parseInt(hex.slice(32, 36), 16), parseInt(hex.slice(36, 40), 16)),
    };
  }
  if (/^[0-9a-f]{32}$/i.test(hex)) return { identity: eddystoneIdentity(hex.slice(0, 20), hex.slice(20, 32)) };
  if (formatMac(id)) return { mac: id };
  return { identity: canonicalIdentity(id) };
}

function voltsToMv(v: unknown): number | null {
  const n = finiteOrNull(v);
  if (n === null || n <= 0) return null;
  // Forwarders report volts (3.05); some report millivolts already.
  return n < 100 ? Math.round(n * 1000) : Math.round(n);
}
