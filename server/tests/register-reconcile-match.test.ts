import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Pure modules: nothing here reads the environment, so static imports are safe.
import {
  autoMap,
  dayFirstForLocale,
  detectPreset,
  normalizeRow,
} from "../src/services/register-reconcile/presets";
import { buildLocationIndex } from "../src/services/register-reconcile/locationIndex";
import {
  buildKeyIndex,
  classify,
  itemKey,
  matchExact,
  unitKey,
  type Proposal,
  type RowInput,
  type Target,
} from "../src/services/register-reconcile/classify";
import { planImport, type PlanRow } from "../src/services/register-reconcile/plan";
import { compareRuns } from "../src/services/register-reconcile/compare";

const SNIPE_HEADERS = [
  "ID", "Company", "Name", "Asset Tag", "Model", "Model No.", "Category", "Status", "Checked Out To",
  "Location", "Default Location", "Serial", "Purchase Date", "Purchase Cost", "Order Number", "Supplier",
  "Manufacturer", "Notes",
];
const HOMEBOX_HEADERS = [
  "HB.import_ref", "HB.location", "HB.labels", "HB.asset_id", "HB.archived", "HB.name", "HB.quantity",
  "HB.description", "HB.insured", "HB.notes", "HB.purchase_price", "HB.purchase_from", "HB.purchase_time",
  "HB.manufacturer", "HB.model_number", "HB.serial_number", "HB.lifetime_warranty", "HB.warranty_expires",
];
const ERP_HEADERS = [
  "Asset Number", "Asset Description", "Asset Class", "Serial Number", "Location", "Acquisition Date",
  "Acquisition Cost", "Accumulated Depreciation", "Net Book Value", "Custodian",
];

describe("presets", () => {
  it("recognises each source system from its headers", () => {
    assert.equal(detectPreset(SNIPE_HEADERS), "snipeit");
    assert.equal(detectPreset(HOMEBOX_HEADERS), "homebox");
    assert.equal(detectPreset(ERP_HEADERS), "erp");
    assert.equal(detectPreset(["Tag", "Item", "Room"]), "generic");
  });

  it("maps a Snipe-IT export, preferring the model number over the model name", () => {
    const m = autoMap(SNIPE_HEADERS, "snipeit");
    assert.equal(m.assetTag, "Asset Tag");
    assert.equal(m.name, "Name");
    assert.equal(m.model, "Model No.");
    assert.equal(m.serial, "Serial");
    assert.equal(m.locationText, "Location");
    assert.equal(m.custodian, "Checked Out To");
    assert.equal(m.cost, "Purchase Cost");
    assert.equal(m.purchaseDate, "Purchase Date");
    assert.equal(m.brand, "Manufacturer");
  });

  it("maps a Homebox export", () => {
    const m = autoMap(HOMEBOX_HEADERS, "homebox");
    assert.equal(m.assetTag, "HB.asset_id");
    assert.equal(m.name, "HB.name");
    assert.equal(m.locationText, "HB.location");
    assert.equal(m.quantity, "HB.quantity");
    assert.equal(m.serial, "HB.serial_number");
    assert.equal(m.cost, "HB.purchase_price");
  });

  it("maps an ERP register, where the description is the name", () => {
    const m = autoMap(ERP_HEADERS, "erp");
    assert.equal(m.assetTag, "Asset Number");
    assert.equal(m.name, "Asset Description");
    assert.equal(m.cost, "Acquisition Cost");
    assert.equal(m.purchaseDate, "Acquisition Date");
    assert.equal(m.custodian, "Custodian");
    assert.equal(m.category, "Asset Class");
  });

  it("maps generic headers by common names, one header per field", () => {
    const m = autoMap(["Tag #", "Item", "S/N", "RFID", "Room", "Price", "Qty"], "generic");
    assert.deepEqual(m, {
      assetTag: "Tag #",
      serial: "S/N",
      epc: "RFID",
      name: "Item",
      locationText: "Room",
      cost: "Price",
      quantity: "Qty",
    });
  });

  it("normalises a row and reports unreadable cells", () => {
    const row = normalizeRow(
      { Tag: " a-1 ", Item: "Laptop", RFID: "e2:80", Cost: "abc", Bought: "03/04/2022" },
      { assetTag: "Tag", name: "Item", epc: "RFID", cost: "Cost", purchaseDate: "Bought" },
      { dayFirst: true },
    );
    assert.equal(row.assetTag, "a-1");
    assert.equal(row.epc, "E280");
    assert.equal(row.costCents, null);
    assert.equal(row.purchaseDate, "2022-04-03");
    assert.equal(row.issues.length, 1);
    assert.equal(dayFirstForLocale("en-US"), false);
    assert.equal(dayFirstForLocale("en-GB"), true);
  });
});

