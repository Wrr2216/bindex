import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Some modules read the environment when they load, so the minimum required
// configuration has to exist before the dynamic imports below.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Model = typeof import("../src/services/jobs-core/model");
type Rules = typeof import("../src/services/jobs-core/rules");
type Csv = typeof import("../src/services/jobs-core/csv");
type Rollups = typeof import("../src/services/jobs-core/rollups");
type Match = typeof import("../src/services/jobs-core/match");
type Places = typeof import("../src/services/jobs-core/places");
type Codes = typeof import("../src/services/jobs-core/codes");
type Resolve = typeof import("../src/services/jobs-core/resolve");
type Pdf = typeof import("../src/services/jobs-core/pdf");
type Xlsx = typeof import("../src/services/jobs-core/xlsx");

let model: Model;
let rules: Rules;
let csv: Csv;
let rollups: Rollups;
let match: Match;
let places: Places;
let codes: Codes;
let resolve: Resolve;
let pdf: Pdf;
let xlsx: Xlsx;

before(async () => {
  model = await import("../src/services/jobs-core/model");
  rules = await import("../src/services/jobs-core/rules");
  csv = await import("../src/services/jobs-core/csv");
  rollups = await import("../src/services/jobs-core/rollups");
  match = await import("../src/services/jobs-core/match");
  places = await import("../src/services/jobs-core/places");
  codes = await import("../src/services/jobs-core/codes");
  resolve = await import("../src/services/jobs-core/resolve");
  pdf = await import("../src/services/jobs-core/pdf");
  xlsx = await import("../src/services/jobs-core/xlsx");
});

describe("stage rules", () => {
  it("moves up the ladder, skipping rungs", () => {
    assert.equal(rules.decideStage("pending", "packed").decision, "advance");
    assert.equal(rules.decideStage("pending", "loaded").decision, "advance");
    assert.equal(rules.decideStage("loaded", "placed").decision, "advance");
  });

  it("treats the same stage, or one already passed, as already done", () => {
    assert.equal(rules.decideStage("loaded", "loaded").decision, "already");
    assert.equal(rules.decideStage("delivered", "loaded").decision, "already");
    assert.equal(rules.decideStage("placed", "packed").decision, "already");
  });

  it("moves down only when forced", () => {
    assert.equal(rules.decideStage("delivered", "loaded", true).decision, "advance");
  });

  it("refuses a reset to pending unless forced", () => {
    const d = rules.decideStage("packed", "pending");
    assert.equal(d.decision, "blocked");
    assert.equal(rules.decideStage("packed", "pending", true).decision, "advance");
  });

  it("allows flagging an exception from anywhere and recovering from one", () => {
    assert.equal(rules.decideStage("placed", "damaged").decision, "advance");
    assert.equal(rules.decideStage("pending", "missing").decision, "advance");
    assert.equal(rules.decideStage("missing", "loaded").decision, "advance");
    assert.equal(rules.decideStage("wrong_shipment", "packed").decision, "advance");
  });

  it("rejects a stage nobody registered", () => {
    const d = rules.decideStage("pending", "teleported");
    assert.equal(d.decision, "blocked");
  });

  it("accepts a registered exception stage", () => {
    model.registerExceptionStage("refused", { label: "Refused" });
    assert.equal(model.isExceptionStage("refused"), true);
    assert.equal(rules.decideStage("delivered", "refused").decision, "advance");
    assert.ok(model.stageList().some((s) => s.name === "refused" && s.kind === "exception"));
  });

  it("will not let a progress stage be re-registered as an exception", () => {
    assert.throws(() => model.registerExceptionStage("loaded", { label: "Loaded" }));
    assert.throws(() => model.registerExceptionStage("Bad Name", { label: "x" }));
  });

  it("ranks and compares stages", () => {
    assert.equal(rules.stageRank("pending"), 0);
    assert.equal(rules.stageRank("placed"), 4);
    assert.equal(rules.stageRank("damaged"), -1);
    assert.equal(rules.hasReached("delivered", "loaded"), true);
    assert.equal(rules.hasReached("packed", "loaded"), false);
    assert.equal(rules.hasReached("missing", "packed"), false);
  });
});

