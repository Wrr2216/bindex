import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Pure geometry, fence rules, the jump filter and route figures. No database.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Geo = typeof import("../src/services/gps/geo");
type Fence = typeof import("../src/services/gps/fence");
type Filter = typeof import("../src/services/gps/filter");
type Route = typeof import("../src/services/gps/route");
type Tiles = typeof import("../src/services/gps/tiles");

let geo: Geo;
let fence: Fence;
let filter: Filter;
let route: Route;
let tiles: Tiles;

before(async () => {
  geo = await import("../src/services/gps/geo");
  fence = await import("../src/services/gps/fence");
  filter = await import("../src/services/gps/filter");
  route = await import("../src/services/gps/route");
  tiles = await import("../src/services/gps/tiles");
});

/** Within `tol` metres. */
const near = (actual: number, expected: number, tol: number) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected} ± ${tol}, got ${actual}`);

/** A point `m` metres north (or east) of p, on a sphere of the module's radius. */
const north = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + m / 111_195.08, lng: p.lng });
const east = (p: { lat: number; lng: number }, m: number) => ({
  lat: p.lat,
  lng: p.lng + m / (111_195.08 * Math.cos((p.lat * Math.PI) / 180)),
});

const circle = (center: { lat: number; lng: number }, radiusM: number, extra: Partial<{ dwellSeconds: number; locationId: string | null; id: string }> = {}) =>
  fence.compileFence({
    id: extra.id ?? "c",
    name: "Circle",
    kind: "circle",
    geometry: { type: "Point", coordinates: [center.lng, center.lat] },
    radiusM,
    locationId: extra.locationId ?? null,
    dwellSeconds: extra.dwellSeconds ?? 0,
    geometryAt: new Date(0),
  });

const polygon = (rings: [number, number][][], extra: Partial<{ locationId: string | null; id: string }> = {}) =>
  fence.compileFence({
    id: extra.id ?? "p",
    name: "Polygon",
    kind: "polygon",
    geometry: { type: "Polygon", coordinates: rings },
    radiusM: null,
    locationId: extra.locationId ?? null,
    dwellSeconds: 0,
    geometryAt: new Date(0),
  });

describe("haversine", () => {
  it("measures known distances", () => {
    // Big Ben to the Eiffel Tower.
    near(geo.haversineM({ lat: 51.5007, lng: -0.1246 }, { lat: 48.8584, lng: 2.2945 }), 340_539, 50);
    // JFK to Heathrow.
    near(geo.haversineM({ lat: 40.6413, lng: -73.7781 }, { lat: 51.47, lng: -0.4543 }), 5_540_019, 500);
    // Pole to pole is half the circumference.
    near(geo.haversineM({ lat: 90, lng: 0 }, { lat: -90, lng: 0 }), Math.PI * geo.EARTH_RADIUS_M, 1);
    assert.equal(geo.haversineM({ lat: 12.3, lng: 45.6 }, { lat: 12.3, lng: 45.6 }), 0);
  });

  it("takes the short way across the antimeridian", () => {
    near(geo.haversineM({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 }), 22_239, 1);
    near(geo.haversineM({ lat: 0, lng: -179.9 }, { lat: 0, lng: 179.9 }), 22_239, 1);
    // Fiji straddles it.
    near(geo.haversineM({ lat: -17.7134, lng: 178.065 }, { lat: -16.8, lng: -179.9 }), 238_770, 50);
  });

  it("wraps longitudes", () => {
    assert.equal(geo.wrapLng(190), -170);
    assert.equal(geo.wrapLng(-190), 170);
    assert.equal(geo.wrapLng(360), 0);
    assert.equal(geo.wrapLng(-180), -180);
  });
});

describe("point in polygon", () => {
  const square = [
    { lat: -1, lng: -1 },
    { lat: -1, lng: 1 },
    { lat: 1, lng: 1 },
    { lat: 1, lng: -1 },
  ];

  it("tells inside from outside", () => {
    assert.equal(geo.pointInRing({ lat: 0, lng: 0 }, square), true);
    assert.equal(geo.pointInRing({ lat: 0, lng: 2 }, square), false);
    assert.equal(geo.pointInRing({ lat: 1.5, lng: 0 }, square), false);
  });

  it("handles a concave outline", () => {
    // A U open to the north: the notch is outside.
    const u = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 3 },
      { lat: 3, lng: 3 },
      { lat: 3, lng: 2 },
      { lat: 1, lng: 2 },
      { lat: 1, lng: 1 },
      { lat: 3, lng: 1 },
      { lat: 3, lng: 0 },
    ];
    assert.equal(geo.pointInRing({ lat: 2, lng: 1.5 }, u), false);
    assert.equal(geo.pointInRing({ lat: 2, lng: 0.5 }, u), true);
    assert.equal(geo.pointInRing({ lat: 0.5, lng: 1.5 }, u), true);
  });

  it("respects holes", () => {
    const hole = [
      { lat: -0.5, lng: -0.5 },
      { lat: -0.5, lng: 0.5 },
      { lat: 0.5, lng: 0.5 },
      { lat: 0.5, lng: -0.5 },
    ];
    assert.equal(geo.pointInPolygon({ lat: 0, lng: 0 }, [square, hole]), false);
    assert.equal(geo.pointInPolygon({ lat: 0.8, lng: 0 }, [square, hole]), true);
  });

  it("works for a polygon drawn across the antimeridian", () => {
    const dateline = [
      { lat: -1, lng: 179 },
      { lat: -1, lng: -179 },
      { lat: 1, lng: -179 },
      { lat: 1, lng: 179 },
    ];
    assert.equal(geo.pointInRing({ lat: 0, lng: 179.5 }, dateline), true);
    assert.equal(geo.pointInRing({ lat: 0, lng: -179.5 }, dateline), true);
    assert.equal(geo.pointInRing({ lat: 0, lng: 180 }, dateline), true);
    assert.equal(geo.pointInRing({ lat: 0, lng: 178 }, dateline), false);
    // A naive test sees a band 358 degrees wide and puts Greenwich inside it.
    assert.equal(geo.pointInRing({ lat: 0, lng: 0 }, dateline), false);
  });

  it("measures distance to the boundary", () => {
    // Half of 0.01 degree of latitude.
    const small = square.map((p) => ({ lat: p.lat / 100, lng: p.lng / 100 }));
    near(geo.distanceToBoundaryM({ lat: 0, lng: 0 }, [small]), 1112, 2);
    near(geo.distanceToBoundaryM({ lat: 0.02, lng: 0 }, [small]), 1112, 2);
  });

  it("works out areas roughly", () => {
    const km = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1000 / 111_195.08 },
      { lat: 1000 / 111_195.08, lng: 1000 / 111_195.08 },
      { lat: 1000 / 111_195.08, lng: 0 },
    ];
    near(geo.ringAreaM2(km), 1_000_000, 1000);
  });
});

describe("fences", () => {
  const yard = { lat: 51.5, lng: -0.12 };

  it("normalizes and validates shapes", () => {
    const open = fence.normalizeGeometry(
      "polygon",
      { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1]]] },
      null,
    );
    assert.deepEqual(open.geometry.coordinates, [[[0, 0], [1, 0], [1, 1], [0, 0]]]);
    assert.throws(() => fence.normalizeGeometry("circle", { type: "Point", coordinates: [0, 0] }, 0), /radius/);
    assert.throws(() => fence.normalizeGeometry("circle", { type: "Point", coordinates: [0, 95] }, 10), /off the map/);
    assert.throws(() => fence.normalizeGeometry("polygon", { type: "Point", coordinates: [0, 0] }, null), /Polygon/);
    assert.throws(
      () => fence.normalizeGeometry("polygon", { type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 0]]] }, null),
      /three/,
    );
    assert.throws(
      () => fence.normalizeGeometry("polygon", { type: "Polygon", coordinates: [[[0, 0], [1, 1], [2, 2]]] }, null),
      /no area/,
    );
  });

  it("uses the fix's accuracy as an uncertain band at a circle's edge", () => {
    const f = circle(yard, 100);
    assert.equal(fence.containment(f, north(yard, 50), 20), "inside");
    assert.equal(fence.containment(f, north(yard, 90), 20), "uncertain");
    assert.equal(fence.containment(f, north(yard, 110), 20), "uncertain");
    assert.equal(fence.containment(f, north(yard, 130), 20), "outside");
    assert.equal(fence.containment(f, north(yard, 99), null), "inside");
    assert.equal(fence.containment(f, north(yard, 101), null), "outside");
    assert.equal(fence.containment(f, north(yard, 50_000), 20), "outside");
  });

  it("does the same for a polygon", () => {
    const d = 500 / 111_195.08;
    const f = polygon([
      [
        [yard.lng - d, yard.lat - d],
        [yard.lng + d, yard.lat - d],
        [yard.lng + d, yard.lat + d],
        [yard.lng - d, yard.lat + d],
      ],
    ]);
    assert.equal(fence.containment(f, yard, 10), "inside");
    assert.equal(fence.containment(f, north(yard, 495), 10), "uncertain");
    assert.equal(fence.containment(f, north(yard, 520), 10), "outside");
    near(fence.distanceToFenceM(f, north(yard, 1500)), 1000, 2);
    assert.equal(fence.distanceToFenceM(f, yard), 0);
  });

  it("confirms a crossing only after the dwell time, dated when it happened", () => {
    const at = (s: number) => ({ at: s * 1000, lat: 1, lng: 2 });
    let st = fence.OUTSIDE;
    let r = fence.stepFence(st, "inside", at(0), 30_000);
    assert.equal(r.transition, null);
    st = r.state;
    r = fence.stepFence(st, "inside", at(10), 30_000);
    assert.equal(r.transition, null);
    st = r.state;
    r = fence.stepFence(st, "inside", at(35), 30_000);
    assert.deepEqual(r.transition, { kind: "entered", occurredAt: 0, confirmedAt: 35_000, lat: 1, lng: 2 });
    assert.equal(r.state.inside, true);
  });

  it("ignores a stray fix and flapping at the edge", () => {
    const at = (s: number) => ({ at: s * 1000, lat: 0, lng: 0 });
    let st: import("../src/services/gps/fence").FenceState = { inside: true, since: 0, pending: null };
    const seq: [import("../src/services/gps/fence").Containment, number][] = [
      ["outside", 100], // one bad fix
      ["inside", 110], // back: cancelled
      ["outside", 200],
      ["uncertain", 215], // says nothing
      ["inside", 220], // back again
      ["outside", 300],
      ["uncertain", 320],
      ["outside", 331], // held for 31 s: out, from 300
    ];
    const transitions = [];
    for (const [side, s] of seq) {
      const r = fence.stepFence(st, side, at(s), 30_000);
      st = r.state;
      if (r.transition) transitions.push(r.transition);
    }
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]!.kind, "exited");
    assert.equal(transitions[0]!.occurredAt, 300_000);
  });

  it("fires on the first fix when the dwell is zero", () => {
    const r = fence.stepFence(fence.OUTSIDE, "inside", { at: 5, lat: 0, lng: 0 }, 0);
    assert.equal(r.transition?.kind, "entered");
  });

  it("picks the smallest linked fence as the zone", () => {
    const big = circle(yard, 1000, { id: "big", locationId: "site" });
    const small = circle(yard, 50, { id: "small", locationId: "dock" });
    const unlinked = circle(yard, 10, { id: "none" });
    assert.deepEqual(
      fence.zoneFromFences([big, small, unlinked], () => true),
      { locationId: "dock", fenceId: "small" },
    );
    assert.deepEqual(
      fence.zoneFromFences([big, small], (id) => id === "big"),
      { locationId: "site", fenceId: "big" },
    );
    assert.equal(fence.zoneFromFences([big, small], () => false), null);
  });
});

describe("jump filter", () => {
  const p = (lat: number, lng: number, s: number, accuracyM: number | null = 5) => ({ lat, lng, at: s * 1000, accuracyM });

  it("accepts ordinary movement and rejects an impossible jump", () => {
    let st = filter.EMPTY_FILTER;
    let r = filter.screenFix(st, p(51.5, -0.12, 0), 70);
    assert.equal(r.result.verdict, "accept");
    st = r.state;
    // 300 m in 30 s: 10 m/s.
    r = filter.screenFix(st, { ...north({ lat: 51.5, lng: -0.12 }, 300), at: 30_000, accuracyM: 5 }, 70);
    assert.equal(r.result.verdict, "accept");
    st = r.state;
    // 50 km in 10 s.
    r = filter.screenFix(st, p(51.95, -0.12, 40), 70);
    assert.equal(r.result.verdict, "jump");
    assert.ok(r.result.verdict === "jump" && r.result.impliedSpeedMps > 1000);
    assert.equal(r.state.last!.at, 30_000, "the reference does not move");
  });

  it("keeps late fixes out of the way", () => {
    const st = filter.screenFix(filter.EMPTY_FILTER, p(0, 0, 100), 70).state;
    assert.equal(filter.screenFix(st, p(0, 0.0001, 90), 70).result.verdict, "out_of_order");
    assert.equal(filter.screenFix(st, p(0, 0.0001, 100), 70).result.verdict, "out_of_order");
  });

  it("gives a jump the benefit of both fixes' accuracy, up to a point", () => {
    const st = filter.screenFix(filter.EMPTY_FILTER, { lat: 0, lng: 0, at: 0, accuracyM: 100 }, 70).state;
    // 250 m in 1 s is 250 m/s, but with 200 m of stated error it is 50 m/s.
    const hop = { ...east({ lat: 0, lng: 0 }, 250), at: 1000, accuracyM: 100 };
    assert.equal(filter.screenFix(st, hop, 70).result.verdict, "accept");
    // Vaguer fixes earn no more credit.
    const vague = { ...east({ lat: 0, lng: 0 }, 500), at: 1000, accuracyM: 5000 };
    assert.equal(filter.screenFix(st, vague, 70).result.verdict, "jump");
  });

  it("re-anchors after consistent fixes somewhere else", () => {
    // The first fix was wrong (a cold start put it in another city).
    let st = filter.screenFix(filter.EMPTY_FILTER, p(48.85, 2.29, 0), 70).state;
    const verdicts: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = filter.screenFix(st, { ...north({ lat: 51.5, lng: -0.12 }, i * 100), at: i * 10_000, accuracyM: 5 }, 70);
      st = r.state;
      verdicts.push(r.result.verdict === "accept" && r.result.reanchored ? "reanchor" : r.result.verdict);
    }
    assert.deepEqual(verdicts, ["jump", "jump", "reanchor", "accept"]);
  });

  it("does not re-anchor on jumps that disagree with each other", () => {
    let st = filter.screenFix(filter.EMPTY_FILTER, p(51.5, -0.12, 0), 70).state;
    const far = [p(40, 10, 10), p(-30, 100, 20), p(10, -60, 30), p(60, 60, 40)];
    for (const f of far) {
      const r = filter.screenFix(st, f, 70);
      assert.equal(r.result.verdict, "jump");
      st = r.state;
    }
  });
});

describe("route figures", () => {
  it("averages speed over the window", () => {
    const start = { lat: 51.5, lng: -0.12 };
    const recent = [0, 1, 2, 3].map((i) => ({ ...north(start, i * 600), at: i * 60_000 }));
    near(route.averageSpeedMps(recent)!, 10, 0.01);
    assert.equal(route.averageSpeedMps(recent.slice(0, 1)), null);
    // Under a minute is too short to trust.
    assert.equal(route.averageSpeedMps([recent[0]!, { ...recent[1]!, at: 30_000 }]), null);
  });

  it("estimates arrival, or declines to", () => {
    assert.equal(route.estimateArrival(36_000, 10, 1_000), 1_000 + 3_600_000);
    assert.equal(route.estimateArrival(0, null, 1_000), 1_000);
    assert.equal(route.estimateArrival(1000, 0.1, 1_000), null, "stopped");
    assert.equal(route.estimateArrival(null, 10, 1_000), null, "no destination");
    assert.equal(route.estimateArrival(1e9, 0.6, 0), null, "too far out");
  });

  it("keeps half an hour of fixes", () => {
    const fixes = Array.from({ length: 50 }, (_, i) => ({ lat: 0, lng: 0, at: i * 60_000 }));
    const kept = route.pushRecent([], fixes);
    assert.equal(kept[0]!.at, 19 * 60_000);
    assert.equal(kept[kept.length - 1]!.at, 49 * 60_000);
  });
});

describe("map tile sources", () => {
  it("names the tile host for the page's security policy", () => {
    assert.deepEqual(tiles.mapTileSources("https://tile.openstreetmap.org/{z}/{x}/{y}.png"), [
      "https://tile.openstreetmap.org",
    ]);
    assert.deepEqual(tiles.mapTileSources("https://{s}.tile.example.com/{z}/{x}/{y}.png"), [
      "https://*.tile.example.com",
    ]);
    assert.deepEqual(tiles.mapTileSources("http://tiles.lan:8080/styles/basic/{z}/{x}/{y}.png"), [
      "http://tiles.lan:8080",
    ]);
    assert.deepEqual(tiles.mapTileSources("https://tiles-{s}.example.com/{z}/{x}/{y}.png"), ["https:"]);
    assert.deepEqual(tiles.mapTileSources("https://user:pw@tiles.example.com/{z}/{x}/{y}.png"), []);
    assert.deepEqual(tiles.mapTileSources("not a url"), []);
  });
});
