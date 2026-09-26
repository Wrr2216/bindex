import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { chatReply, startAiStub, type AiStub, type CapturedChat, type StubResponse } from "./media-ai-core-stub";
import { RECEIPT_ELECTRONICS, VALUATION_GOOD } from "./valuation-fixtures";

// Valuations, receipts, declarations, warranty and service, the report and the
// backup, against a real Postgres and the local AI stand-in. CI has no
// database, so this runs only when TEST_DATABASE_URL names a scratch database
// (it is migrated and written to):
//
//   createdb bindex_valuation_test
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_valuation_test \
//     pnpm --filter bindex-server exec tsx --test tests/valuation-db.test.ts

const url = process.env.TEST_DATABASE_URL;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-valuation-data-"));

type Valuation = typeof import("../src/services/valuation");
type Media = typeof import("../src/services/media-ai-core");
type Items = typeof import("../src/services/items");
type Units = typeof import("../src/services/units");
type Backup = typeof import("../src/services/backup");
type Client = typeof import("../src/db/client");
type PdfImages = typeof import("../src/services/valuation/pdfImages");
let v: Valuation;
let media: Media;
let items: Items;
let units: Units;
let backup: Backup;
let pool: Client["pool"];
let pdfImages: PdfImages;

let stub: AiStub;
let onChat: (c: CapturedChat) => StubResponse = () => chatReply("{}");

// Unique per run, so the suite can run again against the same scratch database.
const RUN = Date.now().toString(16).slice(-6).toUpperCase();
const LAPTOP_SERIAL = `7XK${RUN}`;
const USER = "local:valuation-test";

function photo(color = "#446"): Buffer {
  const c = createCanvas(320, 240);
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 320, 240);
  return c.toBuffer("image/jpeg");
}

async function receiptPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("MICRO CENTER  03/02/2024", { x: 20, y: 360, size: 12, font });
  page.drawText("DELL LAT 5440   1299.99", { x: 20, y: 330, size: 12, font });
  return Buffer.from(await doc.save());
}

async function auditTypes(since: number): Promise<string[]> {
  const { rows } = await pool.query<{ type: string }>(`SELECT type FROM audit_log WHERE id > $1 ORDER BY id`, [since]);
  return rows.map((r) => r.type);
}

async function auditHead(): Promise<number> {
  const { rows } = await pool.query<{ id: string | null }>(`SELECT max(id)::text AS id FROM audit_log`);
  return Number(rows[0]?.id ?? 0);
}

