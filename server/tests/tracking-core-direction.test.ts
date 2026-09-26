import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  directionBetween,
  inferDirection,
  PortalTracker,
  sideOf,
  splitPasses,
  type AntennaSides,
  type PortalRead,
} from "../src/services/tracking/direction";
import { zoneFor } from "../src/services/tracking/zones";
import { parseZebra } from "../src/services/tracking/adapters";

// A dock door with two antennas facing the yard and two facing the warehouse.
const DOCK: AntennaSides = { "1": "outside", "2": "outside", "3": "inside", "4": "inside" };

const seq = (antennas: number[], start = 0, stepMs = 100): PortalRead[] =>
  antennas.map((antenna, i) => ({ antenna, at: start + i * stepMs }));

describe("sideOf and directionBetween", () => {
  it("maps antennas to sides and ignores unmapped ports", () => {
    assert.equal(sideOf(1, DOCK), "outside");
    assert.equal(sideOf(4, DOCK), "inside");
    assert.equal(sideOf(7, DOCK), null);
    assert.equal(sideOf(null, DOCK), null);
    assert.equal(sideOf(undefined, DOCK), null);
  });

  it("reads outside-to-inside as in, the reverse as out, and a same-side pass as nothing", () => {
    assert.equal(directionBetween("outside", "inside"), "in");
    assert.equal(directionBetween("inside", "outside"), "out");
    assert.equal(directionBetween("inside", "inside"), null);
    assert.equal(directionBetween("outside", "outside"), null);
  });
});

describe("inferDirection", () => {
  it("sees a pallet carried in", () => {
    assert.equal(inferDirection(seq([1, 1, 2, 3, 4, 4]), DOCK), "in");
  });

  it("sees a pallet carried out", () => {
    assert.equal(inferDirection(seq([4, 3, 3, 2, 1]), DOCK), "out");
  });

  it("gives no direction for a tag that approached and turned back", () => {
    assert.equal(inferDirection(seq([1, 2, 3, 2, 1]), DOCK), null);
  });

  it("gives no direction for a tag parked on one side", () => {
    assert.equal(inferDirection(seq([3, 4, 3, 4, 3]), DOCK), null);
  });

  it("uses only the latest pass", () => {
    // In, then five seconds later a separate approach from outside that turns back.
    const reads = [...seq([1, 2, 3, 4]), ...seq([1, 2, 1], 10_000)];
    assert.equal(inferDirection(reads, DOCK, 3_000), null);
    const passes = splitPasses(reads, DOCK, 3_000);
    assert.equal(passes.length, 2);
    assert.equal(passes[0]!.direction, "in");
    assert.equal(passes[1]!.direction, null);
  });

  it("treats a gap exactly at the window as the same pass, and beyond it as a new one", () => {
    const sameAt = [
      { antenna: 1, at: 0 },
      { antenna: 3, at: 3_000 },
    ];
    assert.equal(inferDirection(sameAt, DOCK, 3_000), "in");
    const split = [
      { antenna: 1, at: 0 },
      { antenna: 3, at: 3_001 },
    ];
    assert.equal(inferDirection(split, DOCK, 3_000), null);
  });

  it("ignores reads from antennas without a side", () => {
    assert.equal(inferDirection(seq([9, 1, 9, 3, 9]), DOCK), "in");
    assert.equal(inferDirection(seq([9, 9]), DOCK), null);
  });

  it("ends a pass when a read from an unmapped antenna comes after the window", () => {
    assert.equal(inferDirection([...seq([1, 3]), { antenna: 9, at: 2_000 }], DOCK, 3_000), "in");
    assert.equal(inferDirection([...seq([1, 3]), { antenna: 9, at: 10_000 }], DOCK, 3_000), null);
  });

  it("does not depend on the order reads arrive in", () => {
    const reads = seq([4, 3, 2, 1]);
    assert.equal(inferDirection([...reads].reverse(), DOCK), "out");
  });

  it("breaks a tie between antennas at the same instant by signal strength", () => {
    // Both sides hear the tag at t=0; the inside antenna is far stronger, so
    // the tag started inside. It ends outside: out.
    const reads: PortalRead[] = [
      { antenna: 1, at: 0, rssi: -70 },
      { antenna: 4, at: 0, rssi: -40 },
      { antenna: 2, at: 500, rssi: -45 },
    ];
    assert.equal(inferDirection(reads, DOCK), "out");
    // Same at the end: the strongest of the final reads decides the last side.
    const end: PortalRead[] = [
      { antenna: 1, at: 0, rssi: -45 },
      { antenna: 2, at: 500, rssi: -72 },
      { antenna: 3, at: 500, rssi: -41 },
    ];
    assert.equal(inferDirection(end, DOCK), "in");
  });

  it("returns null with nothing to go on", () => {
    assert.equal(inferDirection([], DOCK), null);
    assert.equal(inferDirection(seq([1, 3]), {}), null);
  });
});

