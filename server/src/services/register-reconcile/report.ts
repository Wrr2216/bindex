import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ReconcileClass } from "../../db/tables/register-reconcile";
import { CLASS_ORDER } from "./classify";

/**
 * The discrepancy report: summary counts, then one section per class. Pure
 * rendering over a prepared ReportData, so the layout is tested without a
 * database.
 */

export const CLASS_LABEL: Record<ReconcileClass, string> = {
  matched: "Matched",
  misplaced: "Misplaced",
  conflict: "Field conflicts",
  register_only: "Only in the register",
  bindex_only: "Not in the register",
  duplicate: "Duplicates",
  flagged_missing: "Flagged missing",
};

export const CLASS_HELP: Record<ReconcileClass, string> = {
  matched: "Matched on a key, with nothing to fix.",
  misplaced: "The register puts it somewhere else.",
  conflict: "Serial, tag, model or cost disagree.",
  register_only: "In the register, not found here.",
  bindex_only: "Here, but not in the register.",
  duplicate: "Two rows, or two records here, claim the same key.",
  flagged_missing: "Flagged missing here.",
};

export type ReportLine = {
  rowNumber: number | null;
  assetTag: string | null;
  serial: string | null;
  registerName: string | null;
  registerLocation: string | null;
  assetCode: string | null;
  itemName: string | null;
  location: string | null;
  details: string;
  status: string;
};

export type ReportData = {
  appName: string;
  itemTerm: string;
  locationTerm: string;
  importName: string;
  fileName: string | null;
  runAt: Date;
  scopeLabel: string;
  rowCount: number;
  counts: Record<ReconcileClass, { total: number; open: number; resolved: number; ignored: number }>;
  sections: { cls: ReconcileClass; lines: ReportLine[] }[];
  registerEdits: { rowNumber: number; assetTag: string | null; field: string; from: string | null; to: string | null }[];
};

const COLUMNS = (d: ReportData) =>
  [
    { key: "rowNumber", header: "Row", width: 7 },
    { key: "assetTag", header: "Register tag", width: 16 },
    { key: "serial", header: "Register serial", width: 18 },
    { key: "registerName", header: "Register name", width: 28 },
    { key: "registerLocation", header: "Register location", width: 24 },
    { key: "assetCode", header: "Printed code", width: 14 },
    { key: "itemName", header: d.itemTerm, width: 28 },
    { key: "location", header: d.locationTerm, width: 28 },
    { key: "details", header: "Details", width: 50 },
    { key: "status", header: "Status", width: 24 },
  ] as const;

function sheetName(label: string): string {
  return label.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
}

