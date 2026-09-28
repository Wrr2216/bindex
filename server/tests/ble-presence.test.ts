import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PRESENCE, median, PresenceEngine, type PresenceConfig, type ZoneChange } from "../src/services/ble/presence";

/**
 * The presence engine against simulated gateway streams. Noise comes from a
 * seeded generator, so every run replays the same readings.
 */

const DOCK_A = "zone-dock-a";
const AISLE_3 = "zone-aisle-3";
const GW_A = "gw-dock-a";
const GW_3 = "gw-aisle-3";

/** mulberry32: small, fast, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian-ish noise (sum of uniforms), plus occasional deep fades and spikes like a body or a forklift. */
function noisy(random: () => number, sigma: number) {
  return (mean: number) => {
    const g = (random() + random() + random() + random() - 2) * sigma * 1.7;
    const r = random();
    const burst = r < 0.05 ? -15 : r > 0.97 ? 12 : 0;
    return Math.round(mean + g + burst);
  };
}

type Reading = { at: number; gateway: string; zone: string; rssi: number };

/**
 * A tag that sits in Dock A, is carried to Aisle 3, and sits there. Both
 * gateways report once a second and miss a fifth of their reports.
 */
function dockToAisle(seed: number, opts: { stayS?: number; walkS?: number; afterS?: number } = {}): Reading[] {
  const random = rng(seed);
  const noise = noisy(random, 4);
  const stay = opts.stayS ?? 120;
  const walk = opts.walkS ?? 12;
  const after = opts.afterS ?? 180;
  const out: Reading[] = [];
  for (let s = 0; s < stay + walk + after; s++) {
    // How far along the walk: 0 in Dock A, 1 in Aisle 3.
    const p = s < stay ? 0 : s < stay + walk ? (s - stay) / walk : 1;
    const meanA = -58 - 26 * p;
    const mean3 = -84 + 26 * p;
    if (random() > 0.2) out.push({ at: s * 1000 + 13, gateway: GW_A, zone: DOCK_A, rssi: noise(meanA) });
    if (random() > 0.2) out.push({ at: s * 1000 + 571, gateway: GW_3, zone: AISLE_3, rssi: noise(mean3) });
  }
  return out;
}

function replay(engine: PresenceEngine, tag: string, readings: Reading[]): ZoneChange[] {
  const changes: ZoneChange[] = [];
  for (const r of readings) {
    const c = engine.observe(tag, r.gateway, r.zone, r.rssi, r.at);
    if (c) changes.push(c);
  }
  return changes;
}

