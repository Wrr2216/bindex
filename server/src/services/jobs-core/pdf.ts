import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import bwipjs from "bwip-js";

/**
 * Printed manifests and load sheets. Same look as the container contents sheet
 * (services/printing/manifest.ts): Letter paper, Helvetica, a muted caps
 * kicker over a bold title, hairline rules, and a printed-at footer on every
 * page. These render plain data, so they can be tested without a database.
 */

export type StepChecks = { packed: boolean; loaded: boolean; delivered: boolean; placed: boolean };

export type ManifestDocLine = {
  index: number;
  itemName: string;
  /** Brand, model, unit label or serial: whatever tells two alike apart. */
  sub: string | null;
  code: string;
  crate: string | null;
  from: string | null;
  to: string | null;
  /** Set for an exception stage (Missing, Damaged, ...), printed in red. */
  exception: string | null;
  checks: StepChecks;
};

export type ManifestDocGroup = { label: string; summary: string; lines: ManifestDocLine[] };

export type ManifestDoc = {
  kicker: string;
  title: string;
  code: string;
  details: string[];
  groups: ManifestDocGroup[];
  summary: string;
  signatures: string[];
  url?: string;
};

export type LoadSheetLine = {
  index: number;
  crate: string | null;
  itemName: string;
  sub: string | null;
  code: string;
  to: string | null;
  exception: string | null;
  loaded: boolean;
  delivered: boolean;
};

export type LoadSheetDoc = {
  title: string;
  code: string;
  details: string[];
  facts: [string, string][];
  seals: string[];
  lines: LoadSheetLine[];
  summary: string;
  url?: string;
};

const ink = rgb(0.07, 0.09, 0.13);
const muted = rgb(0.42, 0.46, 0.52);
const rule = rgb(0.8, 0.83, 0.87);
const band = rgb(0.94, 0.95, 0.97);
const danger = rgb(0.74, 0.12, 0.12);

const MARGIN = 40;
const ROW_LEAD = 12;

/**
 * The standard fonts only encode Windows-1252. Anything else (an emoji in an
 * item name, a CJK room name) would make pdf-lib throw, so it prints as "?"
 * rather than failing the whole document.
 */
function encoder(font: PDFFont): (text: string) => string {
  const ok = new Set(font.getCharacterSet());
  return (text) =>
    Array.from(text.replace(/[\r\n\t]+/g, " "))
      .map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : "?"))
      .join("");
}

