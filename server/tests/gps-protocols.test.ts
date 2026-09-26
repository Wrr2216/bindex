import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Tracker payload parsers and the batch planner. No database.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Protocols = typeof import("../src/services/gps/protocols");
type Ingest = typeof import("../src/services/gps/ingest");
type Fence = typeof import("../src/services/gps/fence");

let p: Protocols;
let ingest: Ingest;
let fence: Fence;

before(async () => {
  p = await import("../src/services/gps/protocols");
  ingest = await import("../src/services/gps/ingest");
  fence = await import("../src/services/gps/fence");
});

describe("OsmAnd protocol", () => {
  it("reads Traccar Client's query string", () => {
    const { reports } = p.parseOsmAnd(
      {
        id: "356938035643809",
        lat: "51.5007",
        lon: "-0.1246",
        timestamp: "1790431200",
        speed: "10",
        bearing: "92.5",
        altitude: "35",
        accuracy: "8",
        batt: "87.4",
        charge: "false",
      },
      undefined,
    );
    assert.equal(reports.length, 1);
    const r = reports[0]!;
    assert.equal(r.deviceKey, "356938035643809");
    assert.equal(r.at?.toISOString(), "2026-09-26T14:00:00.000Z");
    assert.equal(r.batteryPct, 87);
    assert.deepEqual(r.fix, {
      lat: 51.5007,
      lng: -0.1246,
      accuracyM: 8,
      speed: { value: 10, unit: "kn" },
      headingDeg: 92.5,
      altitudeM: 35,
      valid: true,
    });
    // Knots, as Traccar Client sends them, to metres per second.
    assert.equal(Math.round(p.toMps(r.fix!.speed)! * 1000) / 1000, 5.144);
    // A device whose app sends m/s overrides the unit.
    assert.equal(p.toMps(r.fix!.speed, "mps"), 10);
    assert.deepEqual(r.meta, { protocol: "osmand", charging: false });
  });

  it("accepts a form body, a location pair, ISO and millisecond times, and odd case", () => {
    const form = p.parseOsmAnd({}, { DeviceId: "abc", location: "40.1,-73.2", timestamp: "2026-09-26 14:00:00" });
    assert.equal(form.reports[0]!.deviceKey, "abc");
    assert.equal(form.reports[0]!.fix!.lat, 40.1);
    assert.equal(form.reports[0]!.fix!.lng, -73.2);
    assert.equal(form.reports[0]!.at!.toISOString(), "2026-09-26T14:00:00.000Z", "no zone means UTC");
    const ms = p.parseOsmAnd({ id: "x", lat: "1", lon: "2", timestamp: "1790431200123" }, undefined);
    assert.equal(ms.reports[0]!.at!.toISOString(), "2026-09-26T14:00:00.123Z");
  });

  it("marks invalid fixes and drops null island", () => {
    const invalid = p.parseOsmAnd({ id: "x", lat: "1", lon: "2", valid: "false" }, undefined);
    assert.equal(invalid.reports[0]!.fix!.valid, false);
    const island = p.parseOsmAnd({ id: "x", lat: "0", lon: "0", batt: "50" }, undefined);
    assert.equal(island.reports[0]!.fix, null);
    assert.equal(island.reports[0]!.batteryPct, 50);
  });

  it("refuses what it cannot use", () => {
    assert.throws(() => p.parseOsmAnd({}, undefined), /No position/);
    assert.throws(() => p.parseOsmAnd({ id: "x", lat: "91", lon: "0" }, undefined), /latitude/);
    assert.throws(() => p.parseOsmAnd({ id: "x", lat: "1" }, undefined), /not both/);
    assert.throws(() => p.parseOsmAnd({ id: "x", lat: "1", lon: "2", timestamp: "soon" }, undefined), /timestamp/);
  });

  it("reads current Traccar Client JSON, single or batched", () => {
    const body = {
      device_id: "phone-7",
      location: {
        timestamp: "2026-09-26T14:00:00.000Z",
        coords: { latitude: 51.5, longitude: -0.12, accuracy: 6.5, speed: 3.2, heading: -1, altitude: 20 },
        is_moving: true,
        odometer: 1234,
        event: "motionchange",
        battery: { level: 0.42, is_charging: true },
        activity: { type: "in_vehicle" },
      },
    };
    const one = p.parseOsmAnd({}, body);
    const r = one.reports[0]!;
    assert.equal(r.deviceKey, "phone-7");
    assert.equal(r.batteryPct, 42);
    assert.deepEqual(r.fix!.speed, { value: 3.2, unit: "mps" });
    assert.equal(r.fix!.headingDeg, null, "-1 means unknown");
    assert.deepEqual(r.meta, {
      protocol: "traccar_client",
      event: "motionchange",
      moving: true,
      odometerM: 1234,
      charging: true,
      activity: "in_vehicle",
    });
    const text = p.parseOsmAnd({}, JSON.stringify({ ...body, location: [body.location, body.location] }));
    assert.equal(text.reports.length, 2);
  });
});

