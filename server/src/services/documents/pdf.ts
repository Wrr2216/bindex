import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { RenderBlock, RenderModel } from "./layout";
import { formatValue, type Formatting } from "./merge";
import { isSigningType } from "./model";

/**
 * A document as a PDF: the render model drawn top to bottom on Letter paper,
 * with an audit footer on every page (document id, status, content hash,
 * page number) and, once completed, a record of who completed and signed it.
 *
 * Rendering is deterministic: the same document, state and time zone give
 * the same bytes, because the PDF's dates come from the document rather than
 * the clock. That keeps repeated exports of one state to one recorded hash.
 * Pure: no database, so it is tested directly.
 */

export type PdfInput = {
  model: RenderModel;
  documentId: string;
  status: "draft" | "completed" | "signed";
  contentHash: string | null;
  /** Muted line above the title: the organisation or app name. */
  kicker: string;
  /** Lines under the title: job, template version. */
  details: string[];
  /** Printed in the closing record once completed: [label, value]. */
  record: [string, string][];
  /** Signature images by signature id. */
  signatureImages: Map<string, Buffer>;
  /** The PDF's creation and modification date. */
  at: Date;
  fmt: Formatting;
};

const ink = rgb(0.07, 0.09, 0.13);
const muted = rgb(0.42, 0.46, 0.52);
const rule = rgb(0.8, 0.83, 0.87);
const band = rgb(0.94, 0.95, 0.97);
const danger = rgb(0.74, 0.12, 0.12);

const PAGE: [number, number] = [612, 792];
const MARGIN = 50;
const FOOTER = 46;
const WIDTH = PAGE[0] - MARGIN * 2;

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont };

/**
 * The standard fonts only encode Windows-1252. Anything else (an emoji, CJK)
 * would make pdf-lib throw, so it prints as "?" rather than failing.
 */
function encoder(font: PDFFont): (text: string) => string {
  const ok = new Set(font.getCharacterSet());
  return (text) =>
    Array.from(text.replace(/[\r\n\t]+/g, " "))
      .map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : "?"))
      .join("");
}

function splitWord(word: string, font: PDFFont, size: number, max: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= max) return [word];
  const out: string[] = [];
  let cur = "";
  for (const ch of word) {
    const cand = cur + ch;
    if (cur && font.widthOfTextAtSize(cand, size) > max) {
      out.push(cur);
      cur = ch;
    } else cur = cand;
  }
  if (cur) out.push(cur);
  return out;
}

