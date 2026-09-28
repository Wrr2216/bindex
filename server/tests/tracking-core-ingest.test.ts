import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * recordSightings against a real Postgres. Skipped unless
 * TRACKING_TEST_DATABASE_URL points at a database this test may write to, for
 * example:
 *
 *   createdb bindex_tracking_test
 *   TRACKING_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_tracking_test pnpm test
 *
 * Migrations are applied first. Every record it creates has a random suffix,
 * so it can run repeatedly against the same database.
 */
const url = process.env.TRACKING_TEST_DATABASE_URL;
process.env.DATABASE_URL = url ?? process.env.DATABASE_URL ?? "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.LOG_LEVEL ??= "warn";

type Client = typeof import("../src/db/client");
type Tracking = typeof import("../src/services/tracking");
type Ingest = typeof import("../src/services/tracking/ingest");

let client: Client;
let tracking: Tracking;
let ingest: Ingest;

const tag = () => randomBytes(12).toString("hex").toUpperCase();
const run = randomBytes(3).toString("hex");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.pool.query(sql, params)).rows as T[];
}

async function location(name: string, parentId: string | null = null): Promise<string> {
  const [row] = await q<{ id: string }>("INSERT INTO locations (name, parent_id) VALUES ($1, $2) RETURNING id", [
    `${name} ${run}`,
    parentId,
  ]);
  return row!.id;
}

async function item(name: string, opts: { locationId?: string | null; rfid?: string } = {}): Promise<string> {
  const [row] = await q<{ id: string }>("INSERT INTO items (name, location_id) VALUES ($1, $2) RETURNING id", [
    `${name} ${run}`,
    opts.locationId ?? null,
  ]);
  if (opts.rfid) {
    await q("INSERT INTO item_identifiers (item_id, type, value) VALUES ($1, 'rfid', $2)", [row!.id, opts.rfid]);
  }
  return row!.id;
}

async function device(input: Parameters<Tracking["createDevice"]>[0]) {
  const { device: view } = await tracking.createDevice({ ...input, name: `${input.name} ${run}` });
  return tracking.getDeviceRow(view.id);
}

const itemLocation = async (id: string) =>
  (await q<{ location_id: string | null }>("SELECT location_id FROM items WHERE id = $1", [id]))[0]!.location_id;
const movedEvents = async (id: string) =>
  q<{ detail: Record<string, unknown> }>(
    "SELECT detail FROM item_events WHERE item_id = $1 AND action = 'moved' ORDER BY created_at",
    [id],
  );
const positionOf = async (id: string) => (await tracking.getItemPositions(id))[0];

