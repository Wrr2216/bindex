import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import bwipjs from "bwip-js";

/**
 * The adjuster's copy of a claim: what is claimed, and for each line the
 * evidence on file with its photos, then the whole story as a timeline. Same
 * look as the printed manifests: Letter paper, Helvetica, a muted caps kicker
 * over a bold title, hairline rules, a printed-at footer on every page.
 *
 * Renders plain data (ClaimDoc) plus photo bytes, so it can be tested without
 * a database.
 */

export type DocPhoto = { id: string; label: string };

export type DocEvidence = {
  heading: string;
  trip: string | null;
  notes: { at: string; source: string; text: string }[];
  reports: { at: string; text: string }[];
  custody: { at: string; text: string }[];
  before: DocPhoto[];
  after: DocPhoto[];
  other: DocPhoto[];
  /** Photos on file that did not fit in the document. */
  morePhotos: number;
  history: { at: string; stage: string; detail: string }[];
  audit: string | null;
};

export type ClaimDoc = {
  kicker: string;
  title: string;
  code: string;
  subtitle: string;
  facts: [string, string][];
  totals: [string, string][] | null;
  description: string | null;
  fingerprint: string | null;
  lines: {
    index: number;
    name: string;
    code: string;
    damage: string | null;
    stage: string | null;
    resolution: string | null;
    estimated: string;
    approved: string;
  }[];
  money: boolean;
  evidence: DocEvidence[];
  claimPhotos: DocPhoto[];
  signatures: string[];
  timeline: { at: string; label: string; detail: string | null }[];
  sources: string;
  url?: string;
};

const ink = rgb(0.07, 0.09, 0.13);
const muted = rgb(0.42, 0.46, 0.52);
const rule = rgb(0.8, 0.83, 0.87);
const band = rgb(0.94, 0.95, 0.97);
const danger = rgb(0.74, 0.12, 0.12);

const MARGIN = 40;
const LEAD = 11.5;
const PAGE: [number, number] = [612, 792];

/** The standard fonts encode Windows-1252 only; anything else prints as "?" rather than failing the document. */
function encoder(font: PDFFont): (text: string) => string {
  const ok = new Set(font.getCharacterSet());
  return (text) =>
    Array.from(text.replace(/[\r\n\t]+/g, " "))
      .map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : "?"))
      .join("");
}