describe("location resolution", () => {
  const locations = [
    { id: "wh", name: "Warehouse", parentId: null },
    { id: "a3", name: "Aisle 3", parentId: "wh" },
    { id: "chi", name: "Chicago", parentId: null },
    { id: "chi-st", name: "Storage", parentId: "chi" },
    { id: "den", name: "Denver", parentId: null },
    { id: "den-st", name: "Storage", parentId: "den" },
    { id: "lab", name: "Lab", parentId: null },
  ];
  const index = buildLocationIndex(locations, [{ sourceText: "BLDG-7 RM 12", locationId: "lab" }]);

  it("resolves by full path first, whatever the separator", () => {
    assert.deepEqual(index.resolve("warehouse > aisle 3"), { locationId: "a3", via: "path", ambiguous: false });
    assert.deepEqual(index.resolve("Denver / Storage"), { locationId: "den-st", via: "path", ambiguous: false });
  });

  it("then by a name only one location has", () => {
    assert.deepEqual(index.resolve("aisle 3"), { locationId: "a3", via: "name", ambiguous: false });
  });

  it("does not guess between locations that share a name", () => {
    assert.deepEqual(index.resolve("Storage"), { locationId: null, via: null, ambiguous: true });
    // Nor from the last part of a path that is not here.
    assert.deepEqual(index.resolve("Boston / Storage"), { locationId: null, via: null, ambiguous: false });
  });

  it("then by a remembered mapping", () => {
    assert.deepEqual(index.resolve("bldg-7 rm 12"), { locationId: "lab", via: "mapping", ambiguous: false });
    assert.equal(index.path("den-st"), "Denver / Storage");
  });
});

// --- Classification fixture ---------------------------------------------
//
// One register and one inventory that between them produce every class.

const L = { shelfA: "loc-a", shelfB: "loc-b", yard: "loc-yard" };

function target(p: Partial<Target> & { key: string; itemId: string }): Target {
  return {
    unitId: null,
    name: "Thing",
    model: null,
    assetCode: `INV-${p.key.slice(2).toUpperCase()}`,
    locationId: L.shelfA,
    valueCents: null,
    flaggedMissing: false,
    serials: [],
    assetTags: [],
    epcs: [],
    inScope: true,
    hasUnits: false,
    ...p,
  };
}

const TARGETS: Target[] = [
  // Clean match on asset tag.
  target({ key: itemKey("laptop"), itemId: "laptop", name: "Laptop", model: "Latitude 5420", assetTags: ["AT-1"], serials: ["SN-1"] }),
  // Register says Shelf B.
  target({ key: itemKey("drill"), itemId: "drill", name: "Drill", serials: ["SN-2"] }),
  // Model and cost disagree.
  target({ key: itemKey("printer"), itemId: "printer", name: "Printer", model: "M404", valueCents: 30000, epcs: ["E2801160"] }),
  // Flagged missing here, but the register lists it.
  target({ key: itemKey("ladder"), itemId: "ladder", name: "Ladder", flaggedMissing: true }),
  // Not in the register at all.
  target({ key: itemKey("cart"), itemId: "cart", name: "Cart" }),
  target({ key: itemKey("lost"), itemId: "lost", name: "Lost scanner", flaggedMissing: true }),
  // Two records here share a serial.
  target({ key: itemKey("twin1"), itemId: "twin1", name: "Monitor", serials: ["DUP-SN"] }),
  target({ key: itemKey("twin2"), itemId: "twin2", name: "Monitor", serials: ["DUP-SN"] }),
  // An item with tracked units: the units are the assets.
  target({ key: itemKey("radios"), itemId: "radios", name: "Radio", hasUnits: true, assetTags: ["RADIO-SET"] }),
  target({ key: unitKey("r1"), itemId: "radios", unitId: "r1", name: "Radio", serials: ["R-1"], assetCode: "INV-R1" }),
  target({ key: unitKey("r2"), itemId: "radios", unitId: "r2", name: "Radio", serials: ["R-2"], assetCode: "INV-R2" }),
  // Outside the run's scope, but still matchable.
  target({ key: itemKey("far"), itemId: "far", name: "Generator", inScope: false, assetTags: ["AT-FAR"] }),
  // Fuzzy candidate for an untagged row.
  target({ key: itemKey("forklift"), itemId: "forklift", name: "Toyota forklift" }),
];

const row = (p: Partial<RowInput> & { id: string; rowNumber: number }): RowInput => ({
  assetTag: null,
  serial: null,
  epc: null,
  bindexCode: null,
  name: null,
  model: null,
  costCents: null,
  locationText: null,
  registerLocationId: null,
  ...p,
});