describe("task kinds", () => {
  it("links the stage-driven kinds to their stage", () => {
    assert.deepEqual(model.taskKindsForStage("loaded"), ["load"]);
    assert.deepEqual(model.taskKindsForStage("placed"), ["place"]);
    assert.deepEqual(model.taskKindsForStage("pending"), []);
  });

  it("registers a kind for a later feature", () => {
    model.registerTaskKind("crew_checkin", { label: "Crew check-in" });
    assert.equal(model.isTaskKind("crew_checkin"), true);
    assert.throws(() => model.registerTaskKind("Crew Check-In", { label: "x" }));
  });
});

describe("shipment status rules", () => {
  it("lets an empty shipment move freely forward", () => {
    const c = rules.checkShipmentTransition("planned", "delivered", []);
    assert.equal(c.ok, true);
  });

  it("holds a shipment back while lines are still pending or packed", () => {
    const c = rules.checkShipmentTransition("loaded", "delivered", ["loaded", "pending", "packed", "packed"]);
    assert.equal(c.ok, false);
    if (!c.ok) {
      assert.equal(c.code, "lines_not_ready");
      assert.deepEqual(c.blockers, { pending: 1, packed: 2 });
      assert.match(c.message, /3 lines are not loaded yet/);
    }
  });

  it("does not count exception lines against it", () => {
    const c = rules.checkShipmentTransition("in_transit", "delivered", ["loaded", "missing", "damaged"]);
    assert.equal(c.ok, true);
  });

  it("needs every line delivered to close", () => {
    const c = rules.checkShipmentTransition("delivered", "closed", ["delivered", "loaded"]);
    assert.equal(c.ok, false);
    assert.equal(rules.checkShipmentTransition("delivered", "closed", ["placed", "delivered"]).ok, true);
  });

  it("can be forced past unready lines, but only with a reason", () => {
    const noReason = rules.checkShipmentTransition("loaded", "delivered", ["pending"], { force: true });
    assert.equal(noReason.ok, false);
    if (!noReason.ok) assert.equal(noReason.code, "reason_required");
    const withReason = rules.checkShipmentTransition("loaded", "delivered", ["pending"], {
      force: true,
      reason: "Left one chair behind on purpose",
    });
    assert.equal(withReason.ok, true);
    if (withReason.ok) assert.equal(withReason.forced, true);
  });

  it("refuses to go backward unless forced", () => {
    const c = rules.checkShipmentTransition("in_transit", "staged", []);
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.code, "backward");
    assert.equal(rules.checkShipmentTransition("in_transit", "staged", [], { force: true, reason: "Truck broke down" }).ok, true);
  });

  it("does not record a forward move over ready lines as forced", () => {
    const c = rules.checkShipmentTransition("staged", "loaded", ["loaded"], { force: true, reason: "x" });
    assert.equal(c.ok, true);
    if (c.ok) assert.equal(c.forced, false);
  });

  it("stamps departure and arrival once", () => {
    const now = new Date("2026-10-01T10:00:00Z");
    assert.deepEqual(rules.shipmentTimestamps("in_transit", { departedAt: null, arrivedAt: null }, now), {
      departedAt: now,
    });
    const earlier = new Date("2026-10-01T08:00:00Z");
    assert.deepEqual(rules.shipmentTimestamps("delivered", { departedAt: earlier, arrivedAt: null }, now), {
      arrivedAt: now,
    });
    assert.deepEqual(rules.shipmentTimestamps("staged", { departedAt: null, arrivedAt: null }, now), {});
  });
});

describe("job timestamps", () => {
  it("starts on in_progress, completes on completed, and clears completion on reopening", () => {
    const now = new Date();
    assert.deepEqual(rules.jobTimestamps("in_progress", { startedAt: null, completedAt: null }, now), {
      startedAt: now,
      completedAt: null,
    });
    assert.deepEqual(rules.jobTimestamps("completed", { startedAt: now, completedAt: null }, now), {
      completedAt: now,
    });
    assert.deepEqual(rules.jobTimestamps("in_progress", { startedAt: now, completedAt: now }, now), {
      completedAt: null,
    });
  });
});