function wrap(text: string, font: PDFFont, size: number, max: number, maxLines = 40): string[] {
  const lines: string[] = [];
  let line = "";
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    // A single word wider than the column (a hash, a URL) is broken by character.
    const parts: string[] = [];
    let cur = "";
    for (const ch of raw) {
      if (cur && font.widthOfTextAtSize(cur + ch, size) > max) {
        parts.push(cur);
        cur = ch;
      } else cur += ch;
    }
    if (cur) parts.push(cur);
    for (const word of parts) {
      const cand = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(cand, size) > max) {
        lines.push(line);
        line = word;
      } else line = cand;
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

type Column = { header: string; width: number; align?: "right" };
type Span = { text: string; bold?: boolean; size?: number; color?: RGB };

class Writer {
  page!: PDFPage;
  y = 0;
  readonly safe: (t: string) => string;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.safe = encoder(font);
    this.newPage();
  }

  get right() {
    return PAGE[0] - MARGIN;
  }
  get bottom() {
    return MARGIN + 28;
  }
  get contentWidth() {
    return this.right - MARGIN;
  }

  newPage() {
    this.page = this.doc.addPage(PAGE);
    this.y = PAGE[1] - MARGIN;
  }

  ensure(height: number, onBreak?: () => void) {
    if (this.y - height < this.bottom) {
      this.newPage();
      onBreak?.();
    }
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

  rightText(t: string, xRight: number, opts: { size?: number; bold?: boolean; color?: RGB; y?: number } = {}) {
    const s = this.safe(t);
    const w = (opts.bold ? this.bold : this.font).widthOfTextAtSize(s, opts.size ?? 9);
    this.text(s, xRight - w, opts);
  }

  rule(y = this.y, thickness = 0.5, color = rule) {
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: this.right, y }, thickness, color });
  }

  /** A wrapped paragraph at the left margin, breaking pages as needed. */
  paragraph(t: string, opts: { size?: number; bold?: boolean; color?: RGB; indent?: number } = {}) {
    const size = opts.size ?? 9;
    const x = MARGIN + (opts.indent ?? 0);
    for (const line of wrap(this.safe(t), opts.bold ? this.bold : this.font, size, this.right - x)) {
      this.ensure(size + 4);
      this.text(line, x, { size, bold: opts.bold, color: opts.color });
      this.y -= size + 3;
    }
  }

  heading(t: string) {
    this.ensure(40);
    this.y -= 8;
    this.text(t.toUpperCase(), MARGIN, { size: 8, bold: true, color: muted });
    this.y -= 5;
    this.rule(this.y, 0.8);
    this.y -= 13;
  }

  bandTitle(t: string, right?: string) {
    this.ensure(48);
    this.y -= 6;
    this.page.drawRectangle({ x: MARGIN, y: this.y - 5, width: this.contentWidth, height: 17, color: band });
    this.text(t, MARGIN + 5, { size: 10, bold: true });
    if (right) this.rightText(right, this.right - 5, { size: 8, color: muted });
    this.y -= 22;
  }

  columnHeader(cols: Column[]) {
    let x = MARGIN;
    for (const c of cols) {
      if (c.align === "right") this.rightText(c.header.toUpperCase(), x + c.width - 4, { size: 7, bold: true, color: muted });
      else this.text(c.header.toUpperCase(), x, { size: 7, bold: true, color: muted });
      x += c.width;
    }
    this.y -= 6;
    this.rule(this.y, 1);
    this.y -= 11;
  }

  row(cols: Column[], cells: Span[][], onBreak: () => void) {
    const wrapped = cells.map((cell, i) =>
      cell.flatMap((span) =>
        wrap(this.safe(span.text), span.bold ? this.bold : this.font, span.size ?? 8.5, cols[i]!.width - 6, 8).map((l) => ({
          ...span,
          text: l,
        })),
      ),
    );
    const lines = Math.max(1, ...wrapped.map((w) => w.length));
    const toRule = (lines - 1) * LEAD + 5;
    this.ensure(toRule + 12, onBreak);
    const top = this.y;
    let x = MARGIN;
    cols.forEach((col, i) => {
      let y = top;
      for (const span of wrapped[i] ?? []) {
        const opts = { y, size: span.size ?? 8.5, bold: span.bold, color: span.color };
        if (col.align === "right") this.rightText(span.text, x + col.width - 4, opts);
        else this.text(span.text, x, opts);
        y -= LEAD;
      }
      x += col.width;
    });
    this.rule(top - toRule);
    this.y = top - toRule - 12;
  }

  /** Label: value pairs in two columns. */
  facts(pairs: [string, string][]) {
    const half = this.contentWidth / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      const pair = pairs.slice(i, i + 2);
      const heights = pair.map(([, v]) => wrap(this.safe(v), this.font, 9, half - 92, 3).length);
      const h = Math.max(1, ...heights);
      this.ensure(h * 12 + 4);
      pair.forEach(([label, value], j) => {
        const x = MARGIN + j * half;
        this.text(label.toUpperCase(), x, { size: 7, bold: true, color: muted });
        wrap(this.safe(value), this.font, 9, half - 92, 3).forEach((line, k) => this.text(line, x + 86, { size: 9, y: this.y - k * 12 }));
      });
      this.y -= h * 12 + 2;
    }
  }

  /** Photos three to a row, each scaled to fit its cell, with a caption underneath. */
  photos(list: { image: PDFImage | null; label: string }[]) {
    const cols = 3;
    const gap = 10;
    const cellW = (this.contentWidth - gap * (cols - 1)) / cols;
    const cellH = 118;
    for (let i = 0; i < list.length; i += cols) {
      const row = list.slice(i, i + cols);
      this.ensure(cellH + 30);
      row.forEach((p, j) => {
        const x = MARGIN + j * (cellW + gap);
        const top = this.y;
        if (p.image) {
          const scale = Math.min(cellW / p.image.width, cellH / p.image.height);
          const w = p.image.width * scale;
          const h = p.image.height * scale;
          this.page.drawImage(p.image, { x: x + (cellW - w) / 2, y: top - cellH + (cellH - h) / 2, width: w, height: h });
        } else {
          this.page.drawRectangle({ x, y: top - cellH, width: cellW, height: cellH, borderColor: rule, borderWidth: 0.8 });
          this.text("Not printable here: see the file in Bindex.", x + 6, { size: 7, color: muted, y: top - cellH / 2 });
        }
        wrap(this.safe(p.label), this.font, 7, cellW, 2).forEach((line, k) =>
          this.text(line, x, { size: 7, color: muted, y: top - cellH - 10 - k * 9 }),
        );
      });
      this.y -= cellH + 32;
    }
  }

  async qr(url: string) {
    const png = await bwipjs.toBuffer({ bcid: "qrcode", text: url, scale: 3, paddingwidth: 0, paddingheight: 0 });
    const img = await this.doc.embedPng(png);
    const size = 66;
    this.page.drawImage(img, { x: this.right - size, y: PAGE[1] - MARGIN - size + 6, width: size, height: size });
  }

  footers(printed: string, appName: string, code: string) {
    const pages = this.doc.getPages();
    pages.forEach((page, i) => {
      const y = MARGIN - 14;
      page.drawText(this.safe(`${code}  ·  Printed ${printed}`), { x: MARGIN, y, size: 7.5, font: this.font, color: muted });
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

async function embed(doc: PDFDocument, bytes: Buffer | undefined): Promise<PDFImage | null> {
  if (!bytes) return null;
  try {
    return await doc.embedJpg(bytes);
  } catch {
    return null;
  }
}

export async function renderClaimPdf(
  c: ClaimDoc,
  photoBytes: Map<string, Buffer>,
  printedAt: Date,
  timeZone: string,
  appName: string,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  doc.setTitle(`${c.code} ${c.title}`);
  doc.setSubject(c.kicker);
  const printed = formatPrinted(printedAt, timeZone);
  const images = new Map<string, PDFImage | null>();
  const imageOf = async (id: string) => {
    if (!images.has(id)) images.set(id, await embed(doc, photoBytes.get(id)));
    return images.get(id) ?? null;
  };

  // Header
  const textRight = w.right - (c.url ? 80 : 0);
  w.text(c.kicker, MARGIN, { size: 9, bold: true, color: muted });
  w.y -= 24;
  for (const line of wrap(w.safe(c.title), w.bold, 18, textRight - MARGIN, 2)) {
    w.text(line, MARGIN, { size: 18, bold: true });
    w.y -= 21;
  }
  w.text(c.code, MARGIN, { size: 11, color: muted });
  w.y -= 15;
  w.text(c.subtitle, MARGIN, { size: 9.5 });
  w.y -= 18;
  if (c.url) await w.qr(c.url);

  w.facts(c.facts);
  if (c.totals) {
    w.y -= 4;
    w.ensure(30);
    const each = w.contentWidth / c.totals.length;
    c.totals.forEach(([label, value], i) => {
      const x = MARGIN + i * each;
      w.text(label.toUpperCase(), x, { size: 7, bold: true, color: muted });
      w.text(value, x, { size: 14, bold: true, y: w.y - 17 });
    });
    w.y -= 32;
  }
  if (c.description) {
    w.heading("What happened");
    w.paragraph(c.description, { size: 9.5 });
  }
  if (c.fingerprint) {
    w.y -= 4;
    w.paragraph(c.fingerprint, { size: 7.5, color: muted });
  }

  // Lines
  w.heading(c.money ? "Lines claimed" : "Affected items");
  const cols: Column[] = c.money
    ? [
        { header: "#", width: 22 },
        { header: "Item", width: 200 },
        { header: "Stage", width: 70 },
        { header: "Resolution", width: 80 },
        { header: "Estimated", width: 80, align: "right" },
        { header: "Approved", width: 80, align: "right" },
      ]
    : [
        { header: "#", width: 22 },
        { header: "Item", width: 330 },
        { header: "Stage", width: 180 },
      ];
  if (c.lines.length === 0) {
    w.paragraph(c.money ? "No lines: the amount is claimed as a whole." : "No items listed.", { color: muted });
  } else {
    w.columnHeader(cols);
    for (const l of c.lines) {
      const item: Span[] = [
        { text: l.name, bold: true },
        { text: l.code, size: 7.5, color: muted },
      ];
      if (l.damage) item.push({ text: l.damage, size: 8, color: danger });
      const cells: Span[][] = [[{ text: String(l.index), color: muted }], item, [{ text: l.stage ?? "", size: 8 }]];
      if (c.money) {
        cells.push([{ text: l.resolution ?? "", size: 8 }], [{ text: l.estimated }], [{ text: l.approved, bold: true }]);
      }
      w.row(cols, cells, () => w.columnHeader(cols));
    }
  }

  // Evidence per line
  for (const e of c.evidence) {
    w.bandTitle(e.heading, "Evidence on file");
    if (e.trip) {
      w.paragraph(e.trip, { size: 8.5 });
      w.y -= 2;
    }
    if (e.notes.length) {
      w.text("CONDITION NOTES", MARGIN, { size: 7, bold: true, color: muted });
      w.y -= 11;
      for (const n of e.notes) w.paragraph(`${n.at}  ·  ${n.source}  ·  ${n.text}`, { size: 8.5, indent: 6 });
      w.y -= 3;
    }
    if (e.reports.length) {
      w.text("CONDITION REPORTS", MARGIN, { size: 7, bold: true, color: muted });
      w.y -= 11;
      for (const r of e.reports) w.paragraph(`${r.at}  ·  ${r.text}`, { size: 8.5, indent: 6 });
      w.y -= 3;
    }
    if (e.custody.length) {
      w.text("CHAIN OF CUSTODY", MARGIN, { size: 7, bold: true, color: muted });
      w.y -= 11;
      for (const h of e.custody) w.paragraph(`${h.at}  ·  ${h.text}`, { size: 8.5, indent: 6 });
      w.y -= 3;
    }
    for (const [label, photos] of [
      ["BEFORE THE MOVE", e.before],
      ["AFTER / ON ARRIVAL", e.after],
      ["OTHER PHOTOS", e.other],
    ] as const) {
      if (!photos.length) continue;
      w.ensure(160);
      w.text(label, MARGIN, { size: 7, bold: true, color: muted });
      w.y -= 10;
      w.photos(await Promise.all(photos.map(async (p) => ({ image: await imageOf(p.id), label: p.label }))));
    }
    if (e.morePhotos > 0) {
      w.paragraph(`${e.morePhotos} more photo${e.morePhotos === 1 ? "" : "s"} on file in ${appName}.`, { size: 8, color: muted });
    }
    if (!e.before.length && !e.after.length && !e.other.length) {
      w.paragraph("No photos on file for this item.", { size: 8.5, color: muted });
    }
    if (e.history.length) {
      w.y -= 2;
      const hcols: Column[] = [
        { header: "When", width: 120 },
        { header: "Stage", width: 90 },
        { header: "How, who and notes", width: 322 },
      ];
      w.columnHeader(hcols);
      for (const h of e.history) {
        w.row(hcols, [[{ text: h.at, size: 8 }], [{ text: h.stage, size: 8, bold: true }], [{ text: h.detail, size: 8 }]], () =>
          w.columnHeader(hcols),
        );
      }
    }
    if (e.audit) w.paragraph(e.audit, { size: 7, color: muted });
  }

  if (c.claimPhotos.length) {
    w.heading("Attached to the claim");
    w.photos(await Promise.all(c.claimPhotos.map(async (p) => ({ image: await imageOf(p.id), label: p.label }))));
  }

  if (c.signatures.length) {
    w.heading("Signed records");
    for (const s of c.signatures) w.paragraph(s, { size: 8.5 });
  }

  if (c.timeline.length) {
    w.heading("Timeline");
    const tcols: Column[] = [
      { header: "When", width: 120 },
      { header: "What", width: 200 },
      { header: "Detail", width: 212 },
    ];
    w.columnHeader(tcols);
    for (const t of c.timeline) {
      w.row(tcols, [[{ text: t.at, size: 8 }], [{ text: t.label, size: 8, bold: true }], [{ text: t.detail ?? "", size: 8 }]], () =>
        w.columnHeader(tcols),
      );
    }
  }

  w.y -= 6;
  w.paragraph(c.sources, { size: 7, color: muted });
  w.footers(printed, appName, c.code);
  return Buffer.from(await doc.save());
}