const ROWS: RowInput[] = [
  row({ id: "r-laptop", rowNumber: 2, assetTag: "at-1", serial: "sn-1", model: "LATITUDE-5420", locationText: "Shelf A", registerLocationId: L.shelfA }),
  row({ id: "r-drill", rowNumber: 3, serial: "SN-2", locationText: "Shelf B", registerLocationId: L.shelfB }),
  row({ id: "r-printer", rowNumber: 4, epc: "e2:80:11:60", model: "M479", costCents: 25000 }),
  row({ id: "r-ladder", rowNumber: 5, bindexCode: "inv-ladder" }),
  row({ id: "r-new", rowNumber: 6, assetTag: "AT-NEW", name: "Pallet wrapper" }),
  row({ id: "r-dup-a", rowNumber: 7, assetTag: "AT-DUP", name: "Bench" }),
  row({ id: "r-dup-b", rowNumber: 8, assetTag: "at-dup", name: "Bench" }),
  row({ id: "r-twin", rowNumber: 9, serial: "DUP-SN" }),
  row({ id: "r-radio1", rowNumber: 10, serial: "R-1" }),
  row({ id: "r-radio1-again", rowNumber: 11, assetTag: "INV-R1" }),
  row({ id: "r-far", rowNumber: 12, assetTag: "AT-FAR" }),
  row({ id: "r-fuzzy", rowNumber: 13, name: "Forklift, Toyota", locationText: "Nowhere" }),
];

function run(proposals = new Map<string, Proposal>()) {
  const targets = new Map(TARGETS.map((t) => [t.key, t]));
  const matches = matchExact(ROWS, buildKeyIndex(TARGETS), targets);
  return { matches, ...classify(ROWS, matches, targets, proposals) };
}

const byRow = (results: ReturnType<typeof run>["results"], id: string) => {
  const r = results.find((x) => x.rowId === id);
  assert.ok(r, `no result for ${id}`);
  return r;
};
const byItem = (results: ReturnType<typeof run>["results"], key: string) =>
  results.filter((x) => x.rowId === null && x.targetKey === key);

describe("matchExact", () => {
  const { matches } = run();

  it("matches on asset tag first, case-insensitively", () => {
    assert.deepEqual(matches.get("r-laptop")!.targetKey, itemKey("laptop"));
    assert.equal(matches.get("r-laptop")!.method, "asset_tag");
  });

  it("falls through to serial, EPC and printed code in that order", () => {
    assert.equal(matches.get("r-drill")!.method, "serial");
    assert.equal(matches.get("r-printer")!.method, "epc");
    assert.equal(matches.get("r-ladder")!.method, "asset_code");
    // A unit's printed code in the asset tag column still finds the unit.
    assert.equal(matches.get("r-radio1-again")!.targetKey, unitKey("r1"));
    assert.equal(matches.get("r-radio1-again")!.method, "asset_code");
  });

  it("matches a unit by its serial", () => {
    assert.equal(matches.get("r-radio1")!.targetKey, unitKey("r1"));
  });

  it("leaves a key that is on two records unmatched and reports both", () => {
    const m = matches.get("r-twin")!;
    assert.equal(m.targetKey, null);
    assert.deepEqual(m.ambiguous.sort(), [itemKey("twin1"), itemKey("twin2")]);
  });

  it("notes when a row's other keys point at a different asset, and calls it a conflict", () => {
    const mixed = [row({ id: "r-mixed", rowNumber: 2, assetTag: "AT-1", serial: "SN-2" })];
    const targets = new Map(TARGETS.map((t) => [t.key, t]));
    const m = matchExact(mixed, buildKeyIndex(TARGETS), targets);
    assert.equal(m.get("r-mixed")!.targetKey, itemKey("laptop"));
    assert.deepEqual(m.get("r-mixed")!.crossRefs, [{ method: "serial", value: "SN-2", keys: [itemKey("drill")] }]);
    const { results } = classify(mixed, m, targets);
    const r = results.find((x) => x.rowId === "r-mixed")!;
    assert.deepEqual(r.classes, ["conflict"]);
    assert.deepEqual(r.conflicts[0], { field: "serial", register: "SN-2", bindex: "SN-1" });
    assert.ok(r.notes.some((n) => n === "Serial SN-2 is recorded on INV-DRILL."));
  });
});