describe("CSV parsing", () => {
  it("parses quoted fields with separators, doubled quotes and line breaks", () => {
    const rows = csv.parseCsv('a,"b, c","say ""hi"""\n1,"two\nlines",3\n');
    assert.deepEqual(rows, [
      { line: 1, cells: ["a", "b, c", 'say "hi"'] },
      { line: 2, cells: ["1", "two\nlines", "3"] },
    ]);
  });

  it("detects semicolons and tabs, strips a BOM and skips blank lines", () => {
    assert.deepEqual(csv.parseCsv("﻿a;b;c\r\n\r\n1;2;3"), [
      { line: 1, cells: ["a", "b", "c"] },
      { line: 3, cells: ["1", "2", "3"] },
    ]);
    assert.deepEqual(csv.parseCsv("a\tb\n1\t2")[1]!.cells, ["1", "2"]);
  });

  it("reads a manifest with a header in any order and with aliases", () => {
    const m = csv.parseManifestCsv("Dept,Asset Code,Desk,Destination,Level\nFinance,INV-AAAAAA,5.12,HQ / Level 5,5\n");
    assert.equal(m.hasHeader, true);
    assert.deepEqual(m.rows[0], {
      line: 2,
      code: "INV-AAAAAA",
      destination: "HQ / Level 5",
      floor: "5",
      department: "Finance",
      desk: "5.12",
      crate: null,
      notes: null,
    });
    assert.equal(m.errors.length, 0);
  });

  it("reads a manifest without a header positionally", () => {
    const m = csv.parseManifestCsv("INV-AAAAAA,Room 101,1,Legal,D4\n");
    assert.equal(m.hasHeader, false);
    assert.equal(m.rows[0]!.code, "INV-AAAAAA");
    assert.equal(m.rows[0]!.desk, "D4");
  });

  it("accepts department rows that set every line in a department", () => {
    const m = csv.parseManifestCsv("code,destination,floor,department\n,Level 5,5,Finance\n,,,Legal\n");
    assert.equal(m.rows.length, 1);
    assert.equal(m.rows[0]!.code, null);
    assert.equal(m.rows[0]!.department, "Finance");
    assert.equal(m.errors.length, 1);
    assert.match(m.errors[0]!.message, /nothing to set/);
  });

  it("reports rows with neither code nor department, and an empty file", () => {
    const m = csv.parseManifestCsv("code,destination\n,Level 5\n");
    assert.equal(m.rows.length, 0);
    assert.equal(m.errors[0]!.line, 2);
    assert.equal(csv.parseManifestCsv("").errors[0]!.message, "The file is empty.");
  });
});

describe("progress rollups", () => {
  it("counts reached steps, exceptions and an overall score", () => {
    const p = rollups.rollup([
      { stage: "pending" },
      { stage: "packed" },
      { stage: "loaded" },
      { stage: "placed" },
      { stage: "damaged" },
    ]);
    assert.equal(p.total, 5);
    assert.deepEqual(p.reached, { packed: 3, loaded: 2, delivered: 1, placed: 1 });
    assert.deepEqual(p.percent, { packed: 60, loaded: 40, delivered: 20, placed: 20 });
    assert.equal(p.exceptions, 1);
    // (0 + 1 + 2 + 4 + 0) / (4 * 5) = 35%
    assert.equal(p.overall, 35);
    assert.equal(p.complete, false);
  });

  it("is complete at 100 only when every line is placed", () => {
    const p = rollups.rollup([{ stage: "placed" }, { stage: "placed" }]);
    assert.equal(p.overall, 100);
    assert.equal(p.percent.placed, 100);
    assert.equal(p.complete, true);
    assert.equal(rollups.rollup([]).complete, false);
    assert.equal(rollups.rollup([]).overall, 0);
  });

  it("gives the same answer from counts as from lines", () => {
    const lines = [{ stage: "packed" }, { stage: "packed" }, { stage: "delivered" }];
    assert.deepEqual(rollups.rollupCounts({ packed: 2, delivered: 1 }), rollups.rollup(lines));
  });

  it("groups by floor and department, with blanks last", () => {
    const j = rollups.jobProgress([
      { stage: "placed", floor: "10", department: "Legal", shipmentId: "a" },
      { stage: "pending", floor: "2", department: null, shipmentId: null },
      { stage: "loaded", floor: null, department: "Legal", shipmentId: "a" },
    ]);
    assert.deepEqual(
      j.byFloor.map((g) => g.key),
      ["2", "10", null],
    );
    assert.deepEqual(
      j.byDepartment.map((g) => [g.key, g.progress.total]),
      [
        ["Legal", 2],
        [null, 1],
      ],
    );
    assert.equal(j.byShipment.find((g) => g.key === "a")!.progress.reached.loaded, 2);
  });
});

