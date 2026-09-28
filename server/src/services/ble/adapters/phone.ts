import { checkSize, parseJsonBody } from "../../tracking/adapters/common";
import { finiteOrNull, parseTimestamp } from "../../tracking/normalize";
import { eddystoneIdentity, ibeaconIdentity } from "../advert";
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
import { parseBleGeneric } from "./generic";

const EXPECTED =
  '{ "beacons": [{ "uuid": "…", "major": 1, "minor": 7, "rssi": -63 }, { "namespace": "…", "instance": "…", "rssi": -70 }, { "id": "ibeacon:…", "rssi": -80 }] }';

/**
 * What a phone reports: the room beacons it can hear right now.
 *
 * Accepts
 * - `{ "beacons": [...] }` (or a bare array), each beacon named by
 *   uuid/major/minor, namespace/instance, an identity (`id`), a MAC, or raw
 *   advertising data (`data`), with its `rssi`;
 * - the logging format of the open-source Android app Beacon Scanner
 *   (`beaconType` with `ibeaconData` / `eddystoneUidData`, `rssi`,
 *   `lastSeen` in epoch milliseconds);
 * - Bindex's generic BLE format (`{ "reads": [...] }`), so a gateway script
 *   can double as a phone.
 */
export function parsePhone(body: unknown): GatewayPayload {
  const payload = parseJsonBody(body, EXPECTED);
  if (isRecord(payload) && Array.isArray(payload.reads)) return parseBleGeneric(payload);
  const beacons = Array.isArray(payload) ? payload : isRecord(payload) ? payload.beacons : undefined;
  if (!Array.isArray(beacons)) throw new AdapterError(`"beacons" must be an array. Expected ${EXPECTED}`);
  checkSize(beacons.length);

  const top = isRecord(payload) ? payload : {};
  const fallbackAt = parseTimestamp(top.ts ?? top.timestamp);
  const adverts: RawAdvert[] = [];
  let skipped = 0;
  beacons.forEach((b, i) => {
    if (!isRecord(b)) throw new AdapterError(`beacons[${i}] must be an object. Expected ${EXPECTED}`);
    const data = hexData(b.data ?? b.rawData, `beacons[${i}].data`);
    const identity = beaconScannerIdentity(b) ?? identityFromFields(b);
    const mac = nonEmptyString(b.mac ?? b.address ?? b.hardwareAddress);
    if (!data && !identity && !mac) {
      skipped += 1;
      return;
    }
    adverts.push({
      identity,
      mac: mac ?? null,
      data,
      rssi: finiteOrNull(b.rssi),
      at: parseTimestamp(b.ts ?? b.timestamp ?? b.lastSeen) ?? fallbackAt,
      txPower: finiteOrNull(b.txPower),
      batteryPct: batteryLevel(b.battery) ?? null,
    });
  });

  return {
    gatewayId: nonEmptyString(top.phone) ?? nonEmptyString(top.device) ?? nonEmptyString(top.reader),
    batteryPct: batteryLevel(top.battery),
    adverts,
    skipped,
  };
}

/** Beacon Scanner (Android) nests each frame's fields under its own key. */
function beaconScannerIdentity(b: Record<string, unknown>): string | null {
  const ib = isRecord(b.ibeaconData) ? b.ibeaconData : null;
  if (ib) {
    const uuid = nonEmptyString(ib.uuid);
    const major = finiteOrNull(ib.major);
    const minor = finiteOrNull(ib.minor);
    if (uuid && major !== null && minor !== null && /^[0-9a-f]{32}$/i.test(uuid.replace(/-/g, ""))) {
      return ibeaconIdentity(uuid, Math.trunc(major), Math.trunc(minor));
    }
  }
  const ed = isRecord(b.eddystoneUidData) ? b.eddystoneUidData : null;
  if (ed) {
    const ns = nonEmptyString(ed.namespaceId)?.replace(/^0x/i, "");
    const inst = nonEmptyString(ed.instanceId)?.replace(/^0x/i, "");
    if (ns && inst && /^[0-9a-f]{20}$/i.test(ns) && /^[0-9a-f]{12}$/i.test(inst)) return eddystoneIdentity(ns, inst);
  }
  return null;
}
