import { checkSize, parseJsonBody } from "../../tracking/adapters/common";
import { finiteOrNull, parseTimestamp } from "../../tracking/normalize";
import { formatMac } from "../advert";
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
  'Kontakt.io events: [{ "trackingId": "…", "uniqueId": "AbC1", "sourceId": "<gateway id>", "rssi": -63, "timestamp": 1560000000, "batteryLevel": 100 }]';

/**
 * Kontakt.io-style presence and telemetry events, as Kontakt.io Portal Beams
 * and gateways forward them (a JSON array, or an object holding the array under
 * events, data, content or items).
 *
 * Each event names the beacon by `uniqueId` (the id printed on a Kontakt.io
 * beacon, stored as kontakt:<uniqueId>) and/or `trackingId` (its Bluetooth
 * address, or another id); `sourceId` names the gateway that heard it.
 * `timestamp` is epoch seconds or milliseconds. `batteryLevel` is a
 * percentage.
 *
 * Built from Kontakt.io's published event fields; not yet verified on
 * hardware.
 */
export function parseKontakt(body: unknown): GatewayPayload {
  const payload = parseJsonBody(body, EXPECTED);
  const events =
    arrayIn(payload, ["events", "data", "content", "items", "telemetry"]) ?? (isRecord(payload) ? [payload] : null);
  if (!events) throw new AdapterError(`Expected ${EXPECTED}`);
  checkSize(events.length);

  const out: GatewayPayload = { adverts: [], skipped: 0 };
  events.forEach((e, i) => {
    if (!isRecord(e)) throw new AdapterError(`Event ${i} is not an object. Expected ${EXPECTED}`);
    const uniqueId = nonEmptyString(e.uniqueId);
    const trackingId = nonEmptyString(e.trackingId ?? e.deviceAddress ?? e.mac);
    const mac = trackingId && formatMac(trackingId) ? trackingId : null;
    const other = trackingId && !mac ? trackingId : undefined;
    if (!uniqueId && !trackingId) {
      out.skipped += 1;
      return;
    }
    const source = nonEmptyString(e.sourceId ?? e.gatewayId);
    if (source) out.gatewayId ??= source;
    const advert: RawAdvert = {
      mac,
      identity: uniqueId ? `kontakt:${uniqueId}` : other ? `kontakt:${other}` : null,
      rssi: finiteOrNull(e.rssi),
      at: parseTimestamp(e.timestamp ?? e.time),
      txPower: finiteOrNull(e.txPower),
      batteryPct: batteryLevel(e.batteryLevel ?? e.battery) ?? null,
      temperatureC: finiteOrNull(e.temperature),
      name: nonEmptyString(e.name) ?? null,
    };
    out.adverts.push(advert);
  });
  if (!out.adverts.length && events.length && out.skipped === events.length) {
    throw new AdapterError(`No event names a beacon (uniqueId or trackingId). Expected ${EXPECTED}`);
  }
  return out;
}