describe("presence engine", () => {
  it("moves a tag from Dock A to Aisle 3 exactly once despite noise", () => {
    for (const seed of [1, 2, 3, 42, 1234, 99999]) {
      const engine = new PresenceEngine();
      engine.seed("tag", DOCK_A, 0);
      const changes = replay(engine, "tag", dockToAisle(seed));
      assert.equal(changes.length, 1, `seed ${seed}: ${JSON.stringify(changes.map((c) => [c.from, c.to, c.at]))}`);
      assert.equal(changes[0]!.from, DOCK_A);
      assert.equal(changes[0]!.to, AISLE_3);
      assert.equal(changes[0]!.gatewayId, GW_3);
      // Decided after the walk passed the midpoint, and not long after it ended.
      assert.ok(changes[0]!.at > 126_000 && changes[0]!.at < 150_000, `seed ${seed}: at ${changes[0]!.at}`);
    }
  });

  it("does the same with a moving average", () => {
    for (const seed of [7, 8, 9]) {
      const engine = new PresenceEngine({ ...DEFAULT_PRESENCE, smoothing: "ewma", ewmaAlpha: 0.2 });
      engine.seed("tag", DOCK_A, 0);
      const changes = replay(engine, "tag", dockToAisle(seed));
      assert.equal(changes.length, 1, `seed ${seed}`);
      assert.equal(changes[0]!.to, AISLE_3);
    }
  });

  it("places a new tag once its room has led for the dwell time", () => {
    const engine = new PresenceEngine();
    const changes = replay(engine, "tag", dockToAisle(5, { stayS: 60, walkS: 0, afterS: 0 }));
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.from, null);
    assert.equal(changes[0]!.to, DOCK_A);
    assert.ok(changes[0]!.at >= DEFAULT_PRESENCE.dwellMs && changes[0]!.at < DEFAULT_PRESENCE.dwellMs + 3000);
  });

  it("does not flap for a tag sitting between two rooms, where the strongest reading would", () => {
    const random = rng(77);
    const noise = noisy(random, 5);
    const readings: Reading[] = [];
    for (let s = 0; s < 600; s++) {
      readings.push({ at: s * 1000, gateway: GW_A, zone: DOCK_A, rssi: noise(-72) });
      readings.push({ at: s * 1000 + 400, gateway: GW_3, zone: AISLE_3, rssi: noise(-73) });
    }
    const engine = new PresenceEngine();
    engine.seed("tag", DOCK_A, 0);
    assert.equal(replay(engine, "tag", readings).length, 0);

    // What picking the loudest gateway on every reading would have done.
    let naive = DOCK_A;
    let flips = 0;
    const last = new Map<string, number>();
    for (const r of readings) {
      last.set(r.zone, r.rssi);
      const best = (last.get(DOCK_A) ?? -999) >= (last.get(AISLE_3) ?? -999) ? DOCK_A : AISLE_3;
      if (best !== naive) {
        flips++;
        naive = best;
      }
    }
    assert.ok(flips > 50, `naive strongest-reading placement flipped ${flips} times`);
  });

  it("needs the hysteresis margin, not just a lead", () => {
    const config: PresenceConfig = { ...DEFAULT_PRESENCE, hysteresisDb: 6, dwellMs: 5000 };
    const steady = (bLead: number) => {
      const engine = new PresenceEngine(config);
      engine.seed("tag", DOCK_A, 0);
      const readings: Reading[] = [];
      for (let s = 0; s < 120; s++) {
        readings.push({ at: s * 1000, gateway: GW_A, zone: DOCK_A, rssi: -70 });
        readings.push({ at: s * 1000 + 500, gateway: GW_3, zone: AISLE_3, rssi: -70 + bLead });
      }
      return replay(engine, "tag", readings);
    };
    assert.equal(steady(4).length, 0);
    assert.equal(steady(5.9).length, 0);
    assert.equal(steady(6).length, 1);
    assert.equal(steady(10).length, 1);
  });

  it("needs the lead to hold for the whole dwell time", () => {
    const config: PresenceConfig = { ...DEFAULT_PRESENCE, windowMs: 3000, dwellMs: 10_000 };
    const burst = (seconds: number) => {
      const engine = new PresenceEngine(config);
      engine.seed("tag", DOCK_A, 0);
      const readings: Reading[] = [];
      for (let s = 0; s < 60; s++) {
        const inBurst = s >= 20 && s < 20 + seconds;
        readings.push({ at: s * 1000, gateway: GW_A, zone: DOCK_A, rssi: inBurst ? -85 : -60 });
        readings.push({ at: s * 1000 + 500, gateway: GW_3, zone: AISLE_3, rssi: inBurst ? -60 : -85 });
      }
      return replay(engine, "tag", readings);
    };
    // A forklift parks between the tag and its gateway for 8 s: no move.
    assert.equal(burst(8).length, 0);
    // For 20 s: one move, and back again once the Dock A signal returns.
    const long = burst(20);
    assert.deepEqual(
      long.map((c) => c.to),
      [AISLE_3, DOCK_A],
    );
    assert.ok(long[0]!.at >= 30_000);
  });

  it("lets any room win once the current room's gateways fall silent", () => {
    const config: PresenceConfig = { ...DEFAULT_PRESENCE, windowMs: 20_000, dwellMs: 10_000 };
    const engine = new PresenceEngine(config);
    engine.seed("tag", DOCK_A, 0);
    const changes: ZoneChange[] = [];
    for (let s = 0; s < 30; s++) engine.observe("tag", GW_A, DOCK_A, -60, s * 1000);
    // Dock A goes quiet; Aisle 3 hears it faintly, far weaker than Dock A ever was.
    for (let s = 30; s < 90; s++) {
      const c = engine.observe("tag", GW_3, AISLE_3, -92, s * 1000);
      if (c) changes.push(c);
    }
    assert.equal(changes.length, 1);
    // The Dock A readings had to leave the window (20 s after the last, at 29 s) and the dwell to pass.
    assert.ok(changes[0]!.at >= 49_000 + 10_000 && changes[0]!.at <= 61_000, `at ${changes[0]!.at}`);
  });

  it("keeps a tag in its room when nothing else hears it, however long it is silent", () => {
    const engine = new PresenceEngine();
    engine.seed("tag", DOCK_A, 0);
    for (let s = 0; s < 10; s++) engine.observe("tag", GW_A, DOCK_A, -60, s * 1000);
    assert.equal(engine.observe("tag", GW_A, DOCK_A, -61, 3_600_000), null);
    assert.equal(engine.zoneOf("tag"), DOCK_A);
  });

  it("ignores gateways without a zone and gateways short of samples", () => {
    const engine = new PresenceEngine({ ...DEFAULT_PRESENCE, minSamples: 3, dwellMs: 0 });
    engine.seed("tag", DOCK_A, 0);
    // A roaming gateway with no zone, very close: never a zone.
    for (let s = 0; s < 20; s++) assert.equal(engine.observe("tag", "gw-roaming", null, -40, s * 1000), null);
    engine.observe("tag", GW_A, DOCK_A, -70, 20_000);
    // Two strong Aisle 3 readings are not enough when three are needed.
    assert.equal(engine.observe("tag", GW_3, AISLE_3, -50, 20_100), null);
    assert.equal(engine.observe("tag", GW_3, AISLE_3, -50, 20_200), null);
    assert.equal(engine.observe("tag", GW_3, AISLE_3, -50, 20_300)?.to, AISLE_3);
  });

  it("drops readings older than the window and sorts late ones in", () => {
    const engine = new PresenceEngine({ ...DEFAULT_PRESENCE, windowMs: 10_000, dwellMs: 0 });
    engine.seed("tag", DOCK_A, 0);
    engine.observe("tag", GW_A, DOCK_A, -60, 100_000);
    // Far too old to be presence.
    assert.equal(engine.observe("tag", GW_3, AISLE_3, -30, 50_000), null);
    // Late but inside the window: counts, sorted into place.
    engine.observe("tag", GW_A, DOCK_A, -62, 99_000);
    const snap = engine.snapshot("tag")!;
    assert.equal(snap.heard.find((h) => h.gatewayId === GW_A)!.samples, 2);
    assert.equal(snap.heard.find((h) => h.gatewayId === GW_3), undefined);
  });

  it("follows a gateway moved to another zone", () => {
    const engine = new PresenceEngine({ ...DEFAULT_PRESENCE, dwellMs: 0 });
    engine.seed("tag", DOCK_A, 0);
    engine.observe("tag", GW_A, DOCK_A, -60, 1000);
    const c = engine.observe("tag", GW_A, AISLE_3, -60, 2000);
    assert.equal(c?.to, AISLE_3);
  });

  it("reports what each gateway hears, strongest first", () => {
    const engine = new PresenceEngine();
    engine.observe("tag", GW_A, DOCK_A, -60, 1000);
    engine.observe("tag", GW_A, DOCK_A, -64, 2000);
    engine.observe("tag", GW_A, DOCK_A, -62, 3000);
    engine.observe("tag", GW_3, AISLE_3, -80, 3500);
    const snap = engine.snapshot("tag", 4000)!;
    assert.deepEqual(
      snap.heard.map((h) => [h.gatewayId, h.rssi, h.samples]),
      [
        [GW_A, -62, 3],
        [GW_3, -80, 1],
      ],
    );
    assert.equal(snap.zoneId, null);
    assert.equal(snap.candidate?.zoneId, DOCK_A);
  });

  it("forgets idle tags and keeps a seeded zone until it is heard", () => {
    const engine = new PresenceEngine();
    engine.seed("a", DOCK_A, 0);
    engine.observe("b", GW_A, DOCK_A, -60, 1_000_000);
    assert.equal(engine.forgetIdle(1_000_000, 60_000), 1);
    assert.equal(engine.has("a"), false);
    assert.equal(engine.has("b"), true);
    // Seeding never overwrites what the engine already knows.
    engine.seed("b", AISLE_3, 0);
    assert.equal(engine.zoneOf("b"), null);
  });

  it("computes medians", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([-60]), -60);
  });
});
