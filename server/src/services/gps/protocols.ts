import { AdapterError, MAX_READS_PER_REQUEST } from "../tracking/adapters";
import { finiteOrNull, parseTimestamp } from "../tracking/normalize";

/**
 * Parsers for what GPS trackers send. Pure functions from a request to
 * reports; the route authenticates the device and the ingest decides what to
 * believe. Each throws AdapterError (a 400) for a payload that is not the
 * expected shape at all, and tolerates fields it does not know.
 *
 * Built from each protocol's published description (Traccar's OsmAnd decoder,
 * Traccar Client, Traccar's JSON forwarders). Not yet verified against every
 * app version; a payload that differs is answered with a 400 saying what was
 * expected.
 */

export type SpeedUnit = "kn" | "mps" | "kmh" | "mph";
export const SPEED_UNITS: readonly SpeedUnit[] = ["kn", "mps", "kmh", "mph"];

const TO_MPS: Record<SpeedUnit, number> = { kn: 0.514444, mps: 1, kmh: 1 / 3.6, mph: 0.44704 };

export function toMps(speed: { value: number; unit: SpeedUnit } | null, override?: SpeedUnit | null): number | null {
  if (!speed || !Number.isFinite(speed.value) || speed.value < 0) return null;
  return speed.value * TO_MPS[override ?? speed.unit];
}

export type GpsFix = {
  lat: number;
  lng: number;
  accuracyM: number | null;
  /** As sent, with the unit the protocol uses; a device setting can override it. */
  speed: { value: number; unit: SpeedUnit } | null;
  headingDeg: number | null;
  altitudeM: number | null;
  /** False when the tracker itself says it has no fix. */
  valid: boolean;
};

/** One message from one tracker: a fix, or only a status (battery, heartbeat). */
export type GpsReport = {
  /** The tracker's own id (IMEI, Traccar uniqueId, app identifier), when the payload names one. */
  deviceKey: string | null;
  deviceName: string | null;
  at: Date | null;
  fix: GpsFix | null;
  batteryPct: number | null;
  meta: Record<string, unknown> | null;
};

export type GpsPayload = {
  reports: GpsReport[];
  /** Messages understood but carrying nothing to store (an event with no position). */
  skipped: number;
};

// --- Helpers -------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
};

const bool = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  if (typeof v === "number") return v !== 0;
  return null;
};

/** A non-negative number, or null; trackers send -1 for "unknown". */
const nonNeg = (v: unknown): number | null => {
  const n = finiteOrNull(v);
  return n === null || n < 0 ? null : n;
};

const pct = (v: unknown, fraction = false): number | null => {
  const n = finiteOrNull(v);
  if (n === null || n < 0) return null;
  const p = fraction && n <= 1 ? n * 100 : n;
  return Math.round(Math.min(100, p));
};

function compact(meta: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return Object.keys(out).length ? out : null;
}

/**
 * A time from a tracker. Epoch numbers (seconds or milliseconds) and ISO
 * strings go through the tracking core's parser; "2024-05-01 10:00:00" with no
 * zone is taken as UTC, as Traccar does, rather than the server's local time.
 */
export function parseGpsTime(v: unknown): Date | null {
  if (typeof v === "string") {
    const s = v.trim();
    const bare = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s);
    if (bare) return parseTimestamp(`${bare[1]}T${bare[2]}Z`);
  }
  return parseTimestamp(v);
}

/**
 * Coordinates, checked. Returns null for a tracker reporting 0,0 ("null
 * island"), which is what many send before their first fix.
 */
function point(lat: unknown, lng: unknown, where: string): { lat: number; lng: number } | null {
  const la = finiteOrNull(lat);
  const lo = finiteOrNull(lng);
  if (la === null && lo === null) return null;
  if (la === null || lo === null) throw new AdapterError(`${where} has a latitude or a longitude but not both.`);
  if (la < -90 || la > 90) throw new AdapterError(`${where}: latitude must be between -90 and 90.`);
  if (lo < -180 || lo > 180) throw new AdapterError(`${where}: longitude must be between -180 and 180.`);
  if (la === 0 && lo === 0) return null;
  return { lat: la, lng: lo };
}

function checkCount(n: number): void {
  if (n > MAX_READS_PER_REQUEST) {
    throw new AdapterError(`Too many positions in one request (${n}); send at most ${MAX_READS_PER_REQUEST}.`);
  }
}