function fitWord(word: string, font: PDFFont, size: number, max: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= max) return [word];
  const out: string[] = [];
  let cur = "";
  for (const ch of word) {
    const cand = cur + ch;
    if (cur && font.widthOfTextAtSize(cand, size) > max) {
      out.push(cur);
      cur = ch;
    } else {
      cur = cand;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function wrap(text: string, font: PDFFont, size: number, max: number, maxLines = 4): string[] {
  const lines: string[] = [];
  let line = "";
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    for (const word of fitWord(raw, font, size, max)) {
      const cand = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(cand, size) > max) {
        lines.push(line);
        line = word;
      } else {
        line = cand;
      }
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}...`;
    return kept;
  }
  return lines;
}

export function formatPrinted(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone,
    }).format(at);
  } catch {
    return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

type Span = { text: string; bold?: boolean; size?: number; color?: RGB };

type Column = {
  header: string;
  width: number;
  /** Check boxes are drawn, not written. */
  check?: boolean;
};

type Row = { cells: (Span[] | boolean | null)[] };

/** A page-breaking table writer shared by both documents. */
class Writer {
  page!: PDFPage;
  y = 0;
  pageNum = 0;
  readonly safe: (t: string) => string;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly size: [number, number],
  ) {
    this.safe = encoder(font);
    this.newPage();
  }

  get width() {
    return this.size[0];
  }
  get right() {
    return this.size[0] - MARGIN;
  }
  get bottom() {
    return MARGIN + 28;
  }

  newPage() {
    this.page = this.doc.addPage(this.size);
    this.pageNum += 1;
    this.y = this.size[1] - MARGIN;
  }

  text(t: string, x: number, opts: { size?: number; bold?: boolean; color?: RGB; y?: number } = {}) {
    this.page.drawText(this.safe(t), {
      x,
      y: opts.y ?? this.y,
      size: opts.size ?? 9,
      font: opts.bold ? this.bold : this.font,
      color: opts.color ?? ink,
    });
  }

  line(y = this.y, thickness = 0.5, color = rule) {
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: this.right, y }, thickness, color });
  }

  ensure(height: number, onBreak?: () => void) {
    if (this.y - height < this.bottom) {
      this.newPage();
      onBreak?.();
    }
  }

  checkbox(x: number, yTop: number, checked: boolean) {
    const s = 8;
    this.page.drawRectangle({ x, y: yTop - 1, width: s, height: s, borderColor: muted, borderWidth: 0.8 });
    if (checked) {
      this.page.drawLine({ start: { x: x + 1.5, y: yTop + 3 }, end: { x: x + 3.5, y: yTop + 0.8 }, thickness: 1.2, color: ink });
      this.page.drawLine({ start: { x: x + 3.5, y: yTop + 0.8 }, end: { x: x + 7, y: yTop + 6.2 }, thickness: 1.2, color: ink });
    }
  }

  columnHeader(cols: Column[]) {
    let x = MARGIN;
    this.y -= 4;
    for (const c of cols) {
      this.text(c.header.toUpperCase(), x, { size: 7, bold: true, color: muted });
      x += c.width;
    }
    this.y -= 6;
    this.line(this.y, 1);
    this.y -= 11;
  }

  row(cols: Column[], row: Row, onBreak: () => void) {
    const wrapped = row.cells.map((cell, i) => {
      if (!Array.isArray(cell)) return [];
      const w = cols[i]!.width - 6;
      return cell.flatMap((span) =>
        wrap(this.safe(span.text), span.bold ? this.bold : this.font, span.size ?? 8.5, w).map((l) => ({ ...span, text: l })),
      );
    });
    const lines = Math.max(1, ...wrapped.map((w) => w.length));
    const height = lines * ROW_LEAD + 5;
    this.ensure(height, onBreak);
    const top = this.y;
    let x = MARGIN;
    row.cells.forEach((cell, i) => {
      const col = cols[i]!;
      if (col.check) {
        if (cell !== null) this.checkbox(x + (col.width - 8) / 2 - 3, top, cell === true);
      } else {
        let y = top;
        for (const span of wrapped[i]!) {
          this.text(span.text, x, { y, size: span.size ?? 8.5, bold: span.bold, color: span.color });
          y -= ROW_LEAD;
        }
      }
      x += col.width;
    });
    this.y = top - height;
    this.line(this.y + 4);
  }

  signatures(labels: string[]) {
    if (!labels.length) return;
    this.ensure(92);
    this.y -= 18;
    const gap = 18;
    const w = (this.right - MARGIN - gap * (labels.length - 1)) / labels.length;
    labels.forEach((label, i) => {
      const x = MARGIN + i * (w + gap);
      let y = this.y;
      this.text(label.toUpperCase(), x, { y, size: 7.5, bold: true, color: muted });
      for (const field of ["Name", "Signature", "Date and time"]) {
        y -= 22;
        this.page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.6, color: muted });
        this.text(field, x, { y: y - 8, size: 6.5, color: muted });
      }
    });
    this.y -= 86;
  }

  async qr(url: string) {
    const png = await bwipjs.toBuffer({ bcid: "qrcode", text: url, scale: 3, paddingwidth: 0, paddingheight: 0 });
    const img = await this.doc.embedPng(png);
    const size = 72;
    this.page.drawImage(img, { x: this.right - size, y: this.size[1] - MARGIN - size + 6, width: size, height: size });
  }

  footers(printed: string, appName: string) {
    const pages = this.doc.getPages();
    pages.forEach((page, i) => {
      const y = MARGIN - 14;
      page.drawText(this.safe(`Printed ${printed}`), { x: MARGIN, y, size: 7.5, font: this.font, color: muted });
      const right = this.safe(`${appName}  ·  Page ${i + 1} of ${pages.length}`);
      page.drawText(right, {
        x: this.right - this.font.widthOfTextAtSize(right, 7.5),
        y,
        size: 7.5,
        font: this.font,
        color: muted,
      });
    });
  }
}

async function header(w: Writer, kicker: string, title: string, code: string, details: string[], url?: string) {
  const textRight = w.right - (url ? 88 : 0);
  w.text(kicker, MARGIN, { size: 9, bold: true, color: muted });
  w.y -= 24;
  for (const line of wrap(w.safe(title), w.bold, 18, textRight - MARGIN, 2)) {
    w.text(line, MARGIN, { size: 18, bold: true });
    w.y -= 21;
  }
  w.text(code, MARGIN, { size: 11, color: muted });
  w.y -= 15;
  for (const d of details) {
    for (const line of wrap(w.safe(d), w.font, 9.5, textRight - MARGIN, 2)) {
      w.text(line, MARGIN, { size: 9.5 });
      w.y -= 13;
    }
  }
  if (url) await w.qr(url);
  w.y -= 6;
}

const LETTER: [number, number] = [612, 792];
const LETTER_LANDSCAPE: [number, number] = [792, 612];

/**
 * A relocation manifest, landscape so each line has room for where it came
 * from, where it goes and a box per step for the crew to tick.
 */
export async function renderManifestPdf(
  m: ManifestDoc,
  printedAt: Date,
  timeZone: string,
  appName: string,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const w = new Writer(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
    LETTER_LANDSCAPE,
  );
  doc.setTitle(`${m.code} ${m.title}`);
  const printed = formatPrinted(printedAt, timeZone);
  await header(w, m.kicker, m.title, m.code, [...m.details, `${m.summary}  ·  Printed ${printed}`], m.url);

  const cols: Column[] = [
    { header: "#", width: 26 },
    { header: "Item", width: 190 },
    { header: "Code", width: 78 },
    { header: "Crate", width: 44 },
    { header: "From", width: 132 },
    { header: "To", width: 150 },
    { header: "Pack", width: 22, check: true },
    { header: "Load", width: 22, check: true },
    { header: "Deliv", width: 22, check: true },
    { header: "Place", width: 22, check: true },
  ];
  w.columnHeader(cols);

  if (m.groups.every((g) => g.lines.length === 0)) {
    w.text("No lines match. Add items to the job, or clear the filter.", MARGIN, { size: 10, color: muted });
    w.y -= ROW_LEAD;
  }

  for (const group of m.groups) {
    const groupBand = (continued: boolean) => {
      w.ensure(40);
      w.page.drawRectangle({ x: MARGIN, y: w.y - 5, width: w.right - MARGIN, height: 16, color: band });
      w.text(`${group.label}${continued ? " (continued)" : ""}`, MARGIN + 4, { size: 9.5, bold: true });
      const s = w.safe(group.summary);
      w.text(s, w.right - 4 - w.font.widthOfTextAtSize(s, 8), { size: 8, color: muted });
      w.y -= 20;
    };
    if (group.label) groupBand(false);
    for (const l of group.lines) {
      const item: Span[] = [{ text: l.itemName, bold: true }];
      if (l.sub) item.push({ text: l.sub, size: 7.5, color: muted });
      if (l.exception) item.push({ text: l.exception, size: 7.5, color: danger, bold: true });
      w.row(
        cols,
        {
          cells: [
            [{ text: String(l.index), color: muted }],
            item,
            [{ text: l.code, size: 8 }],
            [{ text: l.crate ?? "" }],
            [{ text: l.from ?? "", size: 8 }],
            [{ text: l.to ?? "", size: 8, bold: Boolean(l.to) }],
            l.checks.packed,
            l.checks.loaded,
            l.checks.delivered,
            l.checks.placed,
          ],
        },
        () => {
          w.columnHeader(cols);
          if (group.label) groupBand(true);
        },
      );
    }
    w.y -= 6;
  }

  w.signatures(m.signatures);
  w.footers(printed, appName);
  return Buffer.from(await doc.save());
}

/**
 * A load sheet for one shipment, laid out like a bill of lading: what is on
 * the truck, its seals, and three signatures for the three hands it passes
 * through.
 */
export async function renderLoadSheetPdf(
  s: LoadSheetDoc,
  printedAt: Date,
  timeZone: string,
  appName: string,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const w = new Writer(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
    LETTER,
  );
  doc.setTitle(`${s.code} ${s.title}`);
  const printed = formatPrinted(printedAt, timeZone);
  await header(w, "LOAD SHEET  ·  BILL OF LADING", s.title, s.code, s.details, s.url);

  // Facts in two columns: carrier, vehicle, weight, ETA and the like.
  const half = (w.right - MARGIN) / 2;
  s.facts.forEach(([label, value], i) => {
    const x = MARGIN + (i % 2) * half;
    w.text(label.toUpperCase(), x, { size: 7, bold: true, color: muted });
    w.text(value, x + 78, { size: 9 });
    if (i % 2 === 1 || i === s.facts.length - 1) w.y -= 14;
  });
  w.y -= 4;
  w.text("SEALS", MARGIN, { size: 7, bold: true, color: muted });
  w.text(s.seals.length ? s.seals.join(",  ") : "None recorded", MARGIN + 78, { size: 10, bold: s.seals.length > 0 });
  w.y -= 14;
  w.text(`${s.summary}  ·  Printed ${printed}`, MARGIN, { size: 9.5 });
  w.y -= 14;

  const cols: Column[] = [
    { header: "#", width: 24 },
    { header: "Crate", width: 50 },
    { header: "Item", width: 190 },
    { header: "Code", width: 78 },
    { header: "Deliver to", width: 128 },
    { header: "Load", width: 31, check: true },
    { header: "Deliv", width: 31, check: true },
  ];
  w.columnHeader(cols);
  if (s.lines.length === 0) {
    w.text("Nothing is on this shipment yet. Scan items onto it from the job.", MARGIN, { size: 10, color: muted });
    w.y -= ROW_LEAD;
  }
  for (const l of s.lines) {
    const item: Span[] = [{ text: l.itemName, bold: true }];
    if (l.sub) item.push({ text: l.sub, size: 7.5, color: muted });
    if (l.exception) item.push({ text: l.exception, size: 7.5, color: danger, bold: true });
    w.row(
      cols,
      {
        cells: [
          [{ text: String(l.index), color: muted }],
          [{ text: l.crate ?? "" }],
          item,
          [{ text: l.code, size: 8 }],
          [{ text: l.to ?? "", size: 8 }],
          l.loaded,
          l.delivered,
        ],
      },
      () => w.columnHeader(cols),
    );
  }

  w.ensure(40);
  w.y -= 14;
  w.text("Seals checked intact:", MARGIN, { size: 9 });
  w.checkbox(MARGIN + 100, w.y, false);
  w.text("at origin", MARGIN + 112, { size: 9 });
  w.checkbox(MARGIN + 170, w.y, false);
  w.text("at destination", MARGIN + 182, { size: 9 });
  w.y -= 6;
  w.signatures(["Shipper (released)", "Carrier / driver", "Consignee (received)"]);
  w.footers(printed, appName);
  return Buffer.from(await doc.save());
}
