import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";

/**
 * Page furniture shared by the declaration and the valuation report: US
 * Letter, the same margins and colours as the contents sheet, text wrapping,
 * and page footers written once the page count is known.
 */

export const PAGE_W = 612;
export const PAGE_H = 792;
export const MARGIN = 44;
export const RIGHT = PAGE_W - MARGIN;
export const BOTTOM = MARGIN + 26;

export const ink = rgb(0.07, 0.09, 0.13);
export const muted = rgb(0.42, 0.46, 0.52);
export const rule = rgb(0.8, 0.83, 0.87);
export const accent = rgb(0.01, 0.52, 0.78);
export const warn = rgb(0.7, 0.33, 0.02);

export type Doc = {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;
  /** Characters the standard fonts can draw; everything else becomes "?". */
  charset: Set<number>;
};

export async function newDoc(): Promise<Doc> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  return { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN, charset };
}

/**
 * Text the built-in fonts can draw. They cover Western European scripts; a
 * name in another script is printed with "?" rather than failing the whole
 * document.
 */
export function safe(d: Doc, text: string | null | undefined): string {
  if (!text) return "";
  let out = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) out += d.charset.has(ch.codePointAt(0)!) ? ch : "?";
  return out;
}

function fitWord(word: string, font: PDFFont, size: number, max: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= max) return [word];
  const out: string[] = [];
  let cur = "";
  for (const ch of word) {
    if (cur && font.widthOfTextAtSize(cur + ch, size) > max) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function wrap(d: Doc, text: string | null | undefined, font: PDFFont, size: number, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const raw of safe(d, text).split(/\s+/).filter(Boolean)) {
    for (const word of fitWord(raw, font, size, max)) {
      const cand = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(cand, size) > max) {
        lines.push(line);
        line = word;
      } else line = cand;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function text(d: Doc, s: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}): void {
  d.page.drawText(safe(d, s), { x, y, size, font: opts.bold ? d.bold : d.font, color: opts.color ?? ink });
}

/** Right-aligned at `right`. */
export function textRight(d: Doc, s: string, right: number, y: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}): void {
  const f = opts.bold ? d.bold : d.font;
  const t = safe(d, s);
  d.page.drawText(t, { x: right - f.widthOfTextAtSize(t, size), y, size, font: f, color: opts.color ?? ink });
}

export function hr(d: Doc, y = d.y, thickness = 0.5): void {
  d.page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT, y }, thickness, color: rule });
}

/** Start a new page when fewer than `needed` points are left. Returns true when it did. */
export function ensureRoom(d: Doc, needed: number, onNewPage?: () => void): boolean {
  if (d.y - needed >= BOTTOM) return false;
  d.page = d.doc.addPage([PAGE_W, PAGE_H]);
  d.y = PAGE_H - MARGIN;
  onNewPage?.();
  return true;
}

export function formatPrinted(at: Date, timeZone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale || "en-US", {
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

/** A money formatter in the instance currency and locale, to the cent. */
export function moneyFormatter(currency: string, locale: string): (cents: number | null | undefined) => string {
  let fmt: Intl.NumberFormat;
  try {
    fmt = new Intl.NumberFormat(locale || "en-US", { style: "currency", currency });
  } catch {
    fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  }
  return (cents) => (cents == null ? "" : fmt.format(cents / 100));
}

/** Footers on every page: when it was printed, and page n of N. */
export function footers(d: Doc, left: string, right: string): void {
  const pages = d.doc.getPages();
  pages.forEach((page, i) => {
    const y = MARGIN - 16;
    const l = safe(d, left);
    page.drawText(l, { x: MARGIN, y, size: 7.5, font: d.font, color: muted });
    const r = safe(d, `${right}  ·  Page ${i + 1} of ${pages.length}`);
    page.drawText(r, { x: RIGHT - d.font.widthOfTextAtSize(r, 7.5), y, size: 7.5, font: d.font, color: muted });
  });
}

/** Draw an embedded JPEG inside a box, keeping its proportions, top-left at (x, top). */
export function drawThumb(d: Doc, img: PDFImage, x: number, top: number, box: number): void {
  const scale = Math.min(box / img.width, box / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  d.page.drawImage(img, { x: x + (box - w) / 2, y: top - h - (box - h) / 2, width: w, height: h });
}

export async function save(d: Doc): Promise<Buffer> {
  return Buffer.from(await d.doc.save());
}
