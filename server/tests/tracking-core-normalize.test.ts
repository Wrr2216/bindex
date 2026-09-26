import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  base64ToHex,
  clampObservedAt,
  finiteOrNull,
  normalizeCode,
  parseTimestamp,
} from "../src/services/tracking/normalize";
import { DuplicateFilter } from "../src/services/tracking/dedup";
import { zoneFor } from "../src/services/tracking/zones";
import { readSettings } from "../src/services/tracking/types";

describe("normalizeCode", () => {
  it("uppercases hex EPCs and strips spaces and colons", () => {
    assert.equal(normalizeCode("e2801160 6000020a"), "E28011606000020A");
    assert.equal(normalizeCode("E2:80:11:60"), "E2801160");
    assert.equal(normalizeCode("  e28011\t"), "E28011");
  });

  it("leaves anything that is not hex alone apart from trimming", () => {
    assert.equal(normalizeCode(" INV-4F2K1B "), "INV-4F2K1B");
    assert.equal(normalizeCode("mac:AA:BB:CC"), "mac:AA:BB:CC");
    assert.equal(normalizeCode("ibeacon:f7826da6-4fa2-4e98:1:2"), "ibeacon:f7826da6-4fa2-4e98:1:2");
    assert.equal(normalizeCode("Serial xyz"), "Serial xyz");
  });
});

describe("parseTimestamp", () => {
  const at = new Date("2023-05-09T15:04:12.310Z");
  it("reads ISO with and without a colon in the offset", () => {
    assert.deepEqual(parseTimestamp("2023-05-09T15:04:12.310Z"), at);
    assert.deepEqual(parseTimestamp("2023-05-09T15:04:12.310+0000"), at);
    assert.deepEqual(parseTimestamp("2023-05-09T17:04:12.310+0200"), at);
  });

  it("reads epoch seconds, milliseconds and microseconds, as numbers or text", () => {
    assert.deepEqual(parseTimestamp(1683644652.31), at);
    assert.deepEqual(parseTimestamp(1683644652310), at);
    assert.deepEqual(parseTimestamp(1683644652310000), at);
    assert.deepEqual(parseTimestamp("1683644652310000"), at);
  });

  it("returns null for anything unreadable", () => {
    assert.equal(parseTimestamp("yesterday"), null);
    assert.equal(parseTimestamp(""), null);
    assert.equal(parseTimestamp(-5), null);
    assert.equal(parseTimestamp({}), null);
  });
});

describe("clampObservedAt", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("replaces a time far in the future with now, and keeps the past", () => {
    assert.deepEqual(clampObservedAt(new Date("2026-01-01T01:00:00Z"), now), now);
    assert.deepEqual(clampObservedAt(new Date("2026-01-01T00:00:30Z"), now), new Date("2026-01-01T00:00:30Z"));
    assert.deepEqual(clampObservedAt(new Date("2025-12-01T00:00:00Z"), now), new Date("2025-12-01T00:00:00Z"));
    assert.deepEqual(clampObservedAt(null, now), now);
  });
});

describe("small parsers", () => {
  it("finiteOrNull takes numbers and numeric text only", () => {
    assert.equal(finiteOrNull(-61), -61);
    assert.equal(finiteOrNull("-61.5"), -61.5);
    assert.equal(finiteOrNull(""), null);
    assert.equal(finiteOrNull("abc"), null);
    assert.equal(finiteOrNull(Number.NaN), null);
  });

  it("base64ToHex decodes Impinj's epc field", () => {
    assert.equal(base64ToHex("4oARYGAAAgobLD1O"), "E28011606000020A1B2C3D4E");
    assert.equal(base64ToHex("not base64!"), null);
  });
});

