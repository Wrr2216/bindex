import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * BLE presence against a real Postgres: gateway reports through the presence
 * engine into the tracking core's sightings, positions and moves, then the
 * missing, battery and phone paths. Skipped unless TEST_DATABASE_URL points at
 * a database this test may write to, for example:
 *
 *   createdb bindex_ble_test
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_ble_test pnpm test
 *
 * Migrations are applied first. Every record has a random suffix, so the test
 * can run repeatedly against the same database.
 */
const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url ?? process.env.DATABASE_URL ?? "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.LOG_LEVEL ??= "warn";
// Weekdays only, in UTC, so the Saturday below is out of hours.
process.env.BLE_WORK_HOURS = "Mon-Fri 07:00-19:00";
process.env.BLE_TIMEZONE = "UTC";
process.env.BLE_MISSING_MINUTES = "10";
process.env.BLE_STORE_SECONDS = "60";

type Client = typeof import("../src/db/client");
type Ingest = typeof import("../src/services/ble/ingest");
type Devices = typeof import("../src/services/ble/devices");
type Alerts = typeof import("../src/services/ble/alerts");
type Phones = typeof import("../src/services/ble/phones");
type Queries = typeof import("../src/services/ble/queries");

let client: Client;
let ingest: Ingest;
let devices: Devices;
let alerts: Alerts;
let phones: Phones;
let queries: Queries;

const run = randomBytes(3).toString("hex");
const hex = (n: number) => randomBytes(n).toString("hex").toUpperCase();

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.pool.query(sql, params)).rows as T[];
}

async function location(name: string): Promise<string> {
  const [row] = await q<{ id: string }>("INSERT INTO locations (name) VALUES ($1) RETURNING id", [`${name} ${run}`]);
  return row!.id;
}

async function item(name: string, locationId: string | null): Promise<string> {
  const [row] = await q<{ id: string }>("INSERT INTO items (name, location_id) VALUES ($1, $2) RETURNING id", [
    `${name} ${run}`,
    locationId,
  ]);
  return row!.id;
}

async function device(input: Parameters<Devices["createBleDevice"]>[0]) {
  const { device: view, token } = await devices.createBleDevice({ ...input, name: `${input.name} ${run}` });
  const [row] = await q("SELECT * FROM tracking_devices WHERE id = $1", [view.id]);
  const { getDeviceRow } = await import("../src/services/tracking");
  return { row: await getDeviceRow(view.id), token, raw: row };
}

const iBeaconData = (uuid: string, major: number, minor: number) =>
  `0201061AFF4C000215${uuid}${major.toString(16).padStart(4, "0")}${minor.toString(16).padStart(4, "0")}C5`.toUpperCase();

/** mulberry32, for repeatable noise. */
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