describe("classify", () => {
  const { results, counts } = run(new Map([["r-fuzzy", { itemId: "forklift", score: 0.62 }]]));

  it("matched: keys agree and nothing differs", () => {
    // Model formatting differences are not a conflict.
    assert.deepEqual(byRow(results, "r-laptop").classes, ["matched"]);
  });

  it("misplaced: the register puts it somewhere else", () => {
    const r = byRow(results, "r-drill");
    assert.deepEqual(r.classes, ["misplaced"]);
    assert.equal(r.registerLocationId, L.shelfB);
    assert.equal(r.bindexLocationId, L.shelfA);
  });

  it("conflict: model and cost differ, and each difference is listed", () => {
    const r = byRow(results, "r-printer");
    assert.deepEqual(r.classes, ["conflict"]);
    assert.deepEqual(
      r.conflicts.map((c) => c.field),
      ["model", "cost"],
    );
  });

  it("flagged missing: the register lists something flagged missing here", () => {
    assert.deepEqual(byRow(results, "r-ladder").classes, ["flagged_missing"]);
  });

  it("register-only: nothing here matches", () => {
    assert.deepEqual(byRow(results, "r-new").classes, ["register_only"]);
  });

  it("duplicate: two register rows share a key", () => {
    for (const id of ["r-dup-a", "r-dup-b"]) {
      const r = byRow(results, id);
      assert.deepEqual(r.classes, ["register_only", "duplicate"]);
      assert.match(r.notes[0]!, /Asset tag AT-DUP is also on row/);
    }
  });

  it("duplicate: two records here share the row's key", () => {
    const r = byRow(results, "r-twin");
    assert.deepEqual(r.classes, ["register_only", "duplicate"]);
  });

  it("duplicate: two rows match the same asset", () => {
    assert.deepEqual(byRow(results, "r-radio1").classes, ["duplicate"]);
    assert.deepEqual(byRow(results, "r-radio1-again").classes, ["duplicate"]);
    assert.match(byRow(results, "r-radio1").notes[0]!, /^Register row 11 also matches INV-R1\./);
  });

  it("Bindex-only: in scope and in no row; flagged ones are also flagged missing", () => {
    assert.deepEqual(byItem(results, itemKey("cart"))[0]!.classes, ["bindex_only"]);
    assert.deepEqual(byItem(results, itemKey("lost"))[0]!.classes, ["bindex_only", "flagged_missing"]);
    // Both records sharing a serial are unaccounted for: the row did not pick one.
    assert.equal(byItem(results, itemKey("twin1")).length, 1);
    assert.equal(byItem(results, itemKey("twin2")).length, 1);
  });

  it("an item with units is accounted for unit by unit", () => {
    assert.equal(byItem(results, itemKey("radios")).length, 0);
    assert.equal(byItem(results, unitKey("r1")).length, 0);
    assert.deepEqual(byItem(results, unitKey("r2"))[0]!.classes, ["bindex_only"]);
  });

  it("matches outside the scope count, with a note, and are never Bindex-only", () => {
    const r = byRow(results, "r-far");
    assert.deepEqual(r.classes, ["matched"]);
    assert.ok(r.notes.some((n) => /outside the scope/.test(n)));
    assert.equal(byItem(results, itemKey("far")).length, 0);
  });

  it("a fuzzy proposal is shown but is not a match", () => {
    const r = byRow(results, "r-fuzzy");
    assert.deepEqual(r.classes, ["register_only"]);
    assert.deepEqual(r.proposal, { itemId: "forklift", score: 0.62 });
    assert.equal(r.itemId, null);
    assert.equal(byItem(results, itemKey("forklift")).length, 1);
    assert.ok(r.notes.some((n) => /Nowhere/.test(n)));
  });

  it("counts every class", () => {
    assert.equal(counts.rows, ROWS.length);
    assert.equal(counts.matched, 2); // laptop, far
    assert.equal(counts.misplaced, 1);
    assert.equal(counts.conflict, 1);
    assert.equal(counts.register_only, 5); // new, dup-a, dup-b, twin, fuzzy
    assert.equal(counts.bindex_only, 6); // cart, lost, twin1, twin2, r2, forklift
    assert.equal(counts.duplicate, 5); // dup-a, dup-b, twin, radio1, radio1-again
    assert.equal(counts.flagged_missing, 2); // ladder row, lost item
    assert.equal(counts.proposals, 1);
    // laptop, drill, printer, ladder, radio1, radio1-again, far
    assert.equal(counts.matchedRows, 7);
  });
});