describe("DuplicateFilter", () => {
  it("stores the first read and then one per window", () => {
    const f = new DuplicateFilter();
    assert.equal(f.admit("dev|E280", 0, "", 5_000), true);
    assert.equal(f.admit("dev|E280", 1_000, "", 5_000), false);
    assert.equal(f.admit("dev|E280", 4_999, "", 5_000), false);
    assert.equal(f.admit("dev|E280", 5_000, "", 5_000), true);
    assert.equal(f.admit("dev|E280", 9_000, "", 5_000), false);
  });

  it("always stores a change of zone or direction", () => {
    const f = new DuplicateFilter();
    assert.equal(f.admit("k", 0, "|", 5_000), true);
    assert.equal(f.admit("k", 100, "in|zone-a", 5_000), true);
    assert.equal(f.admit("k", 200, "in|zone-a", 5_000), false);
  });

  it("keeps devices and codes apart", () => {
    const f = new DuplicateFilter();
    assert.equal(f.admit("a|X", 0, "", 5_000), true);
    assert.equal(f.admit("b|X", 0, "", 5_000), true);
    assert.equal(f.admit("a|Y", 0, "", 5_000), true);
  });

  it("stores an old read from outside the window without moving the reference back", () => {
    const f = new DuplicateFilter();
    f.admit("k", 100_000, "", 5_000);
    assert.equal(f.admit("k", 10_000, "", 5_000), true);
    assert.equal(f.admit("k", 102_000, "", 5_000), false);
  });

  it("stores everything with a zero window, and forgets a released read", () => {
    const f = new DuplicateFilter();
    assert.equal(f.admit("k", 0, "", 0), true);
    assert.equal(f.admit("k", 0, "", 0), true);
    f.admit("j", 0, "", 5_000);
    f.release("j", 0);
    assert.equal(f.admit("j", 1, "", 5_000), true);
  });

  it("stays within its size bound", () => {
    const f = new DuplicateFilter(2);
    f.admit("a", 0, "", 5_000);
    f.admit("b", 0, "", 5_000);
    f.admit("c", 0, "", 5_000);
    // "a" was evicted, so it is stored again.
    assert.equal(f.admit("a", 1, "", 5_000), true);
  });
});

describe("zoneFor", () => {
  const ZONE = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const reader = { kind: "rfid_reader" as const, locationId: ZONE };

  it("puts a zone reader's reads in its zone", () => {
    assert.deepEqual(zoneFor(reader, {}, {}), { locationId: ZONE, fix: true });
  });

  it("lets an antenna cover a different zone", () => {
    assert.deepEqual(zoneFor(reader, { antennaZones: { "2": OTHER } }, { antenna: 2 }), { locationId: OTHER, fix: true });
    assert.deepEqual(zoneFor(reader, { antennaZones: { "2": OTHER } }, { antenna: 1 }), { locationId: ZONE, fix: true });
  });

  it("gives a handheld without a zone no fix", () => {
    assert.deepEqual(zoneFor({ kind: "rfid_reader", locationId: null }, {}, {}), { locationId: null, fix: false });
  });

  it("treats a GPS point outside every zone as a fix with no zone", () => {
    assert.deepEqual(zoneFor({ kind: "gps_tracker", locationId: null }, {}, { lat: 1, lng: 2 }), {
      locationId: null,
      fix: true,
    });
  });

  it("trusts a zone the caller already decided, including none", () => {
    assert.deepEqual(zoneFor(reader, {}, { locationId: OTHER }), { locationId: OTHER, fix: true });
    assert.deepEqual(zoneFor(reader, {}, { locationId: null }), { locationId: null, fix: true });
  });

  it("only gives a portal read a zone once the direction is known", () => {
    const portal = { kind: "rfid_portal" as const, locationId: ZONE };
    const settings = { portal: { sides: {}, outLocationId: OTHER } };
    assert.deepEqual(zoneFor(portal, settings, { direction: null }), { locationId: null, fix: false });
    assert.deepEqual(zoneFor(portal, settings, { direction: "in" }), { locationId: ZONE, fix: true });
    assert.deepEqual(zoneFor(portal, settings, { direction: "out" }), { locationId: OTHER, fix: true });
    assert.deepEqual(zoneFor(portal, {}, { direction: "out" }), { locationId: null, fix: true });
  });
});

describe("readSettings", () => {
  it("keeps what it understands, drops what is malformed, and passes other keys through", () => {
    const s = readSettings({
      rssiFloor: -70,
      dedupSeconds: "5",
      antennaZones: { "1": "zone", "2": 3 },
      portal: { sides: { "1": "outside", "2": "sideways" }, windowSeconds: 2 },
      bleUuid: "f7826da6",
    });
    assert.equal(s.rssiFloor, -70);
    assert.equal(s.dedupSeconds, null);
    assert.deepEqual(s.antennaZones, { "1": "zone" });
    assert.deepEqual(s.portal, { sides: { "1": "outside" }, windowSeconds: 2, inLocationId: null, outLocationId: null });
    assert.equal(s.bleUuid, "f7826da6");
    assert.deepEqual(readSettings(null).antennaZones, {});
  });
});