describe("BLE presence with Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let dockA: string;
  let aisle3: string;
  // Saturday 7 March 2026, 10:00 UTC: outside the Mon-Fri working hours above.
  const t0 = new Date("2026-03-07T10:00:00Z").getTime();

  before(async () => {
    client = await import("../src/db/client");
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    ingest = await import("../src/services/ble/ingest");
    devices = await import("../src/services/ble/devices");
    alerts = await import("../src/services/ble/alerts");
    phones = await import("../src/services/ble/phones");
    queries = await import("../src/services/ble/queries");
    dockA = await location("Dock A");
    aisle3 = await location("Aisle 3");
  });

  beforeEach(() => ingest.resetBleState());

  after(async () => {
    await client.pool.end();
  });

  it("moves a tagged item from Dock A to Aisle 3 once, then marks it missing and found", async () => {
    const uuid = hex(16);
    const pallet = await item("Pallet jack", dockA);
    const gwA = await device({ kind: "ble_gateway", name: "Dock A gateway", externalId: hex(6), locationId: dockA, updatesLocation: true });
    const gw3 = await device({ kind: "ble_gateway", name: "Aisle 3 gateway", externalId: hex(6), locationId: aisle3, updatesLocation: true });
    assert.ok(gwA.token?.startsWith("bdt_"), "a gateway gets an ingest token");
    const tagMac = hex(6);
    const tag = await device({
      kind: "ble_tag",
      name: "Tag on pallet jack",
      externalId: `ibeacon:${uuid}:7:9`,
      itemId: pallet,
      ble: { bleMac: tagMac },
    });
    assert.equal(tag.token, null, "a tag does not post, so it has no token");
    assert.match(tag.row.externalId!, /^ibeacon:[0-9a-f-]{36}:7:9$/);

    // Both gateways report every second, 20% of reports lost, with noise and
    // deep fades. 90 s in Dock A, a 12 s walk, 90 s in Aisle 3.
    const random = rng(2026);
    const noise = (mean: number) => {
      const r = random();
      return Math.round(mean + (random() + random() + random() - 1.5) * 8 + (r < 0.05 ? -15 : r > 0.97 ? 12 : 0));
    };
    const data = iBeaconData(uuid, 7, 9);
    let zoneChanges = 0;
    for (let s = 0; s < 192; s++) {
      const p = s < 90 ? 0 : s < 102 ? (s - 90) / 12 : 1;
      const now = new Date(t0 + s * 1000 + 900);
      for (const [gw, mean] of [
        [gwA.row, -58 - 26 * p],
        [gw3.row, -84 + 26 * p],
      ] as const) {
        if (random() < 0.2) continue;
        const adverts = [{ mac: tagMac, rssi: noise(mean), at: new Date(t0 + s * 1000 + 100), data }];
        // Every tenth second the tag also sends telemetry: 2750 mV.
        if (s % 10 === 0) {
          adverts.push({ mac: tagMac, rssi: noise(mean), at: new Date(t0 + s * 1000 + 200), data: "0201060303AAFE1116AAFE20000ABE17800000040000002710" });
        }
        // Someone's phone walks past: heard, never stored.
        adverts.push({ mac: hex(6), rssi: -50, at: new Date(t0 + s * 1000 + 300), data: "0201060809506978656C203808FF06000109200255" });
        const r = await ingest.processGatewayReport(gw, { adverts, skipped: 0 }, { now });
        zoneChanges += r.zoneChanges;
      }
    }

    // First placement in Dock A (where it already was on file: not a move), then one move.
    assert.equal(zoneChanges, 2);
    const moved = await q<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM item_events WHERE item_id = $1 AND action = 'moved' ORDER BY created_at",
      [pallet],
    );
    assert.equal(moved.length, 1, JSON.stringify(moved));
    assert.equal(moved[0]!.detail.from, dockA);
    assert.equal(moved[0]!.detail.to, aisle3);
    assert.equal(moved[0]!.detail.tech, "ble");
    assert.equal(moved[0]!.detail.deviceId, gw3.row.id, "the gateway that won the room is credited");
    assert.equal(moved[0]!.detail.applied, true);
    const [onFile] = await q<{ location_id: string }>("SELECT location_id FROM items WHERE id = $1", [pallet]);
    assert.equal(onFile!.location_id, aisle3);

    // Position and presence agree.
    const [pos] = await q<{ location_id: string; previous_location_id: string; tech: string }>(
      "SELECT location_id, previous_location_id, tech FROM asset_positions WHERE item_id = $1",
      [pallet],
    );
    assert.deepEqual(pos, { location_id: aisle3, previous_location_id: dockA, tech: "ble" });
    const [state] = await q<Record<string, unknown>>("SELECT * FROM ble_tag_state WHERE tag_key = $1", [tag.row.id]);
    assert.equal(state!.location_id, aisle3);
    assert.equal(state!.previous_location_id, dockA);
    assert.equal(state!.battery_mv, 2750);
    assert.equal(state!.missing_since, null);

    // Telemetry by MAC reached the tag device: 2750 mV is 75 %.
    const [tagRow] = await q<{ battery_pct: number; last_seen_at: Date }>(
      "SELECT battery_pct, last_seen_at FROM tracking_devices WHERE id = $1",
      [tag.row.id],
    );
    assert.equal(tagRow!.battery_pct, 75);

    // "Still here" sightings are paced, not one per report; the phone is nowhere.
    const [{ n }] = (await q<{ n: string }>("SELECT count(*) AS n FROM sightings WHERE item_id = $1", [pallet])) as [
      { n: string },
    ];
    assert.ok(Number(n) >= 4 && Number(n) <= 12, `stored ${n} sightings for 192 s of reports`);
    const heard = ingest.heardNearby.list({ gatewayId: gwA.row.id, now: t0 + 192_000 });
    assert.ok(heard.length > 0 && heard.every((h) => h.name === "Pixel 8"));
    assert.equal(heard.filter((h) => h.frame !== "none").length, 0);

    // Events: placement and move, plus an out-of-hours alert for leaving Dock A on a Saturday.
    const events = await q<{ type: string; data: Record<string, unknown> }>(
      "SELECT type, data FROM audit_log WHERE subject_id = $1 AND type LIKE 'ble.%' ORDER BY id",
      [pallet],
    );
    assert.deepEqual(
      events.map((e) => [e.type, e.data.from ?? null, e.data.to ?? null]),
      [
        ["ble.tag_zone_changed", null, dockA],
        ["ble.tag_zone_changed", dockA, aisle3],
        ["ble.tag_moved_after_hours", dockA, aisle3],
      ],
    );
    const afterHours = await q<{ kind: string }>("SELECT kind FROM ble_alerts WHERE item_id = $1", [pallet]);
    assert.deepEqual(afterHours.map((a) => a.kind), ["after_hours_move"]);

    // Ten minutes of silence: missing, once, however often the sweep runs.
    const lastHeard = t0 + 191_000;
    assert.equal((await alerts.checkMissing(new Date(lastHeard + 9 * 60_000))) >= 0, true);
    let [st] = await q<{ missing_since: Date | null }>("SELECT missing_since FROM ble_tag_state WHERE tag_key = $1", [tag.row.id]);
    assert.equal(st!.missing_since, null, "not missing before the timeout");
    await alerts.checkMissing(new Date(lastHeard + 11 * 60_000));
    await alerts.checkMissing(new Date(lastHeard + 12 * 60_000));
    [st] = await q("SELECT missing_since FROM ble_tag_state WHERE tag_key = $1", [tag.row.id]);
    assert.notEqual(st!.missing_since, null);
    const open = await q<{ kind: string; resolved_at: Date | null }>(
      "SELECT kind, resolved_at FROM ble_alerts WHERE tag_key = $1 AND kind = 'missing'",
      [tag.row.id],
    );
    assert.equal(open.length, 1);
    assert.equal(open[0]!.resolved_at, null);
    const missingEvents = await q("SELECT 1 FROM audit_log WHERE subject_id = $1 AND type = 'ble.tag_missing'", [pallet]);
    assert.equal(missingEvents.length, 1);
    const quiet = await queries.notSeen(0.1);
    assert.ok(quiet.some((t) => t.tagId === tag.row.id && t.missingSince));

    // Heard again: found, the alert closes, and it stays in Aisle 3.
    const back = t0 + 20 * 60_000;
    await ingest.processGatewayReport(
      gw3.row,
      { adverts: [{ mac: tagMac, rssi: -57, at: new Date(back), data }], skipped: 0 },
      { now: new Date(back + 500) },
    );
    [st] = await q("SELECT missing_since FROM ble_tag_state WHERE tag_key = $1", [tag.row.id]);
    assert.equal(st!.missing_since, null);
    const closed = await q<{ resolved_at: Date | null }>(
      "SELECT resolved_at FROM ble_alerts WHERE tag_key = $1 AND kind = 'missing'",
      [tag.row.id],
    );
    assert.notEqual(closed[0]!.resolved_at, null);
    const foundEvents = await q<{ data: Record<string, unknown> }>(
      "SELECT data FROM audit_log WHERE subject_id = $1 AND type = 'ble.tag_found'",
      [pallet],
    );
    assert.equal(foundEvents.length, 1);
    assert.equal(foundEvents[0]!.data.locationId, aisle3);

    // The item card sees the tag, its room and what hears it.
    const presence = await queries.itemPresence(pallet, back + 1000);
    assert.equal(presence.attached, 1);
    assert.equal(presence.tags[0]!.locationId, aisle3);
    assert.equal(presence.tags[0]!.heard[0]!.gatewayId, gw3.row.id);
    const zones = await queries.occupancy();
    assert.ok(zones.find((z) => z.locationId === aisle3)!.present.some((t) => t.itemId === pallet));
  });

  it("stores a move only in the item's position when the winning gateway may not move things", async () => {
    const uuid = hex(16);
    const crate = await item("Crate", dockA);
    const gwA = await device({ kind: "ble_gateway", name: "Dock A (watch only)", externalId: hex(6), locationId: dockA });
    const gw3 = await device({ kind: "ble_gateway", name: "Aisle 3 (watch only)", externalId: hex(6), locationId: aisle3 });
    await device({ kind: "ble_tag", name: "Crate tag", externalId: `eddystone:${hex(10)}:${hex(6)}`, itemId: crate });
    const tagId = (await q<{ external_id: string }>("SELECT external_id FROM tracking_devices WHERE item_id = $1", [crate]))[0]!.external_id;
    const [, ns, inst] = tagId.split(":");
    const data = `0201060303AAFE1716AAFE00E7${ns}${inst}0000`;
    void uuid;
    for (let s = 0; s < 40; s++) {
      const now = new Date(t0 + 3_600_000 + s * 1000);
      await ingest.processGatewayReport(gwA.row, { adverts: [{ mac: hex(6), rssi: -85, at: now, data }], skipped: 0 }, { now });
      await ingest.processGatewayReport(gw3.row, { adverts: [{ mac: hex(6), rssi: -55, at: now, data }], skipped: 0 }, { now });
    }
    const [onFile] = await q<{ location_id: string }>("SELECT location_id FROM items WHERE id = $1", [crate]);
    assert.equal(onFile!.location_id, dockA, "still on file in Dock A");
    const [pos] = await q<{ location_id: string }>("SELECT location_id FROM asset_positions WHERE item_id = $1", [crate]);
    assert.equal(pos!.location_id, aisle3, "but seen in Aisle 3");
    const moved = await q<{ detail: Record<string, unknown> }>("SELECT detail FROM item_events WHERE item_id = $1 AND action = 'moved'", [crate]);
    assert.equal(moved.length, 1);
    assert.equal(moved[0]!.detail.applied, false);
  });

  it("follows a beacon known only by an item identifier", async () => {
    const mac = hex(6);
    const cart = await item("Cart", null);
    await q("INSERT INTO item_identifiers (item_id, type, value) VALUES ($1, 'mac', $2)", [
      cart,
      mac.match(/../g)!.join(":"),
    ]);
    const gw = await device({ kind: "ble_gateway", name: "Aisle 3 gateway 2", externalId: hex(6), locationId: aisle3 });
    for (let s = 0; s < 15; s++) {
      const now = new Date(t0 + 7_200_000 + s * 1000);
      await ingest.processGatewayReport(gw.row, { adverts: [{ mac, rssi: -60, at: now }], skipped: 0 }, { now });
    }
    const [pos] = await q<{ location_id: string }>("SELECT location_id FROM asset_positions WHERE item_id = $1", [cart]);
    assert.equal(pos!.location_id, aisle3);
    const [state] = await q<{ tag_key: string; device_id: string | null }>(
      "SELECT tag_key, device_id FROM ble_tag_state WHERE item_id = $1",
      [cart],
    );
    assert.equal(state!.device_id, null);
    assert.equal(state!.tag_key, `mac:${mac.match(/../g)!.join(":")}`);
  });

  it("raises one battery alert per low device and closes it when replaced", async () => {
    const tag = await device({ kind: "ble_tag", name: "Low tag", externalId: hex(6) });
    await q("UPDATE tracking_devices SET battery_pct = 9 WHERE id = $1", [tag.row.id]);
    await alerts.checkBatteries();
    await alerts.checkBatteries();
    let rows = await q<{ resolved_at: Date | null }>("SELECT resolved_at FROM ble_alerts WHERE device_id = $1", [tag.row.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.resolved_at, null);
    const low = await queries.lowBatteries(20);
    assert.ok(low.some((d) => d.id === tag.row.id && d.batteryPct === 9));
    // 25 % is above the threshold but inside the 10-point margin: still open.
    await q("UPDATE tracking_devices SET battery_pct = 25 WHERE id = $1", [tag.row.id]);
    await alerts.checkBatteries();
    rows = await q("SELECT resolved_at FROM ble_alerts WHERE device_id = $1", [tag.row.id]);
    assert.equal(rows[0]!.resolved_at, null);
    await q("UPDATE tracking_devices SET battery_pct = 100 WHERE id = $1", [tag.row.id]);
    await alerts.checkBatteries();
    rows = await q("SELECT resolved_at FROM ble_alerts WHERE device_id = $1", [tag.row.id]);
    assert.notEqual(rows[0]!.resolved_at, null);
    const events = await q("SELECT 1 FROM audit_log WHERE subject_id = $1 AND type = 'ble.battery_low'", [tag.row.id]);
    assert.equal(events.length, 1);
  });

  it("claims each alert for one digest only", async () => {
    const { claimDigest } = await import("../src/services/ble/state");
    const first = await claimDigest(10_000);
    const second = await claimDigest(10_000);
    assert.equal(second.length, 0);
    void first;
  });

  it("puts a phone's person in the room of the strongest room beacon, for a while", async () => {
    const userOid = `local:${randomBytes(8).toString("hex")}`;
    const phone = await device({ kind: "mobile", name: "Dana's phone", ble: { userOid, userName: "Dana" } });
    assert.ok(phone.token);
    const uuid = hex(16);
    await device({ kind: "ble_beacon", name: "Dock A beacon", externalId: `ibeacon:${uuid}:1:1`, locationId: dockA });
    await device({ kind: "ble_beacon", name: "Aisle 3 beacon", externalId: `ibeacon:${uuid}:1:3`, locationId: aisle3 });
    const now = new Date();
    const r = await phones.processPhoneReport(
      phone.row,
      {
        adverts: [
          { identity: `ibeacon:${uuid}:1:1`, rssi: -85, at: now },
          { identity: `ibeacon:${uuid}:1:3`, rssi: -62, at: now },
          { identity: `ibeacon:${hex(16)}:9:9`, rssi: -40, at: now },
        ],
        skipped: 0,
      },
      { now },
    );
    assert.equal(r.matched, 2);
    assert.equal(r.room?.locationId, aisle3);
    const room = await phones.roomForUser(userOid, now);
    assert.equal(room?.locationId, aisle3);
    assert.equal(room?.beaconName, `Aisle 3 beacon ${run}`);
    // A slightly stronger Dock A reading is not enough to move the person.
    await phones.processPhoneReport(
      phone.row,
      { adverts: [{ identity: `ibeacon:${uuid}:1:1`, rssi: -60, at: new Date(now.getTime() + 5000) }, { identity: `ibeacon:${uuid}:1:3`, rssi: -62, at: new Date(now.getTime() + 5000) }], skipped: 0 },
      { now: new Date(now.getTime() + 5000) },
    );
    assert.equal((await phones.roomForUser(userOid, new Date(now.getTime() + 5000)))?.locationId, aisle3);
    // And the room expires.
    assert.equal(await phones.roomForUser(userOid, new Date(now.getTime() + 60 * 60_000)), null);
    assert.equal(await phones.roomForUser("local:nobody"), null);
  });

  it("registers a gateway on first report and finds it by MAC in any notation", async () => {
    const mac = hex(6);
    const created = await devices.findOrCreateGateway(mac.toLowerCase());
    assert.equal(created.kind, "ble_gateway");
    assert.equal(created.externalId, mac.match(/../g)!.join(":"));
    const again = await devices.findOrCreateGateway(mac.match(/../g)!.join("-"));
    assert.equal(again.id, created.id);
  });

  it("refuses beacon ids it cannot read, and keeps other features' settings", async () => {
    await assert.rejects(() => devices.createBleDevice({ kind: "ble_tag", name: "Bad", externalId: "ibeacon:nope:1:2" }), /not a beacon id/);
    await assert.rejects(() => devices.createBleDevice({ kind: "ble_beacon", name: "Blank", externalId: "" }), /Give the beacon's id/);
    const gw = await device({ kind: "ble_gateway", name: "Offset gateway", externalId: hex(6), ble: { rssiOffset: 3 } });
    await q("UPDATE tracking_devices SET settings = settings || '{\"rssiFloor\": -90, \"gpsThing\": 1}' WHERE id = $1", [gw.row.id]);
    await devices.updateBleDevice(gw.row.id, { ble: { rssiOffset: 5, txPower: null } });
    const [row] = await q<{ settings: Record<string, unknown> }>("SELECT settings FROM tracking_devices WHERE id = $1", [gw.row.id]);
    assert.deepEqual(row!.settings, { rssiOffset: 5, rssiFloor: -90, gpsThing: 1 });
  });
});