describe("Traccar forwarding", () => {
  const position = {
    id: 99,
    attributes: { batteryLevel: 71, motion: true, battery: 4.1 },
    deviceId: 5,
    protocol: "teltonika",
    serverTime: "2026-09-26T14:00:05.000+00:00",
    deviceTime: "2026-09-26T14:00:01.000+00:00",
    fixTime: "2026-09-26T14:00:00.000+00:00",
    outdated: false,
    valid: true,
    latitude: 52.1,
    longitude: 4.3,
    altitude: 2,
    speed: 20,
    course: 180,
    accuracy: 0,
  };
  const device = { id: 5, name: "Trailer 12", uniqueId: "861230043907626" };

  it("reads position forwarding", () => {
    const { reports } = p.parseTraccarForward({ position, device });
    const r = reports[0]!;
    assert.equal(r.deviceKey, "861230043907626");
    assert.equal(r.deviceName, "Trailer 12");
    assert.equal(r.at!.toISOString(), "2026-09-26T14:00:00.000Z");
    assert.deepEqual(r.fix, {
      lat: 52.1,
      lng: 4.3,
      accuracyM: null,
      speed: { value: 20, unit: "kn" },
      headingDeg: 180,
      altitudeM: 2,
      valid: true,
    });
    assert.equal(r.batteryPct, 71);
    assert.equal(r.meta!.traccarProtocol, "teltonika");
  });

  it("reads event forwarding, with and without a position", () => {
    const withPosition = p.parseTraccarForward({
      event: { id: 1, type: "geofenceEnter", eventTime: "2026-09-26T14:00:00Z", deviceId: 5 },
      position,
      device,
    });
    assert.equal(withPosition.reports[0]!.meta!.event, "geofenceEnter");
    assert.ok(withPosition.reports[0]!.fix);
    const bare = p.parseTraccarForward({ event: { type: "deviceOnline", eventTime: "2026-09-26T14:00:00Z" }, device });
    assert.equal(bare.reports[0]!.fix, null);
    assert.equal(bare.reports[0]!.meta!.event, "deviceOnline");
  });

  it("does not take a repeated position as a new fix", () => {
    const { reports } = p.parseTraccarForward({ position: { ...position, outdated: true }, device });
    assert.equal(reports[0]!.fix, null);
  });

  it("needs a device to match", () => {
    assert.throws(() => p.parseTraccarForward({ position }), /uniqueId/);
    assert.throws(() => p.parseTraccarForward({ hello: 1 }), /Unrecognised/);
    assert.throws(() => p.parseTraccarForward("not json"), /not JSON/);
  });
});

describe("generic batch", () => {
  it("reads fixes with per-fix devices", () => {
    const { reports } = p.parseGpsBatch({
      device: "truck-12",
      battery: 64,
      fixes: [
        { ts: "2026-09-26T14:00:00Z", lat: 51.5, lng: -0.12, accuracy: 6, speed: 13.4, heading: 92 },
        { ts: 1790431260000, lat: 51.51, lon: -0.12, device: "trailer-3", battery: 99 },
      ],
    });
    assert.equal(reports[0]!.deviceKey, "truck-12");
    assert.equal(reports[0]!.batteryPct, 64);
    assert.deepEqual(reports[0]!.fix!.speed, { value: 13.4, unit: "mps" });
    assert.equal(reports[1]!.deviceKey, "trailer-3");
    assert.equal(reports[1]!.batteryPct, 99);
    assert.equal(reports[1]!.at!.toISOString(), "2026-09-26T14:01:00.000Z");
  });

  it("explains a bad batch", () => {
    assert.throws(() => p.parseGpsBatch({ fixes: "no" }), /must be an array/);
    assert.throws(() => p.parseGpsBatch({ fixes: [{ lat: 1 }] }), /not both/);
    assert.throws(() => p.parseGpsBatch({ fixes: [{ lat: 1, lng: 200 }] }), /longitude/);
    assert.throws(() => p.parseGpsBatch({ fixes: [{ lat: 1, lng: 2, ts: "yesterday" }] }), /not a time/);
  });
});