function parseJson(body: unknown, expected: string): unknown {
  if (typeof body !== "string") return body;
  const text = body.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    try {
      return lines.map((l) => JSON.parse(l) as unknown);
    } catch {
      throw new AdapterError(`Body is not JSON. Expected ${expected}.`);
    }
  }
}

// --- OsmAnd and Traccar Client ------------------------------------------------------

const OSMAND_EXPECTED =
  "the OsmAnd protocol: ?id=<device id>&lat=<lat>&lon=<lon>&timestamp=<epoch or ISO>&speed=<knots>&bearing=&altitude=&accuracy=&batt=, as a query string, a form, or Traccar Client's JSON { device_id, location: { timestamp, coords: { latitude, longitude, ... } } }";

/**
 * The OsmAnd protocol as Traccar defines it (Traccar's port 5055): one
 * position per request as query parameters, or the same as a form body.
 *
 *   GET /api/device/gps/osmand?id=356938035643809&lat=51.5007&lon=-0.1246
 *       &timestamp=1727359200&speed=12.3&bearing=90&altitude=35&accuracy=8&batt=87
 *
 * Speed is in knots, as Traccar Client sends it; a device whose app sends
 * metres per second sets its speed unit in the tracker settings. `location`
 * ("lat,lon") may replace lat and lon, `deviceid` may replace id, and
 * `heading` may replace bearing. `valid=false` marks a fix the device does not
 * trust.
 *
 * Current Traccar Client versions post JSON instead, which is handled by
 * parseTraccarClientJson; this function takes either.
 */
