import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

/**
 * Every anomaly rule against a fixture: the fixture produces an anomaly, and
 * the same fixture with the problem fixed resolves it, through the same
 * reconcile step the scheduled run uses. Pure; no database.
 */

process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Rules = typeof import("../src/services/ops-intel/rules");
type Model = typeof import("../src/services/ops-intel/model");
type Reconcile = typeof import("../src/services/ops-intel/reconcile");
type Places = typeof import("../src/services/ops-intel/places");

let rules: Rules;
let model: Model;
let rec: Reconcile;
let PlaceIndex: Places["PlaceIndex"];

before(async () => {
  rules = await import("../src/services/ops-intel/rules");
  model = await import("../src/services/ops-intel/model");
  rec = await import("../src/services/ops-intel/reconcile");
  ({ PlaceIndex } = await import("../src/services/ops-intel/places"));
});

type Finding = import("../src/services/ops-intel/rules").Finding;
type Facts = import("../src/services/ops-intel/rules").Facts;
type RuleId = import("../src/services/ops-intel/model").RuleId;
type Existing = import("../src/services/ops-intel/reconcile").ExistingAnomaly;
type Ops = import("../src/services/ops-intel/reconcile").ReconcileOps;

const NOW = new Date("2026-09-26T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Warehouse (London) > Aisle 1 > Shelf 1, Warehouse > Dock; Site B (Birmingham), about 163 km away.
const W = "00000000-0000-4000-8000-00000000000a";
const A1 = "00000000-0000-4000-8000-0000000000a1";
const S1 = "00000000-0000-4000-8000-0000000000b1";
const D = "00000000-0000-4000-8000-0000000000d0";
const SB = "00000000-0000-4000-8000-0000000000bb";

function ctx(patch: unknown = {}) {
  const places = new PlaceIndex(
    [
      { id: W, parentId: null, name: "Warehouse" },
      { id: A1, parentId: W, name: "Aisle 1" },
      { id: S1, parentId: A1, name: "Shelf 1" },
      { id: D, parentId: W, name: "Dock" },
      { id: SB, parentId: null, name: "Site B" },
    ],
    [
      [W, { lat: 51.5072, lng: -0.1276 }],
      [SB, { lat: 52.4862, lng: -1.8904 }],
    ],
  );
  return { now: NOW, places, settings: model.mergeSettings(model.defaultSettings(), patch) };
}

/** An in-memory anomaly table, driven by the real reconcile step. */
class Store {
  rows: (Existing & { finding: Finding })[] = [];
  private seq = 0;

  run(rule: RuleId, facts: Partial<Facts>, c = ctx()): Ops {
    const findings = rules.runRule(rule, facts, c);
    const ops = rec.reconcile({ findings, existing: this.rows, rulesRun: [rule], rulesDisabled: [] });
    for (const x of ops.clear) Object.assign(this.row(x.id), { resolvedAt: NOW, resolution: "cleared" });
    for (const id of ops.markCleared) this.row(id).clearedAt = NOW;
    for (const r of ops.refresh) Object.assign(this.row(r.id), { finding: r.finding, occurrences: r.occurrences, occurredAt: r.occurredAt });
    for (const i of ops.insert) {
      this.rows.push({
        id: `a${++this.seq}`,
        rule: i.finding.rule,
        key: i.finding.key,
        sticky: i.finding.sticky,
        occurrences: 1,
        occurredAt: i.finding.occurredAt,
        resolvedAt: null,
        resolution: null,
        clearedAt: null,
        finding: i.finding,
      });
    }
    return ops;
  }

  resolve(id: string, resolution: "fixed" | "dismissed") {
    const r = this.row(id);
    Object.assign(r, { resolvedAt: NOW, resolution, clearedAt: r.sticky && resolution === "dismissed" ? NOW : null });
  }

  row(id: string) {
    const r = this.rows.find((x) => x.id === id);
    assert.ok(r, `no row ${id}`);
    return r;
  }

  open() {
    return this.rows.filter((r) => r.resolvedAt === null);
  }
}

/** Produce an anomaly from `broken`, then resolve it with `fixed`. */
function lifecycle(rule: RuleId, broken: Partial<Facts>, fixed: Partial<Facts>, c = ctx()): Finding {
  const store = new Store();
  const first = store.run(rule, broken, c);
  assert.equal(first.insert.length, 1, `${rule}: one anomaly opened`);
  assert.equal(store.open().length, 1);
  const finding = first.insert[0]!.finding;
  assert.equal(finding.rule, rule);
  assert.ok(finding.title.length > 10, "has a readable title");
  assert.ok(finding.link?.startsWith("/"), "links to the screen where it is fixed");

  const again = store.run(rule, broken, c);
  assert.equal(again.insert.length, 0, `${rule}: not opened twice`);
  assert.equal(again.refresh.length + again.touch.length, 1);

  const second = store.run(rule, fixed, c);
  assert.equal(second.clear.length, 1, `${rule}: cleared once fixed`);
  assert.equal(second.clear[0]!.reason, "not_found");
  assert.equal(store.open().length, 0);
  return finding;
}

// --- Stage rules ---------------------------------------------------------------

const line = (over: Partial<import("../src/services/ops-intel/rules").StageLineFact> = {}) => ({
  jobItemId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  jobCode: "JOB-7F3K2A",
  jobName: "Floor 3 move",
  jobUsesPlacement: true,
  jobShipmentCount: 1,
  jobShipmentsLeft: 1,
  shipmentId: "33333333-3333-4333-8333-333333333333",
  shipmentCode: "SHP-9QX3TR",
  shipmentStatus: "in_transit",
  shipmentArrivedAt: null,
  stage: "packed",
  stageAt: ago(5 * HOUR),
  itemId: "44444444-4444-4444-8444-444444444444",
  unitId: null,
  name: "Filing cabinet",
  code: "INV-4F2K1B",
  ...over,
});

describe("packed_not_loaded", () => {
  it("opens when the shipment left without the line, and clears once it is loaded", () => {
    const f = lifecycle("packed_not_loaded", { stageLines: [line()] }, { stageLines: [line({ stage: "loaded" })] });
    assert.equal(f.severity, "high");
    assert.equal(f.subjectType, "job_item");
    assert.equal(f.link, "/jobs/22222222-2222-4222-8222-222222222222");
    assert.match(f.title, /SHP-9QX3TR left without it/);
  });

  it("is medium while the shipment is loaded but still at the dock", () => {
    const [f] = rules.packedNotLoaded([line({ shipmentStatus: "loaded" })]);
    assert.equal(f?.severity, "medium");
  });

  it("flags a line on no shipment once every shipment on the job has left", () => {
    assert.equal(rules.packedNotLoaded([line({ shipmentId: null, shipmentStatus: null, jobShipmentCount: 2, jobShipmentsLeft: 2 })]).length, 1);
    assert.equal(rules.packedNotLoaded([line({ shipmentId: null, shipmentStatus: null, jobShipmentCount: 2, jobShipmentsLeft: 1 })]).length, 0);
    assert.equal(rules.packedNotLoaded([line({ shipmentId: null, shipmentStatus: null, jobShipmentCount: 0, jobShipmentsLeft: 0 })]).length, 0);
  });

  it("leaves lines alone while their shipment is still being staged", () => {
    assert.equal(rules.packedNotLoaded([line({ shipmentStatus: "staged" })]).length, 0);
    assert.equal(rules.packedNotLoaded([line({ shipmentStatus: "planned" })]).length, 0);
  });
});

describe("loaded_not_delivered", () => {
  const loaded = (arrivedAgo: number) =>
    line({ stage: "loaded", shipmentStatus: "delivered", shipmentArrivedAt: ago(arrivedAgo) });

  it("opens after the grace period and clears once the line is delivered", () => {
    const f = lifecycle(
      "loaded_not_delivered",
      { stageLines: [loaded(3 * HOUR)] },
      { stageLines: [{ ...loaded(3 * HOUR), stage: "delivered" }] },
    );
    assert.equal(f.severity, "high");
    assert.deepEqual((f.detail.threshold as { graceMinutes: number }).graceMinutes, 120);
  });

  it("waits for the crew to unload during the grace period", () => {
    assert.equal(rules.loadedNotDelivered([loaded(30 * MIN)], ctx()).length, 0);
    assert.equal(rules.loadedNotDelivered([loaded(30 * MIN)], ctx({ rules: { loaded_not_delivered: { graceMinutes: 10 } } })).length, 1);
  });

  it("ignores shipments that have not arrived", () => {
    assert.equal(rules.loadedNotDelivered([line({ stage: "loaded", shipmentStatus: "in_transit" })], ctx()).length, 0);
  });
});

describe("delivered_not_placed", () => {
  it("opens after the threshold and clears once placed", () => {
    const f = lifecycle(
      "delivered_not_placed",
      { stageLines: [line({ stage: "delivered", stageAt: ago(30 * HOUR) })] },
      { stageLines: [line({ stage: "placed", stageAt: ago(1 * HOUR) })] },
    );
    assert.equal(f.severity, "medium");
    assert.match(f.title, /not placed/);
  });

  it("only applies to jobs that place things, and only after the threshold", () => {
    assert.equal(rules.deliveredNotPlaced([line({ stage: "delivered", stageAt: ago(30 * HOUR), jobUsesPlacement: false })], ctx()).length, 0);
    assert.equal(rules.deliveredNotPlaced([line({ stage: "delivered", stageAt: ago(2 * HOUR) })], ctx()).length, 0);
  });
});

// --- Records -------------------------------------------------------------------

const ident = (itemId: string, value: string, over: Partial<import("../src/services/ops-intel/rules").IdentityFact> = {}) => ({
  itemId,
  unitId: null,
  type: "serial",
  value,
  name: `Laptop ${itemId.slice(-1)}`,
  code: `INV-00000${itemId.slice(-1)}`,
  ...over,
});
const I1 = "55555555-5555-4555-8555-555555555551";
const I2 = "55555555-5555-4555-8555-555555555552";
const I3 = "55555555-5555-4555-8555-555555555553";

describe("duplicate_identifier", () => {
  it("opens for serials differing only by formatting, and clears once corrected", () => {
    const f = lifecycle(
      "duplicate_identifier",
      { identities: [ident(I1, "SN-0042 A"), ident(I2, "sn0042a")] },
      { identities: [ident(I1, "SN-0042 A"), ident(I2, "SN-0043A")] },
    );
    assert.equal(f.severity, "medium");
    assert.equal(f.key, "serial:SN0042A");
    assert.equal((f.detail.records as unknown[]).length, 2);
    assert.match(f.title, /differs only by formatting/);
  });

  it("is high when the value is exactly the same, including a unit's serial", () => {
    const [f] = rules.duplicateIdentifier([
      ident(I1, "C02X1234"),
      ident(I2, "C02X1234", { type: "unit_serial", unitId: "66666666-6666-4666-8666-666666666661" }),
    ]);
    assert.equal(f?.severity, "high");
  });

  it("does not count an item and its own unit, placeholders, or different kinds of identifier", () => {
    const U = "66666666-6666-4666-8666-666666666661";
    assert.equal(rules.duplicateIdentifier([ident(I1, "ABC123"), ident(I1, "ABC123", { type: "unit_serial", unitId: U })]).length, 0);
    assert.equal(rules.duplicateIdentifier([ident(I1, "N/A"), ident(I2, "n.a."), ident(I3, "N/A")]).length, 0);
    assert.equal(rules.duplicateIdentifier([ident(I1, "To be filled by O.E.M."), ident(I2, "To Be Filled By OEM")]).length, 0);
    assert.equal(rules.duplicateIdentifier([ident(I1, "0000000"), ident(I2, "0000000")]).length, 0);
    assert.equal(rules.duplicateIdentifier([ident(I1, "ABC123"), ident(I2, "ABC123", { type: "asset_tag" })]).length, 0);
  });

  it("flags two units of one item sharing a serial", () => {
    const u = (n: number) => ident(I1, "XYZ-9", { type: "unit_serial", unitId: `66666666-6666-4666-8666-66666666666${n}` });
    assert.equal(rules.duplicateIdentifier([u(1), u(2)]).length, 1);
  });

  it("normalizes like the SQL twin", async () => {
    const { identityKey } = await import("../src/services/ops-intel/text");
    assert.equal(identityKey(" aa:bb-cc dd "), "AABBCCDD");
    assert.equal(identityKey(null), "");
  });
});

const rec_ = (itemId: string, over: Partial<import("../src/services/ops-intel/rules").RecordFact> = {}) => ({
  itemId,
  name: "Dell Latitude",
  brand: "Dell",
  model: "5440",
  locationId: S1,
  code: `INV-00000${itemId.slice(-1)}`,
  serials: [],
  ...over,
});

describe("duplicate_record", () => {
  it("opens for two look-alike records in one place, and clears once one moves", () => {
    const f = lifecycle(
      "duplicate_record",
      { records: [rec_(I1), rec_(I2, { name: "dell  latitude!" })] },
      { records: [rec_(I1), rec_(I2, { locationId: D })] },
    );
    assert.equal(f.severity, "low");
    assert.equal(f.subjectType, "location");
    assert.equal(f.link, `/locations/${S1}`);
    assert.match(f.title, /Warehouse \/ Aisle 1 \/ Shelf 1/);
  });

  it("treats a large group as a set of identical things", () => {
    const many = [1, 2, 3, 4].map((i) => rec_(`55555555-5555-4555-8555-55555555555${i}`));
    assert.equal(rules.duplicateRecord(many, ctx()).length, 0);
    assert.equal(rules.duplicateRecord(many, ctx({ rules: { duplicate_record: { maxGroup: 4 } } })).length, 1);
  });

  it("does not flag records that different serials tell apart, or records without a model", () => {
    assert.equal(rules.duplicateRecord([rec_(I1, { serials: ["SN-A100"] }), rec_(I2, { serials: ["SN-B200"] })], ctx()).length, 0);
    assert.equal(rules.duplicateRecord([rec_(I1, { serials: ["SN-A100"] }), rec_(I2)], ctx()).length, 1);
    assert.equal(rules.duplicateRecord([rec_(I1, { model: "" }), rec_(I2, { model: "" })], ctx()).length, 0);
  });
});

// --- Tracking ------------------------------------------------------------------

const end = (at: Date, locationId: string | null, extra: Partial<import("../src/services/ops-intel/rules").SightingEnd> = {}) => ({
  sightingId: Math.floor(at.getTime() / 1000),
  at,
  locationId,
  lat: null,
  lng: null,
  accuracyM: null,
  ...extra,
});
const hop = (fromAt: Date, from: string | null, toAt: Date, to: string | null, extraFrom = {}, extraTo = {}) => ({
  itemId: I1,
  unitId: null,
  name: "Pallet jack",
  code: "INV-7F3K2A",
  from: end(fromAt, from, extraFrom),
  to: end(toAt, to, extraTo),
});

describe("impossible_travel", () => {
  it("opens for a tag read 160 km apart within minutes; sticky until a person resolves it", () => {
    const store = new Store();
    const t = hop(ago(20 * MIN), S1, ago(15 * MIN), SB);
    const ops = store.run("impossible_travel", { transitions: [t] });
    assert.equal(ops.insert.length, 1);
    const f = ops.insert[0]!.finding;
    assert.equal(f.sticky, true);
    assert.equal(f.severity, "high");
    assert.equal(f.occurredAt?.getTime(), t.to.at.getTime());
    assert.ok((f.detail.speedKmh as number) > 1000);
    assert.match(f.title, /16\d km apart within 5 min/);

    // The read leaves the look-back window: an event does not clear itself.
    const later = store.run("impossible_travel", { transitions: [] });
    assert.equal(later.clear.length, 0);
    assert.equal(store.open().length, 1);

    // A person resolves it; the same read seen again is not a new event.
    store.resolve(store.open()[0]!.id, "fixed");
    assert.equal(store.run("impossible_travel", { transitions: [t] }).insert.length, 0);

    // A new occurrence afterwards is.
    const next = hop(ago(4 * MIN), S1, ago(2 * MIN), SB);
    const reopened = store.run("impossible_travel", { transitions: [t, next] });
    assert.equal(reopened.insert.length, 1);
    assert.equal(reopened.insert[0]!.reopenedFrom, "a1");
  });

  it("counts a repeat while open instead of opening another", () => {
    const store = new Store();
    store.run("impossible_travel", { transitions: [hop(ago(20 * MIN), S1, ago(15 * MIN), SB)] });
    const ops = store.run("impossible_travel", { transitions: [hop(ago(10 * MIN), SB, ago(8 * MIN), S1)] });
    assert.equal(ops.insert.length, 0);
    assert.equal(ops.refresh.length, 1);
    assert.equal(ops.refresh[0]!.occurrences, 2);
  });

  it("ignores nested zones, plausible journeys and zones without coordinates", () => {
    const c = ctx();
    assert.equal(rules.impossibleTravel([hop(ago(2 * MIN), W, ago(1 * MIN), S1)], c).length, 0);
    // 163 km in three hours is about 54 km/h.
    assert.equal(rules.impossibleTravel([hop(ago(4 * HOUR), S1, ago(1 * HOUR), SB)], c).length, 0);
    assert.equal(rules.impossibleTravel([hop(ago(2 * MIN), D, ago(1 * MIN), null)], c).length, 0);
  });

  it("uses GPS fixes and gives them their accuracy radius", () => {
    const c = ctx();
    const gps = (lat: number, lng: number, acc: number | null) => ({ lat, lng, accuracyM: acc });
    // About 1.1 km apart in ten seconds: too fast...
    const fast = hop(ago(20_000), null, ago(10_000), null, gps(51.5, -0.12, 5), gps(51.51, -0.12, 5));
    assert.equal(rules.impossibleTravel([fast], c).length, 1);
    // ...unless the fixes are each 600 m uncertain.
    const fuzzy = hop(ago(20_000), null, ago(10_000), null, gps(51.5, -0.12, 600), gps(51.51, -0.12, 600));
    assert.equal(rules.impossibleTravel([fuzzy], c).length, 0);
  });
});

const pos = (over: Partial<import("../src/services/ops-intel/rules").PositionFact> = {}) => ({
  itemId: I1,
  unitId: null,
  name: "Label printer",
  code: "INV-9QX3TR",
  zoneId: D,
  enteredAt: ago(6 * HOUR),
  observedAt: ago(10 * MIN),
  recordedLocationId: S1,
  recordChangedAt: ago(10 * HOUR),
  active: true,
  checkedOut: false,
  ...over,
});

describe("zone_mismatch", () => {
  it("opens when an asset sits in another zone for hours, and clears once moved on file", () => {
    const f = lifecycle(
      "zone_mismatch",
      { positions: [pos()] },
      { positions: [pos({ recordedLocationId: D, recordChangedAt: ago(1 * MIN) })] },
    );
    assert.equal(f.severity, "medium");
    assert.match(f.title, /read in Warehouse \/ Dock for 6 h but is on file in Warehouse \/ Aisle 1 \/ Shelf 1/);
  });

  it("agrees when one place is inside the other", () => {
    assert.equal(rules.zoneMismatch([pos({ zoneId: A1 })], ctx()).length, 0);
    assert.equal(rules.zoneMismatch([pos({ zoneId: W })], ctx()).length, 0);
  });

  it("trusts a record changed after the last read, and waits for the threshold", () => {
    assert.equal(rules.zoneMismatch([pos({ recordChangedAt: ago(1 * MIN) })], ctx()).length, 0);
    assert.equal(rules.zoneMismatch([pos({ enteredAt: ago(2 * HOUR) })], ctx()).length, 0);
    // Moved on file five hours ago to the wrong place: counted from then.
    assert.equal(rules.zoneMismatch([pos({ enteredAt: ago(9 * HOUR), recordChangedAt: ago(3 * HOUR) })], ctx()).length, 0);
  });

  it("is low when there is no place on file at all", () => {
    assert.equal(rules.zoneMismatch([pos({ recordedLocationId: null })], ctx())[0]?.severity, "low");
  });
});

describe("not_seen", () => {
  it("opens for a quiet active asset, and clears once it is read again", () => {
    const f = lifecycle("not_seen", { positions: [pos({ observedAt: ago(20 * DAY) })] }, { positions: [pos()] });
    assert.match(f.title, /has not been read for 20 days; last in Warehouse \/ Dock/);
  });

  it("leaves checked-out and inactive assets alone", () => {
    assert.equal(rules.notSeen([pos({ observedAt: ago(20 * DAY), checkedOut: true })], ctx()).length, 0);
    assert.equal(rules.notSeen([pos({ observedAt: ago(20 * DAY), active: false })], ctx()).length, 0);
    assert.equal(rules.notSeen([pos({ observedAt: ago(10 * DAY) })], ctx()).length, 0);
  });
});

// --- Shipments -------------------------------------------------------------------

const onShipment = (shipment: string, over: Partial<import("../src/services/ops-intel/rules").ShipmentLineFact> = {}) => ({
  jobItemId: `77777777-7777-4777-8777-77777777777${shipment}`,
  jobId: `88888888-8888-4888-8888-88888888888${shipment}`,
  jobCode: `JOB-00000${shipment}`,
  shipmentId: `99999999-9999-4999-8999-99999999999${shipment}`,
  shipmentCode: `SHP-00000${shipment}`,
  shipmentStatus: "planned",
  itemId: I1,
  unitId: null,
  name: "Server rack",
  code: "INV-RACK01",
  ...over,
});

describe("multi_shipment", () => {
  it("opens for an asset on two open shipments, and clears once taken off one", () => {
    const f = lifecycle(
      "multi_shipment",
      { shipmentLines: [onShipment("1"), onShipment("2")] },
      { shipmentLines: [onShipment("1")] },
    );
    assert.equal(f.severity, "medium");
    assert.match(f.title, /on 2 open shipments: SHP-000001 \(JOB-000001\), SHP-000002 \(JOB-000002\)/);
  });

  it("is high when both vehicles claim to have it on board", () => {
    const [f] = rules.multiShipment([onShipment("1", { shipmentStatus: "loaded" }), onShipment("2", { shipmentStatus: "in_transit" })]);
    assert.equal(f?.severity, "high");
  });

  it("allows different units of one item on different shipments, but not the whole item and a unit", () => {
    const u = (n: string) => `66666666-6666-4666-8666-66666666666${n}`;
    assert.equal(rules.multiShipment([onShipment("1", { unitId: u("1") }), onShipment("2", { unitId: u("2") })]).length, 0);
    assert.equal(rules.multiShipment([onShipment("1"), onShipment("2", { unitId: u("2") })]).length, 1);
    assert.equal(rules.multiShipment([onShipment("1", { unitId: u("1") }), onShipment("2", { unitId: u("1") })]).length, 1);
  });
});

describe("rule registry", () => {
  it("has a runner, a fact source and a description for every rule", () => {
    for (const id of model.RULE_IDS) {
      assert.ok(model.RULES[id].description.length > 20, id);
      assert.ok(rules.RULE_FACTS[id], id);
      assert.deepEqual(rules.runRule(id, {}, ctx()), []);
    }
  });
});

describe("settings", () => {
  it("keeps known keys, clamps numbers and keeps B after A", () => {
    const s = model.mergeSettings(model.defaultSettings(), {
      rules: { not_seen: { days: -4, enabled: false }, bogus: { enabled: true } },
      storage: { abcA: 0.9, abcB: 0.5 },
      load: { fillFactor: 7, categoryDefaults: { Chairs: { weightKg: 8 }, Empty: {} } },
      extra: 1,
    });
    assert.equal(s.rules.not_seen.days, 1);
    assert.equal(s.rules.not_seen.enabled, false);
    assert.equal(s.storage.abcB > s.storage.abcA, true);
    assert.equal(s.load.fillFactor, 1);
    assert.deepEqual(s.load.categoryDefaults, { Chairs: { weightKg: 8 } });
    assert.equal("extra" in s, false);
    assert.deepEqual(model.enabledRules(s).includes("not_seen"), false);
  });

  it("reads a missing or broken value as the defaults", () => {
    assert.deepEqual(model.mergeSettings(model.defaultSettings(), null), model.defaultSettings());
    assert.deepEqual(model.mergeSettings(model.defaultSettings(), "nonsense"), model.defaultSettings());
  });
});
