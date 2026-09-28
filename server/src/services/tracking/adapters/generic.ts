import { SIGHTING_TECHS, type SightingTech } from "../../../db/tables/tracking-core";
import { finiteOrNull, intOrNull, parseTimestamp } from "../normalize";
import type { NormalizedRead } from "../types";
import {
  AdapterError,
  checkSize,
  compactMeta,
  isRecord,
  nonEmptyString,
  parseJsonBody,
  type ParsedPayload,
} from "./common";

const EXPECTED =
  '{ "device"?: "reader-id", "battery"?: 0-100, "reads": [{ "code": "E280...", "ts"?, "rssi"?, "antenna"?, "tech"?, "lat"?, "lng"? }] }';

/**
 * The format Bindex defines for anything that is not a vendor reader: the
 * reference bridge, a BLE gateway script, a phone app.
 *
 *   { "device": "dock-1", "reads": [{ "code": "E28011...", "rssi": -52, "antenna": 3 }] }
 *
 * `ts` is an ISO time or an epoch number (seconds, milliseconds or
 * microseconds). A read without a code must carry lat and lng: it is a tracker
 * reporting where it is.
 */
export function parseGeneric(body: unknown): ParsedPayload {
  const payload = parseJsonBody(body, EXPECTED);
  if (!isRecord(payload)) throw new AdapterError(`Expected an object: ${EXPECTED}`);
  if (!Array.isArray(payload.reads)) {
    throw new AdapterError(`"reads" must be an array. Expected ${EXPECTED}`);
  }

  checkSize(payload.reads.length);
  const reads: NormalizedRead[] = payload.reads.map((raw, i) => parseRead(raw, i));

  const battery = finiteOrNull(payload.battery);
  return {
    readerId: nonEmptyString(payload.device) ?? nonEmptyString(payload.reader),
    batteryPct: battery === null ? undefined : Math.round(Math.min(100, Math.max(0, battery))),
    reads,
    skipped: 0,
  };
}

function parseRead(raw: unknown, i: number): NormalizedRead {
  // A bare string is a code, so a script can post { reads: ["E280...", ...] }.
  if (typeof raw === "string") {
    if (!raw.trim()) throw new AdapterError(`reads[${i}] is an empty string; expected a tag code.`);
    return { code: raw };
  }
  if (!isRecord(raw)) throw new AdapterError(`reads[${i}] must be an object with a "code".`);

  const code = raw.code;
  const lat = finiteOrNull(raw.lat);
  const lng = finiteOrNull(raw.lng ?? raw.lon);
  if (code !== undefined && code !== null && typeof code !== "string") {
    throw new AdapterError(`reads[${i}].code must be a string (an EPC, tag UID, beacon or tracker id).`);
  }
  const hasCode = typeof code === "string" && code.trim() !== "";
  if (!hasCode && (lat === null || lng === null)) {
    throw new AdapterError(`reads[${i}] needs a "code", or "lat" and "lng" for a tracker's own position.`);
  }
  if (lat !== null && (lat < -90 || lat > 90)) throw new AdapterError(`reads[${i}].lat must be between -90 and 90.`);
  if (lng !== null && (lng < -180 || lng > 180)) throw new AdapterError(`reads[${i}].lng must be between -180 and 180.`);

  let tech: SightingTech | null = null;
  if (raw.tech !== undefined && raw.tech !== null) {
    if (typeof raw.tech !== "string" || !(SIGHTING_TECHS as readonly string[]).includes(raw.tech)) {
      throw new AdapterError(`reads[${i}].tech must be one of ${SIGHTING_TECHS.join(", ")}.`);
    }
    tech = raw.tech as SightingTech;
  }

  let direction: "in" | "out" | null = null;
  if (raw.direction === "in" || raw.direction === "out") direction = raw.direction;

  let observedAt: Date | null = null;
  const ts = raw.ts ?? raw.timestamp;
  if (ts !== undefined && ts !== null) {
    observedAt = parseTimestamp(ts);
    if (!observedAt) throw new AdapterError(`reads[${i}].ts is not a time; send ISO 8601 or epoch milliseconds.`);
  }

  return {
    code: hasCode ? (code as string) : null,
    observedAt,
    tech,
    rssi: finiteOrNull(raw.rssi),
    antenna: intOrNull(raw.antenna),
    direction,
    lat,
    lng,
    accuracyM: finiteOrNull(raw.accuracy ?? raw.accuracyM),
    speedMps: finiteOrNull(raw.speed ?? raw.speedMps),
    headingDeg: finiteOrNull(raw.heading ?? raw.headingDeg),
    meta: isRecord(raw.meta) ? compactMeta(raw.meta) : null,
  };
}