describe("recordSightings", { skip: url ? false : "set TRACKING_TEST_DATABASE_URL to run" }, () => {
  let yard: string;
  let warehouse: string;
  let aisle: string;
  const t0 = new Date("2026-03-01T10:00:00Z");
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

  before(async () => {
    client = await import("../src/db/client");
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    tracking = await import("../src/services/tracking");
    ingest = await import("../src/services/tracking/ingest");
    yard = await location("Yard");
    warehouse = await location("Warehouse");
    aisle = await location("Aisle 3", warehouse);
  });

  after(async () => {
    await client?.pool.end();
  });

  beforeEach(() => ingest.resetIngestState());

  it("stores a bridge's reads without moving anything", async () => {
    const epc = tag();
    const id = await item("Drill", { rfid: epc, locationId: aisle });
    const bridge = await device({ kind: "rfid_reader", name: "Bridge", externalId: `pico-${run}` });

    const result = await tracking.recordSightings(bridge, [{ code: epc.toLowerCase() }, { code: tag() }], {
      now: at(0),
    });
    assert.deepEqual(
      { accepted: result.accepted, matched: result.matched, unknown: result.unknown, recorded: result.recorded, moved: result.moved },
      { accepted: 2, matched: 1, unknown: 1, recorded: 2, moved: 0 },
    );
    const page = await tracking.listItemSightings(id);
    assert.equal(page.sightings.length, 1);
    assert.equal(page.sightings[0]!.code, epc);
    assert.equal(page.sightings[0]!.deviceName, `Bridge ${run}`);
    // Seen, but a handheld without a zone says nothing about where.
    const pos = await positionOf(id);
    assert.equal(pos?.locationId, null);
    assert.equal(await itemLocation(id), aisle);
    assert.equal((await movedEvents(id)).length, 0);
    // No "scanned" history from hardware reads.
    const scanned = await q("SELECT 1 FROM item_events WHERE item_id = $1 AND action = 'scanned'", [id]);
    assert.equal(scanned.length, 0);
  });

  it("moves an item once per zone change with updates_location, not once per read", async () => {
    const epc = tag();
    const id = await item("Pallet", { rfid: epc, locationId: yard });
    const reader = await device({
      kind: "rfid_reader",
      name: "Aisle reader",
      externalId: `aisle-${run}`,
      locationId: aisle,
      updatesLocation: true,
    });

    const first = await tracking.recordSightings(reader, [{ code: epc, observedAt: at(0) }], { now: at(0) });
    assert.equal(first.moved, 1);
    // Many more reads over the next minute, some inside the duplicate window.
    for (let s = 1; s <= 60; s += 1) {
      await tracking.recordSightings(reader, [{ code: epc, observedAt: at(s) }, { code: epc, observedAt: at(s + 0.5) }], {
        now: at(s + 1),
      });
    }
    const events = await movedEvents(id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.detail.source, "tracking");
    assert.equal(events[0]!.detail.from, yard);
    assert.equal(events[0]!.detail.to, aisle);
    assert.equal(events[0]!.detail.deviceId, reader.id);
    assert.equal(events[0]!.detail.applied, true);
    assert.equal(await itemLocation(id), aisle);
    // One stored sighting per duplicate window, not one per read.
    const count = (await q<{ n: number }>("SELECT count(*)::int AS n FROM sightings WHERE item_id = $1", [id]))[0]!.n;
    assert.ok(count >= 12 && count <= 14, `expected about 13 sightings, got ${count}`);

    const pos = await positionOf(id);
    assert.equal(pos?.locationId, aisle);
    assert.equal(pos?.previousLocationId, yard);
    assert.equal(pos?.enteredAt, at(0).toISOString());

    // It shows up as present in the aisle and in the warehouse that contains it.
    const inWarehouse = await tracking.listPresent(warehouse);
    assert.ok(inWarehouse.some((p) => p.itemId === id));
    assert.ok(!(await tracking.listPresent(yard)).some((p) => p.itemId === id));
  });

  it("records the zone change but leaves the recorded location alone without updates_location", async () => {
    const epc = tag();
    const id = await item("Laptop", { rfid: epc, locationId: yard });
    const reader = await device({ kind: "rfid_reader", name: "Watcher", locationId: warehouse });
    const result = await tracking.recordSightings(reader, [{ code: epc }], { now: at(0) });
    assert.equal(result.moved, 1);
    assert.equal(await itemLocation(id), yard);
    const events = await movedEvents(id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.detail.applied, false);
    const pos = await positionOf(id);
    assert.equal(pos?.locationId, warehouse);
    assert.equal(pos?.recordedLocationId, yard);
  });

  it("does not count a first read in the zone already on file as a move", async () => {
    const epc = tag();
    const id = await item("Shelf box", { rfid: epc, locationId: aisle });
    const reader = await device({ kind: "rfid_reader", name: "Aisle 2", locationId: aisle, updatesLocation: true });
    const result = await tracking.recordSightings(reader, [{ code: epc }], { now: at(0) });
    assert.equal(result.moved, 0);
    assert.equal((await positionOf(id))?.locationId, aisle);
  });

  it("never rewinds a position with a late batch", async () => {
    const epc = tag();
    const id = await item("Crate", { rfid: epc });
    const a = await device({ kind: "rfid_reader", name: "A", locationId: yard, updatesLocation: true });
    const b = await device({ kind: "rfid_reader", name: "B", locationId: aisle, updatesLocation: true });
    await tracking.recordSightings(b, [{ code: epc, observedAt: at(100) }], { now: at(100) });
    // An older read arrives afterwards: stored as history, but the position stays.
    const late = await tracking.recordSightings(a, [{ code: epc, observedAt: at(50) }], { now: at(101) });
    assert.equal(late.recorded, 1);
    assert.equal(late.moved, 0);
    assert.equal((await positionOf(id))?.locationId, aisle);
    assert.equal(await itemLocation(id), aisle);
  });

  it("works out portal direction across batches and moves pallets in and out", async () => {
    const inbound = tag();
    const outbound = tag();
    const inId = await item("Inbound pallet", { rfid: inbound, locationId: yard });
    const outId = await item("Outbound pallet", { rfid: outbound, locationId: warehouse });
    const portal = await device({
      kind: "rfid_portal",
      name: "Dock door 1",
      locationId: warehouse,
      updatesLocation: true,
      settings: {
        portal: { sides: { "1": "outside", "2": "outside", "3": "inside", "4": "inside" }, outLocationId: yard },
      },
    });
    await tracking.recordSightings(
      portal,
      [
        { code: inbound, antenna: 1, observedAt: at(0) },
        { code: outbound, antenna: 4, observedAt: at(0.1) },
        { code: inbound, antenna: 2, observedAt: at(0.4) },
      ],
      { now: at(0.5) },
    );
    // Halfway through, nothing has moved.
    assert.equal(await itemLocation(inId), yard);
    await tracking.recordSightings(
      portal,
      [
        { code: inbound, antenna: 3, observedAt: at(1.2) },
        { code: outbound, antenna: 1, observedAt: at(1.3) },
        { code: inbound, antenna: 4, observedAt: at(1.5) },
      ],
      { now: at(1.6) },
    );
    assert.equal(await itemLocation(inId), warehouse);
    assert.equal(await itemLocation(outId), yard);
    const inEvents = await movedEvents(inId);
    assert.equal(inEvents.length, 1);
    assert.equal(inEvents[0]!.detail.direction, "in");
    const outEvents = await movedEvents(outId);
    assert.equal(outEvents.length, 1);
    assert.equal(outEvents[0]!.detail.direction, "out");
    const dirs = await q<{ direction: string | null }>(
      "SELECT direction FROM sightings WHERE item_id = $1 ORDER BY observed_at",
      [inId],
    );
    assert.deepEqual(
      dirs.map((d) => d.direction),
      [null, "in"],
    );
  });

  it("drops reads below the RSSI floor", async () => {
    const epc = tag();
    await item("Faint", { rfid: epc });
    const reader = await device({ kind: "rfid_reader", name: "Picky", settings: { rssiFloor: -65 } });
    const result = await tracking.recordSightings(
      reader,
      [
        { code: epc, rssi: -80 },
        { code: epc, rssi: -60 },
      ],
      { now: at(0) },
    );
    assert.equal(result.ignored, 1);
    assert.equal(result.accepted, 1);
  });

  it("resolves unit serials and printed codes, and moves the unit", async () => {
    const id = await item("Radio");
    const serial = `sn-${run}-${tag().slice(0, 6)}`;
    const [unit] = await q<{ id: string; asset_code: string }>(
      "INSERT INTO item_units (item_id, serial) VALUES ($1, $2) RETURNING id, asset_code",
      [id, serial],
    );
    const resolved = await tracking.resolveCodes([serial, unit!.asset_code]);
    assert.deepEqual(resolved.get(serial), { itemId: id, unitId: unit!.id, via: "unit_serial" });
    assert.equal(resolved.get(unit!.asset_code)?.via, "unit_code");

    const reader = await device({ kind: "rfid_reader", name: "Unit reader", locationId: aisle, updatesLocation: true });
    await tracking.recordSightings(reader, [{ code: serial }], { now: at(0) });
    const [row] = await q<{ location_id: string }>("SELECT location_id FROM item_units WHERE id = $1", [unit!.id]);
    assert.equal(row!.location_id, aisle);
    const positions = await tracking.getItemPositions(id);
    assert.equal(positions[0]?.unitId, unit!.id);
  });

  it("matches a tag stored in another format, and skips an ambiguous product code", async () => {
    const epc = tag();
    const spaced = epc.toLowerCase().match(/.{1,4}/g)!.join(" ");
    const id = await item("Spaced", { rfid: spaced });
    assert.equal((await tracking.resolveCode(epc))?.itemId, id);

    const upc = `0${Date.now()}`.slice(0, 12);
    const a = await item("Twin A");
    const b = await item("Twin B");
    await q("INSERT INTO item_identifiers (item_id, type, value) VALUES ($1, 'upc', $3), ($2, 'upc', $3)", [a, b, upc]);
    assert.equal(await tracking.resolveCode(upc), null);
  });

  it("follows a tracker attached to an asset from code-less GPS points", async () => {
    const id = await item("Trailer");
    const tracker = await device({ kind: "gps_tracker", name: "Trailer GPS", externalId: `imei-${run}`, itemId: id });
    const result = await tracking.recordSightings(
      tracker,
      [
        { lat: 51.5, lng: -0.12, observedAt: at(0), speedMps: 12 },
        { lat: 51.51, lng: -0.13, observedAt: at(30), speedMps: 11 },
      ],
      { now: at(31), batteryPct: 64 },
    );
    assert.equal(result.matched, 2);
    const pos = await positionOf(id);
    assert.equal(pos?.lat, 51.51);
    assert.equal(pos?.lng, -0.13);
    assert.equal(pos?.tech, "gps");
    const dev = await tracking.getDevice(tracker.id);
    assert.equal(dev.batteryPct, 64);
    assert.equal(dev.lastLat, 51.51);
  });

  it("ignores reads from a disabled device", async () => {
    const reader = await device({ kind: "rfid_reader", name: "Off", disabled: true });
    const result = await tracking.recordSightings(reader, [{ code: tag() }], { now: at(0) });
    assert.equal(result.recorded, 0);
    assert.equal(result.ignored, 1);
  });

  it("takes 10,000 reads in one batch in well under a few seconds", async () => {
    const reader = await device({ kind: "rfid_reader", name: "Bulk", locationId: aisle, updatesLocation: true });
    const known = Array.from({ length: 500 }, () => tag());
    for (let i = 0; i < known.length; i += 100) {
      const slice = known.slice(i, i + 100);
      const ids = await q<{ id: string }>(
        `INSERT INTO items (name) SELECT 'Bulk ' || g FROM generate_series(1, ${slice.length}) g RETURNING id`,
      );
      await q(
        "INSERT INTO item_identifiers (item_id, type, value) SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])",
        [ids.map((r) => r.id), slice.map(() => "rfid"), slice],
      );
    }
    const reads = Array.from({ length: 10_000 }, (_, i) => ({
      code: i < 5_000 ? known[i % known.length]! : tag(),
      rssi: -40 - (i % 30),
      antenna: 1 + (i % 4),
      observedAt: at(i / 1000),
    }));
    const started = performance.now();
    const result = await tracking.recordSightings(reader, reads, { now: at(11) });
    const ms = performance.now() - started;
    assert.equal(result.accepted, 10_000);
    assert.equal(result.matched, 5_000);
    assert.equal(result.moved, 500);
    assert.ok(ms < 3_000, `took ${Math.round(ms)} ms`);
    console.log(`10,000 reads: ${Math.round(ms)} ms, ${result.recorded} stored, ${result.suppressed} suppressed`);
  });
});