export async function renderXlsx(d: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = d.appName;
  wb.created = d.runAt;

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { key: "a", width: 28 },
    { key: "b", width: 12 },
    { key: "c", width: 12 },
    { key: "d", width: 12 },
    { key: "e", width: 12 },
  ];
  summary.addRow(["Register reconciliation"]).font = { bold: true, size: 14 };
  summary.addRow(["Register", d.importName]);
  if (d.fileName) summary.addRow(["File", d.fileName]);
  summary.addRow(["Rows", d.rowCount]);
  summary.addRow(["Scope", d.scopeLabel]);
  summary.addRow(["Run at", d.runAt]);
  summary.addRow([]);
  summary.addRow(["Class", "Total", "Open", "Resolved", "Ignored"]).font = { bold: true };
  for (const c of CLASS_ORDER) {
    const n = d.counts[c];
    summary.addRow([CLASS_LABEL[c], n.total, n.open, n.resolved, n.ignored]);
  }

  for (const section of d.sections) {
    const ws = wb.addWorksheet(sheetName(CLASS_LABEL[section.cls]));
    ws.columns = COLUMNS(d).map((c) => ({ key: c.key, header: c.header, width: c.width }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const line of section.lines) ws.addRow(line);
    ws.getColumn("details").alignment = { wrapText: true, vertical: "top" };
  }

  if (d.registerEdits.length) {
    const ws = wb.addWorksheet("Register updates");
    ws.columns = [
      { key: "rowNumber", header: "Row", width: 7 },
      { key: "assetTag", header: "Register tag", width: 18 },
      { key: "field", header: "Field", width: 16 },
      { key: "from", header: "Register had", width: 30 },
      { key: "to", header: "Change to", width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const e of d.registerEdits) ws.addRow(e);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- PDF --------------------------------------------------------------------

// US Letter, landscape: the tables are wide.
const PAGE_W = 792;
const PAGE_H = 612;
const MARGIN = 36;
const RIGHT = PAGE_W - MARGIN;
const BOTTOM = MARGIN + 20;
const SIZE = 7.5;
const LEAD = 9.5;
export const PDF_MATCHED_LIMIT = 200;

const ink = rgb(0.07, 0.09, 0.13);
const muted = rgb(0.42, 0.46, 0.52);
const rule = rgb(0.8, 0.83, 0.87);

// Widths in points; they sum to the printable width.
const PDF_COLS: { key: keyof ReportLine; width: number }[] = [
  { key: "rowNumber", width: 30 },
  { key: "assetTag", width: 78 },
  { key: "registerName", width: 104 },
  { key: "registerLocation", width: 84 },
  { key: "assetCode", width: 62 },
  { key: "itemName", width: 96 },
  { key: "location", width: 84 },
  { key: "details", width: 124 },
  { key: "status", width: 58 },
];

/**
 * The standard PDF fonts only cover Windows-1252. Anything else is reduced to
 * its base letter where it has one ("ő" becomes "o") and replaced with "?"
 * where it does not, rather than failing the whole report.
 */
function makeSanitizer(font: PDFFont): (text: string) => string {
  const supported = new Set(font.getCharacterSet());
  return (text) => {
    let out = "";
    for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
      const cp = ch.codePointAt(0)!;
      if (supported.has(cp)) {
        out += ch;
        continue;
      }
      const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
      out += [...base].every((c) => supported.has(c.codePointAt(0)!)) && base ? base : "?";
    }
    return out;
  };
}

function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = (word: string) => {
    const cand = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(cand, size) > max) {
      lines.push(line);
      line = word;
    } else {
      line = cand;
    }
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (font.widthOfTextAtSize(word, size) <= max) {
      push(word);
      continue;
    }
    // A token longer than the column (an EPC, a URL) is broken by character.
    let part = "";
    for (const ch of word) {
      if (part && font.widthOfTextAtSize(part + ch, size) > max) {
        push(part);
        part = ch;
      } else part += ch;
    }
    if (part) push(part);
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export async function renderPdf(d: ReportData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Register reconciliation: ${d.importName}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = makeSanitizer(font);
  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const text = (s: string, x: number, size: number, f = font, color = ink) =>
    page.drawText(clean(s), { x, y, size, font: f, color });
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const hr = (thickness = 0.5) =>
    page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT, y }, thickness, color: rule });

  text("REGISTER RECONCILIATION", MARGIN, 9, bold, muted);
  y -= 22;
  for (const line of wrap(clean(d.importName), bold, 18, RIGHT - MARGIN)) {
    text(line, MARGIN, 18, bold);
    y -= 20;
  }
  const meta = [
    d.fileName,
    `${d.rowCount} register row${d.rowCount === 1 ? "" : "s"}`,
    `Scope: ${d.scopeLabel}`,
    `Run ${d.runAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
  ].filter(Boolean) as string[];
  text(meta.join("  ·  "), MARGIN, 9, font, muted);
  y -= 24;

  // Summary counts.
  const sx = [MARGIN, MARGIN + 170, MARGIN + 230, MARGIN + 290, MARGIN + 360];
  ["Class", "Total", "Open", "Resolved", "Ignored"].forEach((h, i) => text(h.toUpperCase(), sx[i]!, 7.5, bold, muted));
  y -= 5;
  hr(1);
  y -= 12;
  for (const c of CLASS_ORDER) {
    const n = d.counts[c];
    text(CLASS_LABEL[c], sx[0]!, 9.5, bold);
    [n.total, n.open, n.resolved, n.ignored].forEach((v, i) => text(String(v), sx[i + 1]!, 9.5));
    y -= 14;
  }

  const header = () => {
    const labels: Record<string, string> = {
      rowNumber: "Row",
      assetTag: "Tag / serial",
      registerName: "Register name",
      registerLocation: "Register location",
      assetCode: "Code",
      itemName: d.itemTerm,
      location: d.locationTerm,
      details: "Details",
      status: "Status",
    };
    let x = MARGIN;
    for (const c of PDF_COLS) {
      text(labels[c.key]!.toUpperCase(), x, 6.5, bold, muted);
      x += c.width;
    }
    y -= 5;
    hr(1);
    y -= 10;
  };

  for (const section of d.sections) {
    if (y - 60 < BOTTOM) newPage();
    else y -= 14;
    text(`${CLASS_LABEL[section.cls]} (${section.lines.length})`, MARGIN, 12, bold);
    y -= 12;
    text(CLASS_HELP[section.cls], MARGIN, 8, font, muted);
    y -= 14;
    if (!section.lines.length) {
      text("None.", MARGIN, SIZE, font, muted);
      y -= LEAD;
      continue;
    }
    // Clean matches are not discrepancies; past a page or two they only bury
    // the sections that are. The XLSX lists them all.
    if (section.cls === "matched" && section.lines.length > PDF_MATCHED_LIMIT) {
      text(`${section.lines.length} rows matched with nothing to fix; they are listed in the XLSX report.`, MARGIN, SIZE, font, muted);
      y -= LEAD;
      continue;
    }
    header();
    for (const line of section.lines) {
      const cells = PDF_COLS.map((c) => {
        let v = line[c.key];
        if (c.key === "assetTag") v = [line.assetTag, line.serial].filter(Boolean).join(" / ");
        return wrap(clean(v == null ? "" : String(v)), font, SIZE, c.width - 5);
      });
      const height = Math.max(...cells.map((c) => c.length)) * LEAD + 3;
      if (y - height < BOTTOM) {
        newPage();
        text(`${CLASS_LABEL[section.cls]} (continued)`, MARGIN, 9, bold, muted);
        y -= 14;
        header();
      }
      const top = y;
      let x = MARGIN;
      cells.forEach((lines, i) => {
        let ly = top;
        for (const l of lines) {
          page.drawText(l, { x, y: ly, size: SIZE, font, color: ink });
          ly -= LEAD;
        }
        x += PDF_COLS[i]!.width;
      });
      y = top - height;
      page.drawLine({ start: { x: MARGIN, y: y + 6 }, end: { x: RIGHT, y: y + 6 }, thickness: 0.3, color: rule });
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const footer = clean(`${d.appName}  ·  Page ${i + 1} of ${pages.length}`);
    p.drawText(footer, {
      x: RIGHT - font.widthOfTextAtSize(footer, 7.5),
      y: MARGIN - 16,
      size: 7.5,
      font,
      color: muted,
    });
  });
  return Buffer.from(await doc.save());
}