describe("scan planning", () => {
  const A = { itemId: "item-a", unitId: null };
  const line = (id: string, itemId: string, stage: string, shipmentId: string | null = null, unitId: string | null = null) => ({
    id,
    itemId,
    unitId,
    stage,
    shipmentId,
  });

  it("sorts every code into exactly one bucket", () => {
    const resolved = new Map([
      ["A", [A]],
      ["B", [{ itemId: "item-b", unitId: null }]],
      ["C", [{ itemId: "item-c", unitId: null }]],
      ["D", [{ itemId: "item-d", unitId: null }]],
    ]);
    const lines = [
      line("la", "item-a", "packed"),
      line("lb", "item-b", "loaded", "ship-1"),
      line("lc", "item-c", "packed", "ship-2"),
    ];
    const plan = match.planAdvance(["A", "B", "C", "D", "Z"], resolved, lines, "loaded", { shipmentId: "ship-1" });
    assert.deepEqual(
      plan.advance.map((p) => [p.code, p.line.id, p.assignShipment]),
      [["A", "la", "ship-1"]],
    );
    assert.deepEqual(plan.already.map((p) => p.code), ["B"]);
    assert.deepEqual(plan.wrongShipment.map((p) => p.code), ["C"]);
    assert.deepEqual(plan.notOnJob.map((p) => p.code), ["D"]);
    assert.deepEqual(plan.unknown, ["Z"]);
  });

  it("moves a wrong-shipment line onto this shipment only when forced", () => {
    const resolved = new Map([["C", [{ itemId: "item-c", unitId: null }]]]);
    const lines = [line("lc", "item-c", "packed", "ship-2")];
    const plan = match.planAdvance(["C"], resolved, lines, "loaded", { shipmentId: "ship-1", force: true });
    assert.equal(plan.advance[0]!.assignShipment, "ship-1");
  });

  it("counts two codes for the same line once", () => {
    const resolved = new Map([
      ["EPC1", [A]],
      ["INV-A", [A]],
    ]);
    const plan = match.planAdvance(["EPC1", "INV-A", "EPC1"], resolved, [line("la", "item-a", "pending")], "packed");
    assert.equal(plan.advance.length, 1);
    assert.deepEqual(plan.already.map((p) => p.code), ["INV-A"]);
  });

  it("matches a unit code to that unit's line, or to the whole item's line", () => {
    const u2 = { itemId: "item-a", unitId: "u2" };
    const lines = [line("l1", "item-a", "pending", null, "u1"), line("l2", "item-a", "pending", null, "u2")];
    const plan = match.planAdvance(["U2"], new Map([["U2", [u2]]]), lines, "packed");
    assert.equal(plan.advance[0]!.line.id, "l2");
    const whole = match.planAdvance(["U2"], new Map([["U2", [u2]]]), [line("l0", "item-a", "pending")], "packed");
    assert.equal(whole.advance[0]!.line.id, "l0");
  });

  it("lets an item label stand in for its units one scan at a time", () => {
    const lines = [line("l1", "item-a", "packed", null, "u1"), line("l2", "item-a", "pending", null, "u2")];
    const plan = match.planAdvance(["A"], new Map([["A", [A]]]), lines, "packed");
    assert.equal(plan.advance[0]!.line.id, "l2");
  });

  it("picks the item on this job when a product code names several", () => {
    const refs = [
      { itemId: "item-x", unitId: null },
      { itemId: "item-a", unitId: null },
    ];
    const plan = match.planAdvance(["UPC"], new Map([["UPC", refs]]), [line("la", "item-a", "pending")], "packed");
    assert.equal(plan.advance[0]!.line.id, "la");
  });

  it("reports a refused move as blocked with the reason", () => {
    const plan = match.planAdvance(["A"], new Map([["A", [A]]]), [line("la", "item-a", "packed")], "pending");
    assert.equal(plan.blocked.length, 1);
    assert.match(plan.blocked[0]!.reason, /pending needs force/);
  });

  it("dedupes and trims codes in first-seen order", () => {
    assert.deepEqual(match.uniqueCodes([" a", "b", "a ", "", "c"]), ["a", "b", "c"]);
  });
});

