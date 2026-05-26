import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import bwipjs from "bwip-js";
import type { ContainerManifest } from "../items";

// US Letter, portrait (points). A standard paper size prints cleanly from any
// browser PDF viewer, unlike the exact-size label pages.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;

// Column x-positions (from the left margin) for the contents table.
const COL = {
  idx: MARGIN,
  name: 78,
  code: 304,
  qty: 398,
  serial: 440,
  right: PAGE_W - MARGIN,
};
const COL_W = {
  name: COL.code - COL.name - 8,
  code: COL.qty - COL.code - 8,
  qty: COL.serial - COL.qty - 6,
  serial: COL.right - COL.serial,
};

const ROW_LEAD = 13; // line height within a row
const BOTTOM = MARGIN + 28; // reserve space for the footer

const ink = rgb(0.07, 0.09, 0.13);
const muted = rgb(0.42, 0.46, 0.52);
const rule = rgb(0.8, 0.83, 0.87);
const danger = rgb(0.74, 0.12, 0.12);

/** Break a single (possibly very long) token to fit a column width. */
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

function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
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
  return lines.length ? lines : [""];
}

function formatPrinted(at: Date, timeZone: string): string {
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

type Ctx = {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;
  printedLabel: string;
  /** Instance name, printed in the footer of every page. */
  appName: string;
  pageNum: number;
};

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.pageNum += 1;
  ctx.y = PAGE_H - MARGIN;
}

function drawColumnHeader(ctx: Ctx): void {
  const size = 8;
  ctx.y -= 6;
  const head = (text: string, x: number) =>
    ctx.page.drawText(text.toUpperCase(), { x, y: ctx.y, size, font: ctx.bold, color: muted });
  head("#", COL.idx);
  head("Item", COL.name);
  head("Asset code", COL.code);
  head("Qty", COL.qty);
  head("Serial number(s)", COL.serial);
  ctx.y -= 6;
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: COL.right, y: ctx.y },
    thickness: 1,
    color: rule,
  });
  ctx.y -= 12;
}

function drawFooter(ctx: Ctx, pages: number): void {
  const size = 8;
  const y = MARGIN - 14;
  ctx.page.drawText(`Printed ${ctx.printedLabel}`, { x: MARGIN, y, size, font: ctx.font, color: muted });
  const right = `${ctx.appName}  ·  Page ${ctx.pageNum} of ${pages}`;
  ctx.page.drawText(right, {
    x: COL.right - ctx.font.widthOfTextAtSize(right, size),
    y,
    size,
    font: ctx.font,
    color: muted,
  });
}

/** Render a container's contents to a printable Letter-size PDF. */
export async function manifestPdf(
  m: ContainerManifest,
  printedAt: Date,
  timeZone: string,
  appName: string,
  itemUrl?: string,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = {
    doc,
    font,
    bold,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: PAGE_H - MARGIN,
    printedLabel: formatPrinted(printedAt, timeZone),
    appName,
    pageNum: 1,
  };

  // --- Header ---------------------------------------------------------------
  const headerRight = COL.right - 96; // leave room for the QR block
  ctx.page.drawText("CONTAINER CONTENTS", { x: MARGIN, y: ctx.y, size: 9, font: bold, color: muted });
  ctx.y -= 26;
  for (const line of wrap(m.name, bold, 20, headerRight - MARGIN)) {
    ctx.page.drawText(line, { x: MARGIN, y: ctx.y, size: 20, font: bold, color: ink });
    ctx.y -= 24;
  }
  if (m.assetCode) {
    ctx.page.drawText(m.assetCode, { x: MARGIN, y: ctx.y, size: 11, font, color: muted });
    ctx.y -= 16;
  }
  const loc = [m.locationName, m.companyName].filter(Boolean).join("  ·  ");
  if (loc) {
    ctx.page.drawText(loc, { x: MARGIN, y: ctx.y, size: 10, font, color: muted });
    ctx.y -= 14;
  }
  const totalUnits = m.contents.reduce((n, c) => n + c.quantity, 0);
  const summary = `${m.contents.length} item${m.contents.length === 1 ? "" : "s"}  ·  ${totalUnits} unit${totalUnits === 1 ? "" : "s"}  ·  Printed ${ctx.printedLabel}`;
  ctx.page.drawText(summary, { x: MARGIN, y: ctx.y, size: 10, font, color: ink });

  // QR (deep-links to the container) in the top-right corner.
  if (itemUrl) {
    const qrPng = await bwipjs.toBuffer({
      bcid: "qrcode",
      text: itemUrl,
      scale: 3,
      paddingwidth: 0,
      paddingheight: 0,
    });
    const qr = await doc.embedPng(qrPng);
    const size = 84;
    ctx.page.drawImage(qr, { x: COL.right - size, y: PAGE_H - MARGIN - size + 6, width: size, height: size });
  }

  ctx.y -= 18;
  drawColumnHeader(ctx);

  // --- Rows -----------------------------------------------------------------
  if (m.contents.length === 0) {
    ctx.page.drawText("This container has no items recorded inside it.", {
      x: MARGIN,
      y: ctx.y,
      size: 10,
      font,
      color: muted,
    });
    ctx.y -= ROW_LEAD;
  }

  m.contents.forEach((c, i) => {
    const size = 9.5;
    const sub = [c.brand, c.model].filter(Boolean).join(" · ");
    const nameLines = wrap(c.name, bold, size, COL_W.name);
    const subLines = sub ? wrap(sub, font, 8, COL_W.name) : [];
    const serialText = c.serials.length ? c.serials.join(", ") : "";
    const serialLines = wrap(serialText, font, size, COL_W.serial);
    const rowLines = Math.max(nameLines.length + subLines.length, serialLines.length, 1);
    const rowHeight = rowLines * ROW_LEAD + 6;

    if (ctx.y - rowHeight < BOTTOM) {
      newPage(ctx);
      drawColumnHeader(ctx);
    }

    const top = ctx.y;
    const nameColor = c.flaggedMissing ? danger : ink;

    ctx.page.drawText(String(i + 1), { x: COL.idx, y: top, size, font, color: muted });

    let ny = top;
    for (const line of nameLines) {
      ctx.page.drawText(line, { x: COL.name, y: ny, size, font: bold, color: nameColor });
      ny -= ROW_LEAD;
    }
    for (const line of subLines) {
      ctx.page.drawText(line, { x: COL.name, y: ny, size: 8, font, color: muted });
      ny -= ROW_LEAD;
    }
    if (c.flaggedMissing) {
      ctx.page.drawText("possibly missing", { x: COL.name, y: ny, size: 7.5, font, color: danger });
    }

    ctx.page.drawText(c.assetCode, { x: COL.code, y: top, size: 8.5, font, color: ink });
    ctx.page.drawText(String(c.quantity), { x: COL.qty, y: top, size, font, color: ink });

    let sy = top;
    for (const line of serialLines) {
      ctx.page.drawText(line, { x: COL.serial, y: sy, size, font, color: ink });
      sy -= ROW_LEAD;
    }

    ctx.y = top - rowHeight;
    ctx.page.drawLine({
      start: { x: MARGIN, y: ctx.y + 4 },
      end: { x: COL.right, y: ctx.y + 4 },
      thickness: 0.5,
      color: rule,
    });
  });

  // Footers (with the final page count) on every page.
  const pages = doc.getPageCount();
  doc.getPages().forEach((page, idx) => {
    ctx.page = page;
    ctx.pageNum = idx + 1;
    drawFooter(ctx, pages);
  });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