describe("PortalTracker", () => {
  it("works out direction as batches arrive", () => {
    const t = new PortalTracker();
    const key = "dock-1|E280";
    assert.equal(t.observe(key, { antenna: 1, at: 0 }, DOCK), null);
    assert.equal(t.observe(key, { antenna: 2, at: 200 }, DOCK), null);
    // Next HTTP batch.
    assert.equal(t.observe(key, { antenna: 3, at: 600 }, DOCK), "in");
    assert.equal(t.observe(key, { antenna: 4, at: 900 }, DOCK), "in");
  });

  it("starts a new pass after the window and keeps tags apart", () => {
    const t = new PortalTracker();
    t.observe("a", { antenna: 1, at: 0 }, DOCK);
    assert.equal(t.observe("a", { antenna: 3, at: 100 }, DOCK), "in");
    assert.equal(t.observe("b", { antenna: 3, at: 100 }, DOCK), null);
    // Ten seconds later tag a is back on the inside only: a new pass with no direction yet.
    assert.equal(t.observe("a", { antenna: 4, at: 10_100 }, DOCK, 3_000), null);
    assert.equal(t.observe("a", { antenna: 1, at: 10_400 }, DOCK, 3_000), "out");
  });

  it("reports the current pass for a read from an unmapped antenna", () => {
    const t = new PortalTracker();
    t.observe("a", { antenna: 1, at: 0 }, DOCK);
    t.observe("a", { antenna: 3, at: 100 }, DOCK);
    assert.equal(t.observe("a", { antenna: 9, at: 200 }, DOCK), "in");
    assert.equal(t.observe("z", { antenna: 9, at: 200 }, DOCK), null);
  });

  it("agrees with inferDirection on every prefix of random read sequences", () => {
    // A small deterministic generator so a failure reproduces.
    let s = 42;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 300; run++) {
      const t = new PortalTracker();
      const reads: PortalRead[] = [];
      let at = 0;
      const n = 1 + Math.floor(rand() * 25);
      for (let i = 0; i < n; i++) {
        // Some reads share a timestamp, some come after a long gap.
        const r = rand();
        at += r < 0.2 ? 0 : r < 0.9 ? Math.floor(rand() * 800) : 4_000;
        const read: PortalRead = {
          antenna: 1 + Math.floor(rand() * 5),
          at,
          rssi: rand() < 0.1 ? null : -30 - Math.floor(rand() * 5) * 10,
        };
        reads.push(read);
        const incremental = t.observe("tag", read, DOCK, 3_000);
        assert.equal(incremental, inferDirection(reads, DOCK, 3_000), `run ${run}, read ${i}`);
      }
    }
  });

  it("forgets passes that have ended and stays within its size bound", () => {
    const t = new PortalTracker(3);
    for (let i = 0; i < 5; i++) t.observe(`tag-${i}`, { antenna: 1, at: i }, DOCK);
    assert.equal(t.size, 3);
    t.sweep(100_000, 3_000);
    assert.equal(t.size, 0);
  });
});

describe("a two-zone dock portal end to end", () => {
  const YARD = "11111111-1111-4111-8111-111111111111";
  const WAREHOUSE = "22222222-2222-4222-8222-222222222222";
  const device = { kind: "rfid_portal" as const, locationId: WAREHOUSE };
  const settings = { portal: { sides: DOCK, outLocationId: YARD } };

  // Two Zebra batches, as the IoT Connector posts them a second apart: pallet
  // A is carried in, pallet B is carried out, and C wanders near the door.
  const batch1 = [
    { data: { idHex: "e2801160600002000000000a", antenna: 1, peakRssi: -60 }, timestamp: "2023-05-09T15:04:12.000+0000", type: "SIMPLE" },
    { data: { idHex: "e2801160600002000000000b", antenna: 4, peakRssi: -52 }, timestamp: "2023-05-09T15:04:12.050+0000", type: "SIMPLE" },
    { data: { idHex: "e2801160600002000000000a", antenna: 2, peakRssi: -55 }, timestamp: "2023-05-09T15:04:12.400+0000", type: "SIMPLE" },
    { data: { idHex: "e2801160600002000000000c", antenna: 2, peakRssi: -66 }, timestamp: "2023-05-09T15:04:12.500+0000", type: "SIMPLE" },
    { data: { idHex: "e2801160600002000000000b", antenna: 3, peakRssi: -50 }, timestamp: "2023-05-09T15:04:12.600+0000", type: "SIMPLE" },
  ];
  const batch2 = [
    { data: { idHex: "e2801160600002000000000a", antenna: 3, peakRssi: -49 }, timestamp: "2023-05-09T15:04:13.100+0000", type: "SIMPLE" },
    { data: { idHex: "e2801160600002000000000b", antenna: 1, peakRssi: -58 }, timestamp: "2023-05-09T15:04:13.200+0000", type: "SIMPLE" },
    { data: { idHex: "e2801160600002000000000c", antenna: 1, peakRssi: -61 }, timestamp: "2023-05-09T15:04:13.300+0000", type: "SIMPLE" },
    { data: { idHex: "e2801160600002000000000a", antenna: 4, peakRssi: -47 }, timestamp: "2023-05-09T15:04:13.400+0000", type: "SIMPLE" },
    { type: "heartbeat", timestamp: "2023-05-09T15:04:13.500+0000", data: { hostname: "FX9600F0A1B2" } },
  ];

  it("puts A in the warehouse, B in the yard, and C nowhere new", () => {
    const tracker = new PortalTracker();
    const last = new Map<string, { direction: string | null; zone: string | null; fix: boolean }>();
    for (const batch of [batch1, batch2]) {
      const { reads } = parseZebra(batch);
      reads.sort((a, b) => a.observedAt!.getTime() - b.observedAt!.getTime());
      for (const r of reads) {
        const direction = tracker.observe(
          r.code!,
          { antenna: r.antenna, at: r.observedAt!.getTime(), rssi: r.rssi },
          DOCK,
        );
        const zone = zoneFor(device, settings, { direction, antenna: r.antenna });
        last.set(r.code!, { direction, zone: zone.locationId, fix: zone.fix });
      }
    }
    assert.deepEqual(last.get("e2801160600002000000000a"), { direction: "in", zone: WAREHOUSE, fix: true });
    assert.deepEqual(last.get("e2801160600002000000000b"), { direction: "out", zone: YARD, fix: true });
    assert.deepEqual(last.get("e2801160600002000000000c"), { direction: null, zone: null, fix: false });
  });
});