/** Wrap one paragraph (no line breaks) to `max` points. */
export function wrapText(text: string, font: PDFFont, size: number, max: number, maxLines = Infinity): string[] {
  const lines: string[] = [];
  let line = "";
  for (const raw of text.split(/ +/).filter(Boolean)) {
    for (const word of splitWord(raw, font, size, max)) {
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

class Writer {
  page!: PDFPage;
  y = 0;
  readonly pages: PDFPage[] = [];
  private readonly enc: Record<keyof Fonts, (s: string) => string>;

  constructor(
    readonly pdf: PDFDocument,
    readonly fonts: Fonts,
  ) {
    this.enc = { regular: encoder(fonts.regular), bold: encoder(fonts.bold), italic: encoder(fonts.italic) };
    this.newPage();
  }

  newPage() {
    this.page = this.pdf.addPage(PAGE);
    this.pages.push(this.page);
    this.y = PAGE[1] - MARGIN;
  }

  /** Start a new page unless `height` more points fit on this one. */
  ensure(height: number) {
    if (this.y - height < MARGIN + FOOTER) this.newPage();
  }

  clean(text: string, font: keyof Fonts = "regular") {
    return this.enc[font](text);
  }

  text(text: string, x: number, y: number, size: number, font: keyof Fonts = "regular", color = ink) {
    this.page.drawText(this.clean(text, font), { x, y, size, font: this.fonts[font], color });
  }

  /** Wrapped text at the cursor, flowing across pages. Honours line breaks. */
  para(text: string, opts: { size?: number; font?: keyof Fonts; color?: ReturnType<typeof rgb>; x?: number; width?: number; lead?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.font ?? "regular";
    const lead = opts.lead ?? size * 1.35;
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? WIDTH;
    // Split before cleaning: a line break is not in the font and would print as "?".
    for (const raw of text.split(/\r?\n/)) {
      const paragraph = this.clean(raw.replace(/\r/g, ""), font);
      const lines = paragraph.trim() ? wrapText(paragraph, this.fonts[font], size, width) : [""];
      for (const line of lines) {
        this.ensure(lead);
        this.y -= lead;
        if (line) this.page.drawText(line, { x, y: this.y + (lead - size) / 2, size, font: this.fonts[font], color: opts.color ?? ink });
      }
    }
  }

  hr(color = rule, thickness = 0.6) {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + WIDTH, y: this.y }, thickness, color });
  }
}

const STATUS_LABEL = { draft: "DRAFT - not completed", completed: "Completed", signed: "Signed" } as const;

export async function renderDocumentPdf(input: PdfInput): Promise<Buffer> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(input.model.title || "Document");
  pdf.setSubject(`Document ${input.documentId}`);
  pdf.setCreator("Bindex");
  pdf.setProducer("Bindex");
  pdf.setCreationDate(input.at);
  pdf.setModificationDate(input.at);
  if (input.contentHash) pdf.setKeywords([`document:${input.documentId}`, `sha256:${input.contentHash}`]);

  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  const w = new Writer(pdf, fonts);
  const images = new Map<string, PDFImage | null>();
  const image = async (id: string) => {
    if (!images.has(id)) {
      const bytes = input.signatureImages.get(id);
      let img: PDFImage | null = null;
      if (bytes) {
        try {
          img = bytes[0] === 0x89 ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        } catch {
          img = null;
        }
      }
      images.set(id, img);
    }
    return images.get(id) ?? null;
  };

  // Header.
  if (input.kicker) {
    w.y -= 10;
    w.text(input.kicker.toUpperCase(), MARGIN, w.y, 8, "bold", muted);
  }
  w.para(input.model.title || "Untitled document", { size: 18, font: "bold", lead: 24 });
  if (input.status === "draft") {
    w.y -= 14;
    w.text(STATUS_LABEL.draft, MARGIN, w.y, 9, "bold", danger);
  }
  for (const line of input.details) w.para(line, { size: 9, color: muted, lead: 12 });
  w.y -= 8;
  w.hr();
  w.y -= 6;

  for (const block of input.model.blocks) await drawBlock(w, block, image, input.fmt);

  if (input.status !== "draft" && input.record.length) {
    w.y -= 14;
    w.ensure(60);
    w.hr();
    w.y -= 4;
    w.para("Record", { size: 11, font: "bold", lead: 18 });
    for (const [label, value] of input.record) {
      const labelWidth = 120;
      const lines = wrapText(w.clean(value), fonts.regular, 8.5, WIDTH - labelWidth);
      w.ensure(lines.length * 11 + 2);
      w.y -= 11;
      w.text(label, MARGIN, w.y + 2, 8.5, "bold", muted);
      lines.forEach((line, i) => {
        if (i > 0) w.y -= 11;
        w.page.drawText(line, { x: MARGIN + labelWidth, y: w.y + 2, size: 8.5, font: fonts.regular, color: ink });
      });
    }
  }

  // Footer on every page, now that the page count is known.
  const total = w.pages.length;
  w.pages.forEach((page, i) => {
    const y1 = MARGIN - 8;
    const y2 = MARGIN - 19;
    page.drawLine({ start: { x: MARGIN, y: MARGIN + 6 }, end: { x: MARGIN + WIDTH, y: MARGIN + 6 }, thickness: 0.5, color: rule });
    const left = `Document ${input.documentId} - ${STATUS_LABEL[input.status]}`;
    page.drawText(w.clean(left), { x: MARGIN, y: y1, size: 7.5, font: fonts.regular, color: input.status === "draft" ? danger : muted });
    const hash = input.contentHash ? `Content sha256 ${input.contentHash}` : "Not completed: the content is not fixed and has no hash.";
    page.drawText(w.clean(hash), { x: MARGIN, y: y2, size: 7, font: fonts.regular, color: muted });
    const num = `Page ${i + 1} of ${total}`;
    page.drawText(num, { x: MARGIN + WIDTH - fonts.regular.widthOfTextAtSize(num, 7.5), y: y1, size: 7.5, font: fonts.regular, color: muted });
  });

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function drawBlock(
  w: Writer,
  block: RenderBlock,
  image: (id: string) => Promise<PDFImage | null>,
  fmt: Formatting,
): Promise<void> {
  switch (block.type) {
    case "heading": {
      const size = block.level === 1 ? 15 : block.level === 2 ? 12.5 : 11;
      w.y -= block.level === 1 ? 10 : 7;
      w.ensure(size * 3);
      w.para(block.text, { size, font: "bold", lead: size * 1.35 });
      w.y -= 2;
      return;
    }
    case "paragraph":
      w.y -= 3;
      w.para(block.text, { size: 10 });
      w.y -= 3;
      return;
    case "divider":
      w.y -= 8;
      w.ensure(10);
      w.hr();
      w.y -= 6;
      return;
    case "field":
      return drawField(w, block, image, fmt);
    case "table":
      return drawTable(w, block);
  }
}

async function drawField(
  w: Writer,
  block: Extract<RenderBlock, { type: "field" }>,
  image: (id: string) => Promise<PDFImage | null>,
  fmt: Formatting,
) {
  const f = block.field;
  const label = `${f.label}${f.required ? " *" : ""}`;

  if (f.type === "checkbox") {
    w.ensure(20);
    w.y -= 16;
    const box = 10;
    w.page.drawRectangle({ x: MARGIN, y: w.y, width: box, height: box, borderColor: ink, borderWidth: 0.8 });
    if (block.value === true) {
      w.page.drawLine({ start: { x: MARGIN + 2, y: w.y + 5 }, end: { x: MARGIN + 4.2, y: w.y + 2 }, thickness: 1.4, color: ink });
      w.page.drawLine({ start: { x: MARGIN + 4.2, y: w.y + 2 }, end: { x: MARGIN + 8.5, y: w.y + 8.5 }, thickness: 1.4, color: ink });
    }
    const lines = wrapText(w.clean(label), w.fonts.regular, 10, WIDTH - 20);
    lines.forEach((line, i) => {
      if (i > 0) {
        w.y -= 13;
        w.ensure(13);
      }
      w.page.drawText(line, { x: MARGIN + 18, y: w.y + 1.5, size: 10, font: w.fonts.regular, color: ink });
    });
    return;
  }

  if (isSigningType(f.type)) {
    const boxW = f.type === "initials" ? 110 : 240;
    const boxH = f.type === "initials" ? 44 : 70;
    w.y -= 8;
    w.ensure(boxH + 42);
    w.y -= 11;
    w.text(label.toUpperCase(), MARGIN, w.y, 7.5, "bold", muted);
    w.y -= boxH + 4;
    const sig = block.signature;
    const img = sig ? await image(sig.signatureId) : null;
    if (img) {
      const scale = Math.min((boxW - 8) / img.width, (boxH - 6) / img.height, 1);
      const iw = img.width * scale;
      const ih = img.height * scale;
      w.page.drawImage(img, { x: MARGIN + 4, y: w.y + 3, width: iw, height: ih });
    } else if (sig) {
      w.text(sig.signerName, MARGIN + 6, w.y + boxH / 2 - 4, 14, "italic", ink);
    }
    w.page.drawLine({ start: { x: MARGIN, y: w.y }, end: { x: MARGIN + boxW, y: w.y }, thickness: 0.8, color: ink });
    w.y -= 11;
    const caption = sig
      ? `${sig.signerName}${sig.signerRole ? `, ${sig.signerRole}` : ""} - signed ${formatValue(sig.signedAt, fmt)}`
      : "Not signed";
    w.text(caption, MARGIN, w.y, 8, "regular", sig ? ink : muted);
    w.y -= 4;
    return;
  }

  // Text, number, date, select: label over the value, on a writing line.
  w.y -= 6;
  w.ensure(34);
  w.y -= 9;
  w.text(label.toUpperCase(), MARGIN, w.y, 7.5, "bold", muted);
  const value = block.display;
  if (value) {
    w.y -= 2;
    w.para(value, { size: 10.5, lead: 14 });
  } else {
    w.y -= 18;
  }
  w.page.drawLine({ start: { x: MARGIN, y: w.y - 2 }, end: { x: MARGIN + WIDTH, y: w.y - 2 }, thickness: 0.4, color: rule });
  w.y -= 4;
}

function columnWidths(block: Extract<RenderBlock, { type: "table" }>): number[] {
  const weights = block.columns.map((c, i) => {
    const sample = block.rows.slice(0, 50).map((r) => (r[i] ?? "").length);
    const avg = sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length : 0;
    return Math.min(Math.max(avg, c.label.length, 4), 32);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((wt) => (wt / sum) * WIDTH);
}

function drawTable(w: Writer, block: Extract<RenderBlock, { type: "table" }>) {
  const size = 8.5;
  const lead = 11;
  const pad = 4;
  const widths = columnWidths(block);
  w.y -= 8;
  if (block.title) {
    w.ensure(40);
    w.para(block.title, { size: 10.5, font: "bold", lead: 15 });
  }

  const header = () => {
    const h = lead + pad * 2;
    w.ensure(h + lead + pad * 2);
    w.y -= h;
    w.page.drawRectangle({ x: MARGIN, y: w.y, width: WIDTH, height: h, color: band });
    let x = MARGIN;
    block.columns.forEach((c, i) => {
      const text = wrapText(w.clean(c.label, "bold"), w.fonts.bold, size, widths[i]! - pad * 2, 1)[0] ?? "";
      w.page.drawText(text, { x: x + pad, y: w.y + pad + 2, size, font: w.fonts.bold, color: ink });
      x += widths[i]!;
    });
  };

  if (block.rows.length === 0) {
    w.ensure(lead * 2);
    w.para(block.emptyText, { size: 9, font: "italic", color: muted });
    return;
  }

  header();
  for (const row of block.rows) {
    const cells = row.map((cell, i) => wrapText(w.clean(cell), w.fonts.regular, size, widths[i]! - pad * 2, 4));
    const lines = Math.max(1, ...cells.map((c) => c.length));
    const h = lines * lead + pad * 2 - 2;
    if (w.y - h < MARGIN + FOOTER) {
      w.newPage();
      header();
    }
    w.y -= h;
    let x = MARGIN;
    cells.forEach((cellLines, i) => {
      cellLines.forEach((line, j) => {
        w.page.drawText(line, { x: x + pad, y: w.y + h - pad - lead * (j + 1) + 3, size, font: w.fonts.regular, color: ink });
      });
      x += widths[i]!;
    });
    w.page.drawLine({ start: { x: MARGIN, y: w.y }, end: { x: MARGIN + WIDTH, y: w.y }, thickness: 0.4, color: rule });
  }
  if (block.truncated) {
    w.para(`Showing ${block.rows.length.toLocaleString("en-US")} of ${block.total.toLocaleString("en-US")} rows.`, {
      size: 8,
      font: "italic",
      color: muted,
    });
  }
}