describe("places", () => {
  const rows = [
    { id: "00000000-0000-0000-0000-000000000001", name: "HQ", parentId: null },
    { id: "00000000-0000-0000-0000-000000000002", name: "Level 5", parentId: "00000000-0000-0000-0000-000000000001" },
    { id: "00000000-0000-0000-0000-000000000003", name: "Finance", parentId: "00000000-0000-0000-0000-000000000002" },
    { id: "00000000-0000-0000-0000-000000000004", name: "Desk 1", parentId: "00000000-0000-0000-0000-000000000003" },
    { id: "00000000-0000-0000-0000-000000000005", name: "Annex", parentId: null },
    { id: "00000000-0000-0000-0000-000000000006", name: "Finance", parentId: "00000000-0000-0000-0000-000000000005" },
  ];
  const codeOf = (id: string) => `LOC-${id.slice(-6).toUpperCase()}`;

  it("matches by code, id, full path, path suffix and unique name", () => {
    const index = places.buildPlaceIndex(rows, codeOf);
    assert.deepEqual(places.matchPlace("loc-000004", index), { ok: true, id: rows[3]!.id });
    assert.deepEqual(places.matchPlace(rows[1]!.id, index), { ok: true, id: rows[1]!.id });
    assert.deepEqual(places.matchPlace("hq / level 5 / finance", index), { ok: true, id: rows[2]!.id });
    assert.deepEqual(places.matchPlace("Level 5 > Finance", index), { ok: true, id: rows[2]!.id });
    assert.deepEqual(places.matchPlace("Desk 1", index), { ok: true, id: rows[3]!.id });
  });

  it("refuses to guess between two places with the same name", () => {
    const index = places.buildPlaceIndex(rows, codeOf);
    const m = places.matchPlace("Finance", index);
    assert.equal(m.ok, false);
    if (!m.ok) {
      assert.equal(m.reason, "ambiguous");
      assert.equal(m.candidates.length, 2);
    }
    const none = places.matchPlace("Basement", index);
    assert.equal(none.ok, false);
  });

  it("walks a subtree and names each level from the root", () => {
    const index = places.buildPlaceIndex(rows, codeOf);
    assert.deepEqual(new Set(places.subtreeIds(rows[1]!.id, index)), new Set([rows[1]!.id, rows[2]!.id, rows[3]!.id]));
    assert.deepEqual(places.pathFromRoot(rows[3]!.id, rows[1]!.id, index), ["Level 5", "Finance", "Desk 1"]);
    assert.deepEqual(places.pathFromRoot(rows[5]!.id, rows[1]!.id, index), []);
  });

  it("survives a parent loop", () => {
    const loop = [
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: "a" },
    ];
    const index = places.buildPlaceIndex(loop, (id) => id);
    assert.deepEqual(places.pathOf("a", index.byId), ["B", "A"]);
  });
});