describe("planning a batch", () => {
  const yard = { lat: 51.5, lng: -0.12 };
  const north = (m: number) => ({ lat: yard.lat + m / 111_195.08, lng: yard.lng });
  const origin = () =>
    fence.compileFence({
      id: "origin",
      name: "Yard",
      kind: "circle",
      geometry: { type: "Point", coordinates: [yard.lng, yard.lat] },
      radiusM: 200,
      locationId: "loc-yard",
      dwellSeconds: 30,
      geometryAt: new Date(0),
    });
  const report = (m: number, s: number, extra: Partial<import("../src/services/gps/protocols").GpsFix> = {}) => ({
    deviceKey: null,
    deviceName: null,
    at: new Date(Date.UTC(2026, 8, 26, 14) + s * 1000),
    fix: { ...north(m), accuracyM: 5, speed: null, headingDeg: null, altitudeM: null, valid: true, ...extra },
    batteryPct: null,
    meta: null,
  });
  const now = new Date(Date.UTC(2026, 8, 26, 15));

  it("learns its side of a fence quietly, then confirms an exit after the dwell", () => {
    const plan = ingest.planBatch(
      { settings: {} },
      null,
      new Map(),
      [origin()],
      [report(0, 0), report(100, 20), report(400, 40), report(700, 60), report(1000, 80)],
      now,
    );
    assert.equal(plan.counts.accepted, 5);
    assert.equal(plan.crossings.length, 1);
    const [c] = plan.crossings;
    assert.equal(c!.transition.kind, "exited");
    assert.equal(c!.transition.occurredAt, Date.UTC(2026, 8, 26, 14, 0, 40));
    assert.equal(c!.transition.confirmedAt, Date.UTC(2026, 8, 26, 14, 1, 20));
    // The zone follows the confirmed side: in the yard until the exit is confirmed.
    assert.deepEqual(
      plan.reads.map((r) => r.locationId),
      ["loc-yard", "loc-yard", "loc-yard", "loc-yard", null],
    );
  });

  it("stores a jump flagged and unattached, and a late fix as history", () => {
    const tracker = {
      lastLat: north(0).lat,
      lastLng: north(0).lng,
      lastAccuracyM: 5,
      lastFixAt: new Date(Date.UTC(2026, 8, 26, 14)),
      rejectStreak: 0,
      rejectLat: null,
      rejectLng: null,
      rejectAccuracyM: null,
      rejectAt: null,
      evaluatedAt: new Date(Date.UTC(2026, 8, 26, 14)),
    };
    const plan = ingest.planBatch(
      { settings: {} },
      tracker,
      new Map([["origin", { inside: true, since: 0, pending: null }]]),
      [origin()],
      [report(0, -30), report(80_000, 10), report(50, 20), report(0, 25, { valid: false })],
      now,
    );
    assert.deepEqual(plan.counts, { fixes: 4, accepted: 1, outOfOrder: 1, rejected: 2 });
    const [late, jump, good, invalid] = plan.reads;
    assert.equal(late!.meta!.outOfOrder, true);
    assert.equal(late!.asset, undefined, "a late fix still belongs to the asset");
    assert.equal(jump!.asset, null);
    assert.equal(jump!.meta!.rejected, "jump");
    assert.equal(good!.locationId, "loc-yard");
    assert.equal(invalid!.meta!.rejected, "invalid");
    assert.equal(plan.crossings.length, 0);
  });

  it("does not announce a fence drawn after the tracker was last tested", () => {
    const tracker = {
      lastLat: north(0).lat,
      lastLng: north(0).lng,
      lastAccuracyM: 5,
      lastFixAt: new Date(Date.UTC(2026, 8, 26, 13)),
      rejectStreak: 0,
      rejectLat: null,
      rejectLng: null,
      rejectAccuracyM: null,
      rejectAt: null,
      // Server time, which is what the fence's change time is compared with.
      evaluatedAt: new Date(Date.UTC(2026, 8, 26, 13, 1)),
    };
    const fresh = { ...origin(), geometryAt: Date.UTC(2026, 8, 26, 13, 30) };
    const quiet = ingest.planBatch({ settings: {} }, tracker, new Map(), [fresh], [report(0, 0), report(10, 60)], now);
    assert.equal(quiet.crossings.length, 0);
    assert.equal(quiet.states.get("origin")?.inside, true);
    // Tested since the fence was drawn, the same fixes are a real arrival.
    const later = { ...tracker, evaluatedAt: new Date(Date.UTC(2026, 8, 26, 13, 45)) };
    const loud = ingest.planBatch({ settings: {} }, later, new Map(), [fresh], [report(0, 0), report(10, 60)], now);
    assert.equal(loud.crossings.length, 1);
    assert.equal(loud.crossings[0]!.transition.kind, "entered");
  });

  it("converts speed with the tracker's own unit", () => {
    const plan = ingest.planBatch(
      { settings: { gps: { speedUnit: "kmh" } } },
      null,
      new Map(),
      [],
      [report(0, 0, { speed: { value: 36, unit: "kn" } })],
      now,
    );
    assert.equal(plan.reads[0]!.speedMps, 10);
  });
});
