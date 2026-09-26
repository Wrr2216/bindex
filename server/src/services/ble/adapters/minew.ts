import { checkSize, parseJsonBody } from "../../tracking/adapters/common";
import { finiteOrNull, parseTimestamp } from "../../tracking/normalize";
import {
  AdapterError,
  arrayIn,
  batteryLevel,
  hexData,
  identityFromFields,
  isRecord,
  nonEmptyString,
  type GatewayPayload,
  type RawAdvert,
} from "./common";

const EXPECTED =
  'a JSON array of Minew gateway entries: [{ "type": "Gateway", "mac": "AC233FC0…" }, { "type": "Unknown", "mac": "AC233F…", "rssi": -61, "rawData": "0201…", "timestamp": "…" }]';

/**
 * Minew G1 and MG3 gateways, HTTP or MQTT, in their JSON upload format.
 *
 * The body is an array. The entry with "type": "Gateway" describes the
 * gateway itself (its MAC names it). Every other entry is one advertiser:
 * "mac", "rssi", "timestamp" and, in the raw formats, "rawData" (the
 * advertising data in hex). In the parsed formats, iBeacon entries carry
 * ibeaconUuid, ibeaconMajor, ibeaconMinor and ibeaconTxPower instead, and
 * sensor entries a "battery" percentage. rawData wins when both are present.
 *
 * Built from Minew's published G1 and MG3 documentation; not yet verified on
 * hardware.
 */
export function parseMinew(body: unknown): GatewayPayload {
  const payload = parseJsonBody(body, EXPECTED);
  const entries = arrayIn(payload, ["data", "devices", "items"]) ?? (isRecord(payload) ? [payload] : null);
  if (!entries) throw new AdapterError(`Expected ${EXPECTED}`);
  checkSize(entries.length);

  const out: GatewayPayload = { adverts: [], skipped: 0 };
  entries.forEach((entry, i) => {
    if (!isRecord(entry)) throw new AdapterError(`Entry ${i} is not an object. Expected ${EXPECTED}`);
    const type = nonEmptyString(entry.type)?.toLowerCase();
    const mac = nonEmptyString(entry.mac);
    if (type === "gateway") {
      if (mac) out.gatewayId ??= mac;
      const battery = batteryLevel(entry.battery);
      if (battery !== undefined) out.batteryPct = battery;
      out.skipped += 1;
      return;
    }
    if (!mac) {
      out.skipped += 1;
      return;
    }
    const data = hexData(entry.rawData ?? entry.raw, `Entry ${i} rawData`);
    const advert: RawAdvert = {
      mac,
      data,
      identity: data ? null : identityFromFields(entry),
      rssi: finiteOrNull(entry.rssi),
      at: parseTimestamp(entry.timestamp),
      txPower: finiteOrNull(entry.ibeaconTxPower ?? entry.txPower),
      // Minew reports 0 when a beacon does not send its battery level.
      batteryPct: (batteryLevel(entry.battery) || null) ?? null,
      temperatureC: finiteOrNull(entry.temperature),
      name: nonEmptyString(entry.bleName) ?? null,
    };
    out.adverts.push(advert);
  });
  return out;
}