export function parseOsmAnd(query: Record<string, unknown>, body: unknown): GpsPayload {
  const parsedBody = typeof body === "string" && body.trim().startsWith("{") ? parseJson(body, OSMAND_EXPECTED) : body;
  // The JSON form nests its location; a form's `location` is a "lat,lon" string.
  if (
    isRecord(parsedBody) &&
    (isRecord(parsedBody.location) ||
      Array.isArray(parsedBody.location) ||
      ("device_id" in parsedBody && !("lat" in parsedBody) && !("location" in parsedBody)))
  ) {
    return parseTraccarClientJson(parsedBody);
  }
  // Query and form fields together; the form wins, and names are matched
  // without regard to case because apps disagree.
  const fields: Record<string, unknown> = {};
  for (const src of [query, isRecord(parsedBody) ? parsedBody : {}]) {
    for (const [k, v] of Object.entries(src)) fields[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }

  let lat: unknown = fields.lat;
  let lng: unknown = fields.lon ?? fields.lng;
  if ((lat === undefined || lng === undefined) && typeof fields.location === "string") {
    const [a, b] = fields.location.split(",");
    lat = a;
    lng = b;
  }
  const deviceKey = str(fields.id) ?? str(fields.deviceid);
  const where = point(lat, lng, "The position");
  const batteryPct = pct(fields.batt ?? fields.battery);
  if (!deviceKey && !where && batteryPct === null) {
    throw new AdapterError(`No position found. Expected ${OSMAND_EXPECTED}.`);
  }

  let at: Date | null = null;
  if (fields.timestamp !== undefined && fields.timestamp !== "") {
    at = parseGpsTime(fields.timestamp);
    if (!at) throw new AdapterError("timestamp is not a time; send epoch seconds or ISO 8601.");
  }
  const speed = nonNeg(fields.speed);
  const valid = bool(fields.valid);
  return {
    reports: [
      {
        deviceKey,
        deviceName: null,
        at,
        fix: where
          ? {
              ...where,
              accuracyM: nonNeg(fields.accuracy),
              speed: speed === null ? null : { value: speed, unit: "kn" },
              headingDeg: nonNeg(fields.bearing ?? fields.heading),
              altitudeM: finiteOrNull(fields.altitude),
              valid: valid !== false,
            }
          : null,
        batteryPct,
        meta: compact({
          protocol: "osmand",
          hdop: finiteOrNull(fields.hdop),
          charging: bool(fields.charge),
          event: str(fields.event),
          motion: bool(fields.motion),
          alarm: str(fields.alarm),
        }),
      },
    ],
    skipped: 0,
  };
}

/**
 * Traccar Client 8 and later (Android and iOS) post JSON to the same OsmAnd
 * URL:
 *
 *   { "device_id": "356938035643809",
 *     "location": { "timestamp": "2026-09-26T14:00:00.000Z",
 *       "coords": { "latitude": 51.5, "longitude": -0.12, "accuracy": 8,
 *                   "speed": 3.2, "heading": 90, "altitude": 35 },
 *       "is_moving": true, "odometer": 1234, "event": "motionchange",
 *       "battery": { "level": 0.87, "is_charging": false } } }
 *
 * Speed is in metres per second here, and -1 means unknown. `location` may be
 * an array when the app sends a backlog in one request.
 */
export function parseTraccarClientJson(body: Record<string, unknown>): GpsPayload {
  const deviceKey = str(body.device_id) ?? str(body.id);
  const locations = Array.isArray(body.location) ? body.location : body.location === undefined ? [] : [body.location];
  checkCount(locations.length);
  const reports: GpsReport[] = [];
  let skipped = 0;
  locations.forEach((loc, i) => {
    if (!isRecord(loc)) {
      skipped += 1;
      return;
    }
    const coords = isRecord(loc.coords) ? loc.coords : {};
    const where = point(coords.latitude, coords.longitude, `location[${i}]`);
    const battery = isRecord(loc.battery) ? loc.battery : {};
    const speed = nonNeg(coords.speed);
    const activity = isRecord(loc.activity) ? loc.activity : {};
    reports.push({
      deviceKey,
      deviceName: null,
      at: parseGpsTime(loc.timestamp),
      fix: where
        ? {
            ...where,
            accuracyM: nonNeg(coords.accuracy),
            speed: speed === null ? null : { value: speed, unit: "mps" },
            headingDeg: nonNeg(coords.heading),
            altitudeM: finiteOrNull(coords.altitude),
            valid: loc.mock !== true,
          }
        : null,
      batteryPct: pct(battery.level, true),
      meta: compact({
        protocol: "traccar_client",
        event: str(loc.event),
        moving: bool(loc.is_moving),
        odometerM: finiteOrNull(loc.odometer),
        charging: bool(battery.is_charging),
        activity: str(activity.type),
      }),
    });
  });
  if (!reports.length && !deviceKey) throw new AdapterError(`No location found. Expected ${OSMAND_EXPECTED}.`);
  return { reports, skipped };
}

// --- Traccar server forwarding ------------------------------------------------------

const TRACCAR_EXPECTED =
  'Traccar\'s JSON forwarding: { "position": { "latitude", "longitude", "fixTime", "speed", "course", ... }, "device": { "uniqueId", "name" } }, or its event forwarding { "event", "position", "device" }, one object or an array';

/**
 * A Traccar server forwarding what its devices report, which makes any of the
 * hundreds of trackers Traccar decodes usable here. Two of its outputs are
 * accepted:
 *
 * - Position forwarding (`forward.enable`, `forward.json`, `forward.url`):
 *   `{ position, device }` per position.
 * - Event forwarding (`event.forward.enable`, `event.forward.url`):
 *   `{ event, position?, device }`. The position is stored when there is one;
 *   an event without one only counts as the device being heard.
 *
 * Positions carry Traccar's units: speed in knots, course in degrees, and
 * `attributes.batteryLevel` in percent. A position Traccar marks `outdated`
 * (the last known one repeated) or `valid: false` is not a new fix. The device
 * is named by `device.uniqueId`, matched to a GPS tracker's serial or IMEI.
 */
export function parseTraccarForward(body: unknown): GpsPayload {
  const payload = parseJson(body, TRACCAR_EXPECTED);
  const messages = Array.isArray(payload) ? payload : [payload];
  checkCount(messages.length);
  const reports: GpsReport[] = [];
  let skipped = 0;
  let recognised = 0;

  messages.forEach((msg, i) => {
    if (!isRecord(msg)) return;
    const device = isRecord(msg.device) ? msg.device : null;
    const position = isRecord(msg.position) ? msg.position : null;
    const event = isRecord(msg.event) ? msg.event : null;
    if (!device && !position && !event) return;
    recognised += 1;
    const deviceKey = device ? (str(device.uniqueId) ?? null) : null;
    if (!deviceKey) {
      throw new AdapterError(`Message ${i} has no device.uniqueId, so it cannot be matched to a tracker.`);
    }
    const attrs = position && isRecord(position.attributes) ? position.attributes : {};
    const eventType = event ? str(event.type) : null;
    const fresh = position && position.outdated !== true;
    const where = fresh ? point(position.latitude, position.longitude, `Message ${i}`) : null;
    const speed = position ? nonNeg(position.speed) : null;
    const at = position
      ? parseGpsTime(position.fixTime ?? position.deviceTime ?? position.serverTime)
      : parseGpsTime(event?.eventTime ?? event?.serverTime);
    const batteryPct = pct(attrs.batteryLevel);
    if (!where && batteryPct === null && !eventType) {
      skipped += 1;
      return;
    }
    reports.push({
      deviceKey,
      deviceName: device ? str(device.name) : null,
      at,
      fix: where
        ? {
            ...where,
            accuracyM: nonNeg(position!.accuracy) || null,
            speed: speed === null ? null : { value: speed, unit: "kn" },
            headingDeg: nonNeg(position!.course),
            altitudeM: finiteOrNull(position!.altitude),
            valid: position!.valid !== false,
          }
        : null,
      batteryPct,
      meta: compact({
        protocol: "traccar",
        traccarProtocol: position ? str(position.protocol) : null,
        event: eventType,
        motion: bool(attrs.motion),
        ignition: bool(attrs.ignition),
        batteryV: finiteOrNull(attrs.battery),
      }),
    });
  });

  if (!recognised) throw new AdapterError(`Unrecognised payload. Expected ${TRACCAR_EXPECTED}.`);
  return { reports, skipped };
}

// --- Generic batch --------------------------------------------------------------------

const GENERIC_EXPECTED =
  '{ "device"?: "tracker id", "battery"?: 0-100, "fixes": [{ "ts": "2026-09-26T14:00:00Z", "lat": 51.5, "lng": -0.12, "accuracy"?, "speed"? (m/s), "heading"?, "altitude"?, "battery"?, "device"? }] }';

/**
 * Bindex's own batch format, for scripts, gateways and apps that buffer
 * positions while offline:
 *
 *   { "device": "truck-12", "battery": 64,
 *     "fixes": [{ "ts": "2026-09-26T14:00:00Z", "lat": 51.5007, "lng": -0.1246,
 *                 "accuracy": 6, "speed": 13.4, "heading": 92 }] }
 *
 * Speed is metres per second. A fix may name its own `device`, so a relay can
 * post for several trackers at once.
 */
export function parseGpsBatch(body: unknown): GpsPayload {
  const payload = parseJson(body, GENERIC_EXPECTED);
  if (!isRecord(payload)) throw new AdapterError(`Expected an object: ${GENERIC_EXPECTED}`);
  const list = payload.fixes ?? payload.positions;
  if (!Array.isArray(list)) throw new AdapterError(`"fixes" must be an array. Expected ${GENERIC_EXPECTED}`);
  checkCount(list.length);
  const deviceKey = str(payload.device);
  const battery = pct(payload.battery);

  const reports: GpsReport[] = list.map((raw, i) => {
    if (!isRecord(raw)) throw new AdapterError(`fixes[${i}] must be an object with lat and lng.`);
    const where = point(raw.lat, raw.lng ?? raw.lon, `fixes[${i}]`);
    if (!where) throw new AdapterError(`fixes[${i}] needs "lat" and "lng".`);
    const ts = raw.ts ?? raw.timestamp ?? raw.time;
    let at: Date | null = null;
    if (ts !== undefined && ts !== null) {
      at = parseGpsTime(ts);
      if (!at) throw new AdapterError(`fixes[${i}].ts is not a time; send ISO 8601 or epoch milliseconds.`);
    }
    const speed = nonNeg(raw.speed);
    return {
      deviceKey: str(raw.device) ?? deviceKey,
      deviceName: null,
      at,
      fix: {
        ...where,
        accuracyM: nonNeg(raw.accuracy ?? raw.accuracyM),
        speed: speed === null ? null : { value: speed, unit: "mps" },
        headingDeg: nonNeg(raw.heading ?? raw.bearing ?? raw.course),
        altitudeM: finiteOrNull(raw.altitude),
        valid: bool(raw.valid) !== false,
      },
      batteryPct: pct(raw.battery) ?? battery,
      meta: isRecord(raw.meta) ? compact({ protocol: "bindex", ...raw.meta }) : { protocol: "bindex" },
    };
  });
  if (!reports.length && battery !== null) {
    reports.push({ deviceKey, deviceName: null, at: null, fix: null, batteryPct: battery, meta: null });
  }
  return { reports, skipped: 0 };
}

/** The first tracker a payload names, which is how a shared INGEST_TOKEN post finds its device. */
export function firstDeviceKey(payload: GpsPayload): string | undefined {
  return payload.reports.find((r) => r.deviceKey)?.deviceKey ?? undefined;
}
