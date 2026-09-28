import { checkSize, parseJsonBody } from "../../tracking/adapters/common";
import { finiteOrNull, parseTimestamp } from "../../tracking/normalize";
import {
  AdapterError,
  batteryLevel,
  hexData,
  identityFromFields,
  isRecord,
  nonEmptyString,
  type GatewayPayload,
  type RawAdvert,
} from "./common";

const EXPECTED =
  '{ "gateway"?: "gateway-id", "battery"?: 0-100, "reads": [{ "mac"?: "AA:BB:CC:DD:EE:FF", "data"?: "<advertising data, hex>", "code"?: "ibeacon:…", "rssi": -60, "ts"?: … }] }';

/**
 * Bindex's own BLE format, a superset of the tracking core's generic format
 * (/api/device/reads), so a script written for one works with the other:
 *
 *   { "gateway": "pi-dock-a", "reads": [
 *       { "mac": "AC:23:3F:A1:B2:C3", "rssi": -61, "data": "0201061AFF4C000215…" },
 *       { "code": "eddystone:…", "rssi": -70, "ts": 1790000000123 } ] }
 *
 * Each read names the advertiser by its raw advertising data, an identity
 * (`code`, or uuid/major/minor, or namespace/instance), or its MAC. `reads`
 * may also be the body itself, and a read may be a bare identity string.
 */
export function parseBleGeneric(body: unknown): GatewayPayload {
  const payload = parseJsonBody(body, EXPECTED);
  const reads = Array.isArray(payload) ? payload : isRecord(payload) ? payload.reads ?? payload.adverts : undefined;
  if (!Array.isArray(reads)) throw new AdapterError(`"reads" must be an array. Expected ${EXPECTED}`);
  checkSize(reads.length);

  const adverts = reads.map((raw, i) => parseRead(raw, i));
  const top = isRecord(payload) ? payload : {};
  return {
    gatewayId: nonEmptyString(top.gateway) ?? nonEmptyString(top.device) ?? nonEmptyString(top.reader),
    batteryPct: batteryLevel(top.battery),
    adverts,
    skipped: 0,
  };
}

function parseRead(raw: unknown, i: number): RawAdvert {
  if (typeof raw === "string") {
    if (!raw.trim()) throw new AdapterError(`reads[${i}] is an empty string; expected a beacon identity or MAC.`);
    return { identity: raw };
  }
  if (!isRecord(raw)) throw new AdapterError(`reads[${i}] must be an object with "mac", "data" or "code".`);

  const data = hexData(raw.data ?? raw.rawData ?? raw.raw ?? raw.adv, `reads[${i}].data`);
  const mac = nonEmptyString(raw.mac ?? raw.address ?? raw.addr);
  const identity = identityFromFields(raw);
  if (!data && !mac && !identity) {
    throw new AdapterError(`reads[${i}] needs "mac", "data" (advertising data as hex) or "code" (a beacon identity).`);
  }

  let at: Date | null = null;
  const ts = raw.ts ?? raw.timestamp ?? raw.time;
  if (ts !== undefined && ts !== null) {
    at = parseTimestamp(ts);
    if (!at) throw new AdapterError(`reads[${i}].ts is not a time; send ISO 8601 or epoch milliseconds.`);
  }

  return {
    mac: mac ?? null,
    data,
    identity,
    rssi: finiteOrNull(raw.rssi),
    at,
    txPower: finiteOrNull(raw.txPower ?? raw.tx_power ?? raw.measuredPower),
    batteryPct: batteryLevel(raw.battery) ?? null,
    batteryMv: finiteOrNull(raw.batteryMv ?? raw.battery_mv),
    temperatureC: finiteOrNull(raw.temperature ?? raw.temperatureC),
    name: nonEmptyString(raw.name) ?? null,
  };
}
