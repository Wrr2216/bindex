import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import type { ReportInput } from "../src/services/teardown/report";

// The printable teardown report and the hardware bag labels, from plain data.

type Report = typeof import("../src/services/teardown/report");
let report: Report;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  report = await import("../src/services/teardown/report");
});

function jpeg(w: number, h: number): Buffer {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#468";
  ctx.fillRect(0, 0, w, h);
  return c.toBuffer("image/jpeg");
}

const baseInput = (): ReportInput => ({
  appName: "Bindex",
  printedAt: new Date("2026-09-26T15:00:00Z"),
  timeZone: "America/Chicago",
  guideUrl: "https://inventory.example.com/teardown/0b7c4a64-1d1e-4a57-9d1b-6a3f0f4c2d11",
  title: "Lab workstation teardown",
  itemName: "Lab workstation",
  itemCode: "INV-4F2K1B",
  unitName: null,
  durationSec: 58,
  notes: "Moving to building C, room 204.",
  steps: [
    { n: 1, title: "Disconnect external cables", instruction: "Unplug the power cord and both network cables.", start: 5.2, end: 12.8, callout: null, picture: jpeg(640, 480) },
    { n: 2, title: "Remove the top cover", instruction: "Remove the four M4 screws, then slide the cover off.", start: 12.8, end: 28, callout: "The fan cable is still attached — unplug it first", picture: null },
    { n: 3, title: "Remove the motherboard", instruction: "Unscrew the six standoff screws; lift the board by its edges.", start: 47.5, end: 58, callout: "10 screws total", picture: jpeg(480, 640) },
  ],
  parts: [
    { name: "Power cord", kind: "cable" as const, qty: 1, stepN: 1, note: null, reassembled: true },
    { name: "M4 screw", kind: "hardware" as const, qty: 4, stepN: 2, note: "black, 6 mm", reassembled: false },
    { name: "Standoff screw", kind: "hardware" as const, qty: 6, stepN: 3, note: null, reassembled: false },
    { name: "Thermal pad", kind: "other" as const, qty: 1, stepN: null, note: null, reassembled: false },
  ],
});

describe("pdfText", () => {
  it("keeps Windows-1252 text and replaces what the standard fonts cannot draw", () => {
    assert.equal(report.pdfText("4 × M6 — “bolts” · 5 €"), "4 × M6 — “bolts” · 5 €");
    assert.equal(report.pdfText("Schraube lösen, café"), "Schraube lösen, café");
    assert.equal(report.pdfText("Čeština → 2 ≥ 1"), "Ceština -> 2 >= 1");
    assert.equal(report.pdfText("ネジ 🔩\ttab\nline"), "?? ? tab line");
  });
});

describe("teardownReportPdf", () => {
  it("renders steps, pictures, callouts, parts and the reassembly list", async () => {
    const pdf = await report.teardownReportPdf(baseInput());
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getTitle(), "Lab workstation teardown");
    assert.ok(doc.getPageCount() >= 1);
  });

  it("paginates a long guide and survives text it cannot draw", async () => {
    const input = baseInput();
    input.steps = Array.from({ length: 60 }, (_, i) => ({
      n: i + 1,
      title: `Step ${i + 1}: ネジを外す 🔧 ${"long words ".repeat(12)}`,
      instruction: "Undo the fasteners ".repeat(30),
      start: i * 10,
      end: i * 10 + 9,
      callout: i % 7 === 0 ? "Watch the ribbon cable ".repeat(5) : null,
      picture: i % 10 === 0 ? jpeg(320, 240) : null,
    }));
    input.parts = Array.from({ length: 120 }, (_, i) => ({
      name: `Part ${i} ${"x".repeat(i % 3 ? 5 : 90)}`,
      kind: "hardware" as const,
      qty: i + 1,
      stepN: (i % 60) + 1,
      note: null,
      reassembled: i % 2 === 0,
    }));
    const doc = await PDFDocument.load(await report.teardownReportPdf(input));
    assert.ok(doc.getPageCount() > 5, `pages: ${doc.getPageCount()}`);
  });

  it("prints an empty guide", async () => {
    const input = { ...baseInput(), steps: [], parts: [], notes: null, durationSec: null, itemName: null, itemCode: null };
    const doc = await PDFDocument.load(await report.teardownReportPdf(input));
    assert.equal(doc.getPageCount(), 1);
  });

  it("skips a picture that is not a JPEG instead of failing", async () => {
    const input = baseInput();
    input.steps[0]!.picture = Buffer.from("not a jpeg");
    await PDFDocument.load(await report.teardownReportPdf(input));
  });
});

describe("bagLabels", () => {
  const input = {
    guideId: "0b7c4a64-1d1e-4a57-9d1b-6a3f0f4c2d11",
    baseUrl: "https://inventory.example.com/",
    itemName: "Lab workstation",
    unitName: "Unit 2",
    code: "INV-4F2K1B",
    steps: [
      { n: 1, title: "Cables" },
      { n: 2, title: "Cover" },
      { n: 3, title: "Board" },
    ],
    parts: [
      { name: "Power cord", kind: "cable" as const, qty: 1, stepN: 1 },
      { name: "M4 screw", kind: "hardware" as const, qty: 4, stepN: 2 },
      { name: "Washer", kind: "hardware" as const, qty: 1, stepN: 2 },
      { name: "Standoff screw", kind: "hardware" as const, qty: 6, stepN: 3 },
      { name: "Cable tie", kind: "hardware" as const, qty: 3, stepN: null },
    ],
  };

  it("makes one label per step with hardware, plus loose hardware", () => {
    const labels = report.bagLabels(input);
    assert.deepEqual(labels, [
      {
        name: "Step 2: 4 × M4 screw, Washer",
        sub: "Lab workstation · Unit 2",
        code: "INV-4F2K1B",
        url: "https://inventory.example.com/teardown/0b7c4a64-1d1e-4a57-9d1b-6a3f0f4c2d11?step=2",
      },
      {
        name: "Step 3: 6 × Standoff screw",
        sub: "Lab workstation · Unit 2",
        code: "INV-4F2K1B",
        url: "https://inventory.example.com/teardown/0b7c4a64-1d1e-4a57-9d1b-6a3f0f4c2d11?step=3",
      },
      {
        name: "Hardware: 3 × Cable tie",
        sub: "Lab workstation · Unit 2",
        code: "INV-4F2K1B",
        url: "https://inventory.example.com/teardown/0b7c4a64-1d1e-4a57-9d1b-6a3f0f4c2d11",
      },
    ]);
  });

  it("prints only the steps asked for (0 is loose hardware)", () => {
    assert.deepEqual(report.bagLabels(input, [3]).map((l) => l.name), ["Step 3: 6 × Standoff screw"]);
    assert.deepEqual(report.bagLabels(input, [0]).map((l) => l.name), ["Hardware: 3 × Cable tie"]);
    assert.deepEqual(report.bagLabels(input, [1]), []);
  });

  it("renders through the label printer pipeline", async () => {
    const { labelPdf } = await import("../src/services/printing");
    const doc = await PDFDocument.load(await labelPdf(report.bagLabels(input)));
    assert.equal(doc.getPageCount(), 3);
  });
});
