import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
// Pure rendering: nothing here reads the environment, so static imports are safe.
import { CLASS_LABEL, renderPdf, renderXlsx, type ReportData, type ReportLine } from "../src/services/register-reconcile/report";
import { CLASS_ORDER } from "../src/services/register-reconcile/classify";

const line = (n: number, extra: Partial<ReportLine> = {}): ReportLine => ({
  rowNumber: n,
  assetTag: `AT-${n}`,
  serial: null,
  registerName: `Thing ${n}`,
  registerLocation: "Warehouse > Aisle 1",
  assetCode: `INV-${String(n).padStart(6, "0")}`,
  itemName: `Thing ${n}`,
  location: "Warehouse / Aisle 2",
  details: "Matched on asset tag.",
  status: "Open",
  ...extra,
});

function data(lines: number): ReportData {
  const counts = Object.fromEntries(
    CLASS_ORDER.map((c) => [c, { total: 0, open: 0, resolved: 0, ignored: 0 }]),
  ) as ReportData["counts"];
  counts.misplaced = { total: lines, open: lines - 1, resolved: 1, ignored: 0 };
  return {
    appName: "Bindex",
    itemTerm: "Asset",
    locationTerm: "Room",
    importName: "Q3 register — Łódź 倉庫 🚚",
    fileName: "q3.xlsx",
    runAt: new Date("2026-09-26T10:00:00Z"),
    scopeLabel: "Everything",
    rowCount: lines,
    counts,
    sections: CLASS_ORDER.map((cls) => ({
      cls,
      lines: cls === "misplaced" ? Array.from({ length: lines }, (_, i) => line(i + 2, { registerName: "Kaffeemühle — ő ł 机" })) : [],
    })),
    registerEdits: [{ rowNumber: 2, assetTag: "AT-2", field: "Location", from: "Aisle 1", to: "Warehouse / Aisle 2" }],
  };
}

describe("renderXlsx", () => {
  it("writes a summary, one sheet per class and the register updates", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await renderXlsx(data(3))) as unknown as ArrayBuffer);
    assert.deepEqual(
      wb.worksheets.map((w) => w.name),
      ["Summary", ...CLASS_ORDER.map((c) => CLASS_LABEL[c]), "Register updates"],
    );
    const misplaced = wb.getWorksheet(CLASS_LABEL.misplaced)!;
    assert.equal(misplaced.getRow(1).getCell(7).value, "Asset"); // the instance's own word
    assert.equal(misplaced.actualRowCount, 4);
    assert.equal(misplaced.getRow(2).getCell(2).value, "AT-2");
    const summary = wb.getWorksheet("Summary")!;
    const row = summary.getRows(1, summary.rowCount)!.find((r) => r.getCell(1).value === "Misplaced")!;
    assert.deepEqual([row.getCell(2).value, row.getCell(3).value, row.getCell(4).value], [3, 2, 1]);
  });
});

describe("renderPdf", () => {
  it("renders text the standard fonts cannot encode instead of failing", async () => {
    const pdf = await renderPdf(data(2));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    const doc = await PDFDocument.load(pdf);
    assert.ok(doc.getPageCount() <= 2);
    assert.match(doc.getTitle() ?? "", /Q3 register/);
  });

  it("summarises a long list of clean matches instead of printing it", async () => {
    const many = data(2);
    many.sections.find((s) => s.cls === "matched")!.lines = Array.from({ length: 1000 }, (_, i) => line(i + 2));
    const doc = await PDFDocument.load(await renderPdf(many));
    assert.ok(doc.getPageCount() <= 2, `got ${doc.getPageCount()} pages`);
  });

  it("continues long sections onto more pages", async () => {
    const short = await PDFDocument.load(await renderPdf(data(2)));
    const long = await PDFDocument.load(await renderPdf(data(200)));
    assert.ok(long.getPageCount() >= short.getPageCount() + 4, `got ${long.getPageCount()} pages`);
  });
});