describe("codes", () => {
  it("generates prefixed Crockford codes", () => {
    for (const kind of ["project", "job", "shipment"] as const) {
      const code = codes.genCode(kind);
      assert.match(code, /^(PRJ|JOB|SHP)-[0-9A-HJKMNP-TV-Z]{6}$/);
      assert.deepEqual(codes.parseCode(code.toLowerCase()), { kind, code });
    }
    assert.equal(codes.parseCode("INV-ABC123"), null);
  });

  it("reads an item link off a label QR", () => {
    const id = "3f2a1b4c-5d6e-4f80-9a1b-2c3d4e5f6071";
    const unit = "11111111-2222-4333-8444-555555555555";
    assert.deepEqual(resolve.parseDeepLink(`https://inv.example.com/items/${id}`), { itemId: id, unitId: null });
    assert.deepEqual(resolve.parseDeepLink(`https://inv.example.com/items/${id}?unit=${unit}`), {
      itemId: id,
      unitId: unit,
    });
    assert.equal(resolve.parseDeepLink("INV-7F3K2A"), null);
  });
});

describe("documents", () => {
  const checks = { packed: true, loaded: false, delivered: false, placed: false };

  it("renders a multi-page manifest PDF, even with text the fonts cannot encode", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({
      index: i + 1,
      itemName: i === 0 ? "Chair 💺 with a long name that needs wrapping across lines" : `Item ${i + 1}`,
      sub: "Herman Miller Aeron",
      code: `INV-${String(i).padStart(6, "0")}`,
      crate: `C${i % 7}`,
      from: "HQ / Level 3 / Finance",
      to: "New HQ / Level 5 / 5.12  ·  Desk 12",
      exception: i === 3 ? "DAMAGED" : null,
      checks,
    }));
    const buf = await pdf.renderManifestPdf(
      {
        kicker: "RELOCATION MANIFEST",
        title: "Level 3 move",
        code: "JOB-7F3K2A",
        details: ["Relocation  ·  PRJ-AAAAAA HQ consolidation"],
        groups: [
          { label: "Level 3", summary: "60 lines", lines: lines.slice(0, 60) },
          { label: "Level 4", summary: "60 lines", lines: lines.slice(60) },
        ],
        summary: "120 lines",
        signatures: ["Released at origin", "Received at destination"],
        url: "https://inv.example.com/jobs/x",
      },
      new Date("2026-10-01T12:00:00Z"),
      "America/Chicago",
      "Bindex",
    );
    assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(buf);
    assert.ok(doc.getPageCount() >= 3);
  });

  it("renders a load sheet with no lines", async () => {
    const buf = await pdf.renderLoadSheetPdf(
      {
        title: "Truck 1",
        code: "SHP-7F3K2A",
        details: ["Job JOB-7F3K2A Level 3 move"],
        facts: [
          ["Status", "planned"],
          ["Volume", "12 m³"],
        ],
        seals: ["S-1001", "S-1002"],
        lines: [],
        summary: "0 pieces",
      },
      new Date(),
      "Not/AZone",
      "Bindex",
    );
    assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  });

  it("renders the manifest spreadsheet with group rows", async () => {
    const buf = await xlsx.renderManifestXlsx("JOB-1 Move", "Relocation", [
      {
        group: "Level 3",
        index: 1,
        itemName: "Chair",
        brandModel: null,
        assetCode: "INV-1",
        unit: null,
        serial: null,
        crate: "C1",
        origin: "HQ",
        destination: "New HQ",
        desk: "5.12",
        floor: "3",
        department: "Finance",
        shipment: null,
        stage: "Packed",
        packed: true,
        loaded: false,
        delivered: false,
        placed: false,
        notes: null,
      },
    ]);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Manifest")!;
    assert.equal(ws.getCell("A4").value, "Level 3");
    assert.equal(ws.getCell("B5").value, "Chair");
    assert.equal(ws.getCell("O5").value, "✓");
  });
});