describe("valuation with Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let locationId: string;
  let roomId: string;
  let laptopId: string;
  let chairId: string;
  let monitorsId: string;
  let unitA: string;
  let unitB: string;

  before(async () => {
    stub = await startAiStub({ chat: (c) => onChat(c) });
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
    process.env.DATA_DIR = dataDir;
    process.env.LOG_LEVEL = "error";
    process.env.LLM_BASE_URL = stub.url;
    process.env.LLM_API_KEY = "stub-key";
    process.env.LLM_VISION_MODEL = "vision-model";
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    v = await import("../src/services/valuation");
    media = await import("../src/services/media-ai-core");
    items = await import("../src/services/items");
    units = await import("../src/services/units");
    backup = await import("../src/services/backup");
    pdfImages = await import("../src/services/valuation/pdfImages");
    ({ pool } = await import("../src/db/client"));
    const config = await import("../src/services/config");
    await config.seedConfig();
    await v.updateValuationSettings({ highValueThresholdCents: 100_000, warrantyAlertDays: 30, notify: false });

    const loc = await pool.query<{ id: string }>(`INSERT INTO locations (name) VALUES ($1) RETURNING id`, [`Office ${RUN}`]);
    locationId = loc.rows[0]!.id;
    const room = await pool.query<{ id: string }>(`INSERT INTO locations (name, parent_id) VALUES ($1, $2) RETURNING id`, [`Room ${RUN}`, locationId]);
    roomId = room.rows[0]!.id;
    laptopId = (
      await items.createItem(
        { name: `Laptop ${RUN}`, brand: "Dell", model: "Latitude 5440", category: "Laptop", locationId: roomId, identifiers: [{ type: "serial", value: LAPTOP_SERIAL }] },
        USER,
      )
    ).id;
    chairId = (await items.createItem({ name: `Aeron office chair ${RUN}`, brand: "Herman Miller", category: "Furniture", locationId }, USER)).id;
    monitorsId = (await items.createItem({ name: `27in monitor ${RUN}`, brand: "Dell", model: `P27${RUN}`, locationId: roomId }, USER)).id;
    unitA = (await units.addUnit(monitorsId, { label: "Desk 1", serial: `CNA${RUN}` })).id;
    unitB = (await units.addUnit(monitorsId, { label: "Desk 2", serial: `CNB${RUN}` })).id;
  });

  after(async () => {
    await stub?.close();
    await pool?.end();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("estimates a value from the item's photos, and records it with history", async () => {
    const shot = await media.saveAttachment({ ownerType: "item", ownerId: chairId, bytes: photo(), mime: "image/jpeg", stage: "valuation", createdBy: USER });
    onChat = () => chatReply(JSON.stringify(VALUATION_GOOD));
    const result = await v.estimateValue({ itemId: chairId, attachmentIds: [shot.id] }, USER);
    assert.equal(result.available, true);
    assert.equal(result.found, true);
    assert.equal(result.estimate?.estimatedValue?.suggestedCents, 65000);
    const sent = stub.chats.at(-1)!.body as { model: string; messages: { content: unknown }[] };
    assert.equal(sent.model, "vision-model");
    assert.match(JSON.stringify(sent.messages[1]!.content), /data:image\/jpeg;base64/);

    // Photos of another item are refused.
    const stray = await media.saveAttachment({ ownerType: "item", ownerId: laptopId, bytes: photo(), mime: "image/jpeg", createdBy: USER });
    await assert.rejects(v.estimateValue({ itemId: chairId, attachmentIds: [stray.id] }, USER), /photos attached to this item/);

    const head = await auditHead();
    const first = await v.recordValuation(
      {
        itemId: chairId,
        valueCents: 65000,
        source: "ai",
        basis: result.estimate!.estimatedValue!.basis,
        confidence: result.estimate!.confidence,
        lowCents: 55000,
        highCents: 75000,
        details: { ...result.estimate, attachmentIds: result.attachmentIds },
        apply: { model: "Aeron Size B" },
      },
      USER,
    );
    assert.equal(first.previousCents, null);
    const second = await v.recordValuation({ itemId: chairId, valueCents: 120000, source: "appraisal", basis: "Dealer appraisal" }, USER);
    assert.equal(second.previousCents, 65000);

    const history = await v.listValuations(chairId);
    assert.deepEqual(history.map((h) => [h.source, h.valueCents]), [["appraisal", 120000], ["ai", 65000]]);
    const chair = await items.getItemDetail(chairId);
    assert.equal(chair.valueCents, 120000);
    assert.equal(chair.model, "Aeron Size B");
    assert.ok(chair.events.some((e) => e.detail.source === "valuation"));

    // The second value crossed the 1,000.00 threshold.
    const types = await auditTypes(head);
    assert.deepEqual(types.filter((t) => t.startsWith("valuation.")), ["valuation.recorded", "valuation.recorded", "valuation.high_value_marked"]);
  });

  it("values units one by one, rolling up to the item, and refuses the item itself", async () => {
    await v.recordValuation({ itemId: monitorsId, unitId: unitA, valueCents: 30000, source: "manual" }, USER);
    await v.recordValuation({ itemId: monitorsId, unitId: unitB, valueCents: 32000, source: "manual" }, USER);
    assert.equal((await items.getItemDetail(monitorsId)).valueCents, 62000);
    await assert.rejects(v.recordValuation({ itemId: monitorsId, valueCents: 1, source: "manual" }, USER), /Record the value on a unit/);
    await assert.rejects(v.recordValuation({ itemId: chairId, unitId: unitA, valueCents: 1, source: "manual" }, USER), /belongs to another item/);
    await assert.rejects(v.recordValuation({ itemId: chairId, valueCents: 1, source: "manual", valuedOn: "2999-01-01" }, USER), /future/);
  });

  it("reads a receipt, proposes matches, and saves the purchase on each item when confirmed", async () => {
    const receipt = await v.createReceipt({}, USER);
    await media.saveAttachment({ ownerType: "receipt", ownerId: receipt.id, bytes: photo("#fff"), mime: "image/jpeg", createdBy: USER });
    const reply = structuredClone(RECEIPT_ELECTRONICS);
    reply.lines[0]!.serial = `S/N: ${LAPTOP_SERIAL}`;
    reply.lines[1]!.serial = `CNB${RUN}`;
    reply.lines[2]!.description = `USB-C CABLE ${RUN}`;
    onChat = () => chatReply(JSON.stringify(reply));
    const read = await v.readReceipt(receipt.id, USER);
    assert.equal(read.found, true);
    assert.equal(read.receipt.vendor, "Micro Center #041");
    assert.equal(read.receipt.purchaseDate, "2024-03-02");
    assert.equal(read.receipt.lines.length, 4);

    const proposals = await v.receiptMatches(receipt.id);
    assert.equal(proposals[0]!.suggested?.itemId, laptopId);
    assert.equal(proposals[1]!.suggested?.unitId, unitB);
    // Nothing of ours is a cable (earlier runs may have left cables behind).
    assert.ok(![laptopId, monitorsId, chairId].includes(proposals[2]!.suggested?.itemId ?? ""));

    const lines = read.receipt.lines;
    const head = await auditHead();
    const confirmed = await v.confirmReceipt(
      receipt.id,
      [
        { lineId: lines[0]!.id, itemId: laptopId, setValue: true },
        { lineId: lines[1]!.id, itemId: monitorsId, unitId: unitB, setValue: false },
        { lineId: lines[2]!.id, create: true, setValue: true },
        // The protection plan goes to the laptop too: its warranty, not its price.
        { lineId: lines[3]!.id, itemId: laptopId },
      ],
      USER,
    );
    assert.ok(confirmed.notes.some((n) => /Lines 1 and 4 are the same record/.test(n)));
    assert.equal(confirmed.receipt.status, "confirmed");
    assert.equal(confirmed.matched.length, 4);
    const created = confirmed.matched.find((m) => m.created)!;
    const cable = await items.getItemDetail(created.itemId);
    assert.deepEqual([cable.name, cable.valueCents], [`USB-C CABLE ${RUN}`, 1299]);

    const laptopProfile = await v.getProfile(laptopId, null);
    assert.equal(laptopProfile?.purchaseDate, "2024-03-02");
    assert.equal(laptopProfile?.purchaseCents, 129999);
    assert.equal(laptopProfile?.vendor, "Micro Center #041");
    assert.equal(laptopProfile?.receiptId, receipt.id);
    assert.equal(laptopProfile?.warrantyEnds, "2026-03-02");
    const unitProfile = await v.getProfile(monitorsId, unitB);
    assert.equal(unitProfile?.purchaseCents, 32900);
    assert.equal((await items.getItemDetail(laptopId)).valueCents, 129999);
    assert.equal((await v.listValuations(laptopId))[0]!.source, "receipt");
    assert.ok((await auditTypes(head)).includes("receipt.confirmed"));

    assert.deepEqual((await v.receiptsForItem(laptopId)).map((r) => r.id), [receipt.id]);
    await assert.rejects(v.updateReceipt(receipt.id, { vendor: "Changed" }), /confirmed/);
    await assert.rejects(v.confirmReceipt(receipt.id, [], USER), /already confirmed/);
    await assert.rejects(v.deleteReceipt(receipt.id, false), /administrator/);
    await items.deleteItem(created.itemId, USER);
  });

  it("draws a PDF receipt as images when pdftoppm is available", async (t) => {
    if (!pdfImages.pdfReadingAvailable()) return t.skip("pdftoppm is not installed here");
    const pages = await pdfImages.pdfToImages(await receiptPdf());
    assert.equal(pages?.length, 1);
    assert.equal(pages![0]!.subarray(1, 4).toString("latin1"), "PNG");

    const receipt = await v.createReceipt({}, USER);
    await media.saveAttachment({ ownerType: "receipt", ownerId: receipt.id, bytes: await receiptPdf(), mime: "application/pdf", createdBy: USER });
    onChat = () => chatReply(JSON.stringify(RECEIPT_ELECTRONICS));
    const before = stub.chats.length;
    const read = await v.readReceipt(receipt.id, USER);
    assert.equal(read.found, true);
    const sent = stub.chats[before]!.body as { messages: { content: { type: string }[] }[] };
    assert.equal(sent.messages[1]!.content.filter((c) => c.type === "image_url").length, 1);
    await v.deleteReceipt(receipt.id, false);
    assert.equal((await media.listAttachments("receipt", receipt.id)).length, 0);
  });

  it("builds a declaration from a scope, signs it, verifies it and notices tampering", async () => {
    const head = await auditHead();
    const decl = await v.createDeclaration({ scope: "location", scopeId: locationId, populate: true }, USER);
    assert.match(decl.code, /^HVI-\d{5,}$/);
    // At or over 1,000.00: the laptop (1,299.99) and the chair (1,200.00); the monitors are under.
    assert.deepEqual(new Set(decl.lines.map((l) => l.itemId)), new Set([laptopId, chairId]));
    assert.equal(decl.lines.find((l) => l.itemId === chairId)?.materials, "aluminium, pellicle mesh");

    let d = await v.addDeclarationLines(decl.id, [{ itemId: monitorsId }]);
    assert.equal(d.lines.length, 4);
    const monitorLine = d.lines.find((l) => l.unitId === unitA)!;
    d = await v.updateDeclarationLine(decl.id, monitorLine.id, { declaredCents: 25000 });
    assert.equal(d.lines.find((l) => l.id === monitorLine.id)?.valueSource, "manual");
    d = await v.removeDeclarationLine(decl.id, d.lines.find((l) => l.unitId === unitB)!.id);
    assert.deepEqual(d.lines.map((l) => l.position), [1, 2, 3]);

    // A signature over stale content is refused.
    const stale = await media.sign({
      ownerType: "hv_declaration", ownerId: decl.id, signerName: "Dana Ruiz", statement: d.statement,
      content: { ...d.signingContent, totalCents: 1 },
    });
    await assert.rejects(v.markDeclarationSigned(decl.id, stale.id, USER), /changed while it was being signed/);

    const png = createCanvas(200, 60).toBuffer("image/png");
    const sig = await media.sign({
      ownerType: "hv_declaration", ownerId: decl.id, signerName: "Dana Ruiz", signerRole: "Facility manager",
      statement: d.statement, content: JSON.parse(JSON.stringify(d.signingContent)), image: png, signedByUser: USER,
    });
    const signed = await v.markDeclarationSigned(decl.id, sig.id, USER);
    assert.equal(signed.status, "signed");
    assert.equal(signed.verification?.valid, true);
    assert.ok(signed.auditEntryId);
    assert.deepEqual((await auditTypes(head)).filter((t) => t.startsWith("declaration.")), ["declaration.created", "declaration.signed"]);

    await assert.rejects(v.updateDeclarationLine(decl.id, monitorLine.id, { declaredCents: 1 }), /is signed/);
    await assert.rejects(v.deleteDeclaration(decl.id, USER), /kept as a record/);
    await assert.rejects(v.markDeclarationSigned(decl.id, sig.id, USER), /is signed/);

    // Changing the item afterwards does not touch the declaration's snapshot.
    await v.recordValuation({ itemId: chairId, valueCents: 1, source: "manual" }, USER);
    assert.equal((await v.verifyDeclaration(decl.id)).valid, true);

    const pdf = await v.declarationPdf(await v.getDeclaration(decl.id), "America/Chicago");
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal((await PDFDocument.load(pdf)).getPageCount() >= 1, true);

    // Someone edits a declared value straight in the database.
    await pool.query(`UPDATE hv_declaration_lines SET declared_cents = declared_cents + 100 WHERE id = $1`, [monitorLine.id]);
    const check = await v.verifyDeclaration(decl.id);
    assert.deepEqual([check.valid, check.reason], [false, "content_changed"]);
  });

  it("keeps warranty and service, and announces what falls due once", async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await v.upsertProfile(laptopId, null, { warrantyEnds: soon, warrantyProvider: "Dell ProSupport", usageHours: 100 });
    await assert.rejects(v.upsertProfile(laptopId, null, { purchaseDate: "2999-01-01" }), /future/);
    await assert.rejects(v.upsertProfile(laptopId, unitA, {}), /belongs to another item/);

    const plan = await v.createServicePlan({ itemId: laptopId, name: "Battery check", intervalDays: 30, lastDoneAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }, USER);
    assert.equal(plan.status.state, "overdue");
    const hours = await v.createServicePlan({ itemId: laptopId, name: "Fan clean", intervalHours: 50 }, USER);
    assert.equal(hours.startsHours, 100);
    await assert.rejects(v.createServicePlan({ itemId: laptopId, name: "Nothing" }, USER), /interval/);

    const head = await auditHead();
    const first = await v.runDigest();
    assert.ok(first.announced >= 2);
    const types = await auditTypes(head);
    assert.ok(types.includes("warranty.expiring"));
    assert.ok(types.includes("service.due"));
    assert.equal((await v.runDigest()).announced, 0);

    // Doing the work moves the due point; hour plans need a meter reading.
    await assert.rejects(v.logService(hours.id, {}, USER), /hour-meter reading/);
    const done = await v.logService(plan.id, { notes: "OK" }, USER);
    assert.equal(done.status.state, "ok");
    const meter = await v.logService(hours.id, { hours: 148 }, USER);
    assert.equal(meter.status.dueHours, 198);
    assert.equal((await v.getProfile(laptopId, null))?.usageHours, 148);
    assert.equal((await v.listServiceRecords(laptopId)).length, 2);

    const due = await v.listDue();
    assert.ok(due.warranty.some((w) => w.itemId === laptopId && !w.isNew));
  });

  it("reports by location with depreciation, as PDF and as a workbook", async () => {
    await v.updateValuationSettings({ depreciation: { defaultLifeYears: 5, lifeYearsByCategory: { Laptop: 4 } } });
    const report = await v.buildReport({ locationId, groupBy: "location", asOf: "2026-03-02" });
    const all = report.groups.flatMap((g) => g.rows);
    assert.ok(report.groups.some((g) => g.name === `Room ${RUN}`));
    const laptop = all.find((r) => r.itemId === laptopId)!;
    assert.equal(laptop.lifeYears, 4);
    assert.equal(laptop.serials[0], LAPTOP_SERIAL);
    // Two of four years: half the price paid is left.
    assert.ok(Math.abs(laptop.depreciation!.bookCents - 65000) < 100, String(laptop.depreciation!.bookCents));
    assert.equal(all.filter((r) => r.itemId === monitorsId).length, 2);

    const high = await v.buildReport({ locationId, highValueOnly: true });
    assert.ok(high.groups.flatMap((g) => g.rows).every((r) => r.highValue));

    const pdf = await v.reportPdf(report, "UTC");
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    const xlsx = await v.reportXlsx(report, "https://inventory.example.com");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ExcelJS.Buffer);
    const sheet = wb.getWorksheet("Records")!;
    assert.equal(sheet.rowCount, all.length + 1);
    assert.equal(wb.getWorksheet("Summary")!.getRow(1).getCell(1).value, "Group");
  });

  it("round-trips through the JSON backup, and an older file leaves valuations alone", async () => {
    const snapshot = await backup.buildBackup();
    assert.ok(snapshot.data.valuations.length > 0);
    assert.ok(snapshot.data.hv_declarations.length > 0);
    const before = (await v.listValuations(chairId)).length;

    await backup.restoreBackup(JSON.parse(JSON.stringify(snapshot)));
    assert.equal((await v.listValuations(chairId)).length, before);
    assert.equal((await v.getProfile(laptopId, null))?.vendor, "Micro Center #041");

    const old = JSON.parse(JSON.stringify(snapshot)) as { data: Record<string, unknown> };
    for (const t of ["valuations", "valuation_profiles", "service_plans", "service_records", "receipts", "receipt_lines", "hv_declarations", "hv_declaration_lines"]) {
      delete old.data[t];
    }
    await backup.restoreBackup(old);
    assert.equal((await v.listValuations(chairId)).length, before);
    assert.equal((await v.listServicePlans(laptopId)).length, 2);

    // A new declaration after a restore does not collide with a restored number.
    const next = await v.createDeclaration({ scope: "job", scopeLabel: `JOB-${RUN}` }, USER);
    assert.match(next.code, /^HVI-/);
    await v.deleteDeclaration(next.id, USER);
  });
});