describe("planImport", () => {
  const base: Omit<PlanRow, "id" | "rowNumber"> = {
    assetTag: null, serial: null, epc: null, name: null, model: null, brand: null, category: null,
    description: null, locationText: null, registerLocationId: null, custodian: null, costCents: null,
    purchaseDate: null, quantity: null, createdItemId: null,
  };
  const rows: PlanRow[] = [
    { ...base, id: "a", rowNumber: 2, name: "Desk", assetTag: "T-1", serial: "S-1", epc: "e2:80", costCents: 5000, registerLocationId: "loc", purchaseDate: "2022-01-02", custodian: "Ana" },
    { ...base, id: "b", rowNumber: 3, model: "XPS 13", assetTag: "T-2", locationText: "Unknown room" },
    { ...base, id: "c", rowNumber: 4, name: "Chair", assetTag: "t-1" },
    { ...base, id: "d", rowNumber: 5, name: "Lamp", serial: "TAKEN" },
    { ...base, id: "e", rowNumber: 6 },
    { ...base, id: "f", rowNumber: 7, name: "Old", createdItemId: "item-9" },
    { ...base, id: "g", rowNumber: 8, name: "Crates", quantity: 12 },
  ];
  const existing = { assetTags: new Map(), serials: new Map([["TAKEN", "INV-AAAAAA"]]), epcs: new Map() };
  const plan = planImport(rows, existing, { importId: "imp", importName: "Q3", companyId: "co", defaultLocationId: "default" });

  it("creates items with identifiers, value and register provenance", () => {
    const desk = plan.create.find((c) => c.rowId === "a")!;
    assert.deepEqual(desk.identifiers, [
      { type: "asset_tag", value: "T-1" },
      { type: "serial", value: "S-1" },
      { type: "rfid", value: "E280" },
    ]);
    assert.equal(desk.valueCents, 5000);
    assert.equal(desk.locationId, "loc");
    assert.equal(desk.companyId, "co");
    assert.deepEqual(desk.metadata, {
      register: { importId: "imp", importName: "Q3", row: 2, purchaseDate: "2022-01-02", custodian: "Ana" },
    });
  });

  it("names a nameless row by its model and falls back to the default location with a warning", () => {
    const xps = plan.create.find((c) => c.rowId === "b")!;
    assert.equal(xps.name, "XPS 13");
    assert.equal(xps.locationId, "default");
    assert.match(plan.warnings[0]!.message, /Unknown room/);
  });

  it("skips repeats, keys already in use, nameless rows and rows already imported", () => {
    const reasons = Object.fromEntries(plan.skip.map((s) => [s.rowId, s.reason]));
    assert.match(reasons.c!, /same as row 2/);
    assert.match(reasons.d!, /already on INV-AAAAAA/);
    assert.match(reasons.e!, /No name/);
    assert.match(reasons.f!, /Already imported/);
    assert.equal(plan.create.find((c) => c.rowId === "g")!.quantity, 12);
    assert.equal(plan.create.length, 3);
  });

  it("hashes the same plan the same way, and a different plan differently", () => {
    const again = planImport(rows, existing, { importId: "imp", importName: "Q3", companyId: "co", defaultLocationId: "default" });
    assert.equal(again.hash, plan.hash);
    const moved = planImport(rows, existing, { importId: "imp", importName: "Q3", companyId: "co", defaultLocationId: "elsewhere" });
    assert.notEqual(moved.hash, plan.hash);
  });
});

describe("compareRuns", () => {
  it("reports cleared, new and changed discrepancies, and ignores ignored ones", () => {
    const before = [
      { key: "i:1", label: "Drill", classes: ["misplaced" as const], ignored: false },
      { key: "i:2", label: "Cart", classes: ["bindex_only" as const], ignored: false },
      { key: "i:3", label: "Laptop", classes: ["matched" as const], ignored: false },
      { key: "i:4", label: "Printer", classes: ["conflict" as const], ignored: false },
      { key: "row:X", label: "Row 9", classes: ["register_only" as const], ignored: true },
    ];
    const after = [
      { key: "i:1", label: "Drill", classes: ["matched" as const], ignored: false },
      { key: "i:3", label: "Laptop", classes: ["misplaced" as const], ignored: false },
      { key: "i:4", label: "Printer", classes: ["conflict" as const, "misplaced" as const], ignored: false },
      { key: "row:X", label: "Row 9", classes: ["register_only" as const], ignored: true },
    ];
    const cmp = compareRuns(before, after);
    assert.deepEqual(cmp.cleared.map((e) => e.label), ["Cart", "Drill"]);
    assert.deepEqual(cmp.appeared.map((e) => e.label), ["Laptop"]);
    assert.deepEqual(cmp.changed.map((e) => e.label), ["Printer"]);
    assert.equal(cmp.unchanged, 1);
    assert.deepEqual(cmp.counts.misplaced, { before: 1, after: 2 });
  });
});
