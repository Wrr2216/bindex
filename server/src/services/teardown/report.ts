import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import bwipjs from "bwip-js";
import type { TeardownPartKind } from "../../db/tables/teardown";
import type { LabelData } from "../printing";
import { clip, formatClock } from "./extract";

/**
 * The printable teardown report: every step with its time in the video, its
 * callout and its picture, the parts detached with a box to tick at
 * reassembly, and the steps again in reverse as a reassembly checklist. Takes
 * plain data and JPEG bytes, so it can be tested without a database.
 */

export type ReportStep = {
  n: number;
  title: string;
  instruction: string;
  start: number | null;
  end: number | null;
  callout: string | null;
  /** A JPEG, already scaled down. */
  picture: Buffer | null;
};

export type ReportPart = {
  name: string;
  kind: TeardownPartKind;
  qty: number;
  stepN: number | null;
  note: string | null;
  reassembled: boolean;
};

export type ReportInput = {
  appName: string;
  printedAt: Date;
  timeZone: string;
  guideUrl: string;
  title: string;
  itemName: string | null;
  itemCode: string | null;
  unitName: string | null;
  durationSec: number | null;
  notes: string | null;
  steps: ReportStep[];
  parts: ReportPart[];
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const RIGHT = PAGE_W - MARGIN;
const BOTTOM = MARGIN + 28;
const PICTURE_W = 150;
const PICTURE_MAX_H = 120;

const ink = rgb(0.07, 0.09, 0.13);
const muted = rgb(0.42, 0.46, 0.52);
const rule = rgb(0.8, 0.83, 0.87);
const amber = rgb(0.71, 0.45, 0.03);
const amberBg = rgb(1, 0.97, 0.88);

// The standard PDF fonts only cover Windows-1252. Everything outside it is
// transliterated where Unicode can, and replaced where it cannot, so a
// transcript in any language never stops the report from printing.
const WIN_ANSI_EXTRA = new Set([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"]);
const REPLACEMENTS: Record<string, string> = { "−": "-", "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "≈": "~", " ": " " };

export function pdfText(text: string): string {
  let out = "";
  for (const ch of text.replace(/[\t\r\n]+/g, " ")) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    if (REPLACEMENTS[ch]) {
      out += REPLACEMENTS[ch];
      continue;
    }
    const plain = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += plain && [...plain].every((c) => c.codePointAt(0)! >= 0x20 && c.codePointAt(0)! <= 0x7e) ? plain : "?";
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const raw of pdfText(text).split(/\s+/).filter(Boolean)) {
    // Break a single very long token (a part number, a URL) across lines.
    const words: string[] = [];
    let cur = "";
    for (const ch of raw) {
      if (cur && font.widthOfTextAtSize(cur + ch, size) > max) {
        words.push(cur);
        cur = ch;
      } else cur += ch;
    }
    if (cur) words.push(cur);
    for (const word of words) {
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

const KIND_LABEL: Record<TeardownPartKind, string> = {
  hardware: "Hardware",
  component: "Component",
  cable: "Cable",
  other: "Other",
};

export const partLine = (p: { qty: number; name: string }) => (p.qty > 1 ? `${p.qty} × ${p.name}` : p.name);

function timeRange(start: number | null, end: number | null): string {
  if (start === null) return "";
  return end !== null && end > start ? `${formatClock(start)}-${formatClock(end)}` : formatClock(start);
}

type Ctx = { doc: PDFDocument; font: PDFFont; bold: PDFFont; page: PDFPage; y: number };

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.y = PAGE_H - MARGIN;
}

function ensure(ctx: Ctx, height: number): void {
  if (ctx.y - height < BOTTOM) newPage(ctx);
}

function text(ctx: Ctx, s: string, x: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}): void {
  ctx.page.drawText(pdfText(s), { x, y: ctx.y, size, font: opts.bold ? ctx.bold : ctx.font, color: opts.color ?? ink });
}

function sectionHeading(ctx: Ctx, label: string): void {
  ensure(ctx, 40);
  ctx.y -= 10;
  text(ctx, label.toUpperCase(), MARGIN, 9, { bold: true, color: muted });
  ctx.y -= 6;
  ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y }, end: { x: RIGHT, y: ctx.y }, thickness: 1, color: rule });
  ctx.y -= 16;
}

function checkbox(ctx: Ctx, x: number, checked: boolean): void {
  ctx.page.drawRectangle({ x, y: ctx.y - 1, width: 8, height: 8, borderColor: ink, borderWidth: 0.8 });
  if (checked) {
    ctx.page.drawLine({ start: { x: x + 1.5, y: ctx.y + 3 }, end: { x: x + 3.5, y: ctx.y + 0.5 }, thickness: 1.2, color: ink });
    ctx.page.drawLine({ start: { x: x + 3.5, y: ctx.y + 0.5 }, end: { x: x + 7, y: ctx.y + 6.5 }, thickness: 1.2, color: ink });
  }
}

export async function teardownReportPdf(input: ReportInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfText(input.title));
  doc.setCreator(pdfText(input.appName));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };
  const printed = formatPrinted(input.printedAt, input.timeZone);

  // ---- Header ----------------------------------------------------------------
  const headerRight = RIGHT - 96;
  text(ctx, "TEARDOWN GUIDE", MARGIN, 9, { bold: true, color: muted });
  ctx.y -= 26;
  for (const line of wrap(input.title, bold, 20, headerRight - MARGIN)) {
    text(ctx, line, MARGIN, 20, { bold: true });
    ctx.y -= 24;
  }
  const record = [input.itemName, input.itemCode, input.unitName ? `Unit ${input.unitName}` : null].filter(Boolean).join("  ·  ");
  for (const line of record ? wrap(record, font, 11, headerRight - MARGIN) : []) {
    text(ctx, line, MARGIN, 11, { color: muted });
    ctx.y -= 15;
  }
  const hardware = input.parts.filter((p) => p.kind === "hardware").reduce((n, p) => n + p.qty, 0);
  const summary = [
    `${input.steps.length} step${input.steps.length === 1 ? "" : "s"}`,
    `${input.parts.length} part${input.parts.length === 1 ? "" : "s"} detached`,
    hardware ? `${hardware} piece${hardware === 1 ? "" : "s"} of hardware` : null,
    input.durationSec ? `video ${formatClock(input.durationSec)}` : null,
    `printed ${printed}`,
  ]
    .filter(Boolean)
    .join("  ·  ");
  for (const line of wrap(summary, font, 10, headerRight - MARGIN)) {
    text(ctx, line, MARGIN, 10);
    ctx.y -= 13;
  }

  const qr = await doc.embedPng(
    await bwipjs.toBuffer({ bcid: "qrcode", text: input.guideUrl, scale: 3, paddingwidth: 0, paddingheight: 0 }),
  );
  ctx.page.drawImage(qr, { x: RIGHT - 84, y: PAGE_H - MARGIN - 84 + 6, width: 84, height: 84 });
  ctx.y = Math.min(ctx.y, PAGE_H - MARGIN - 96);

  if (input.notes) {
    ctx.y -= 4;
    for (const line of wrap(input.notes, font, 10, RIGHT - MARGIN)) {
      ensure(ctx, 14);
      text(ctx, line, MARGIN, 10, { color: muted });
      ctx.y -= 13;
    }
  }

  // ---- Callouts, together, before anyone starts ------------------------------
  const callouts = input.steps.filter((s) => s.callout);
  if (callouts.length) {
    sectionHeading(ctx, "Watch for");
    for (const s of callouts) {
      const lines = wrap(`Step ${s.n}: ${s.callout}`, bold, 10, RIGHT - MARGIN - 16);
      const h = lines.length * 13 + 8;
      ensure(ctx, h);
      ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - h + 13, width: RIGHT - MARGIN, height: h, color: amberBg });
      ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - h + 13, width: 3, height: h, color: amber });
      ctx.y -= 2;
      for (const line of lines) {
        text(ctx, line, MARGIN + 10, 10, { bold: true, color: amber });
        ctx.y -= 13;
      }
      ctx.y -= 8;
    }
  }

  // ---- Steps -----------------------------------------------------------------
  sectionHeading(ctx, "Disassembly steps");
  if (!input.steps.length) {
    text(ctx, "No steps have been written yet.", MARGIN, 10, { color: muted });
    ctx.y -= 14;
  }
  const partsByStep = new Map<number, ReportPart[]>();
  for (const p of input.parts) {
    if (p.stepN === null) continue;
    partsByStep.set(p.stepN, [...(partsByStep.get(p.stepN) ?? []), p]);
  }
  for (const s of input.steps) {
    let picture: PDFImage | null = null;
    if (s.picture) {
      try {
        picture = await doc.embedJpg(s.picture);
      } catch {
        picture = null;
      }
    }
    const pictureH = picture ? Math.min(PICTURE_MAX_H, (PICTURE_W * picture.height) / picture.width) : 0;
    const textX = MARGIN + 28;
    const textW = RIGHT - textX - (picture ? PICTURE_W + 12 : 0);
    const titleLines = wrap(s.title, bold, 12, textW);
    const bodyLines = s.instruction && s.instruction !== s.title ? wrap(s.instruction, font, 10, textW) : [];
    const calloutLines = s.callout ? wrap(s.callout, bold, 9.5, textW - 10) : [];
    const detached = partsByStep.get(s.n) ?? [];
    const partLines = detached.length ? wrap(`Detached: ${detached.map(partLine).join(", ")}`, font, 9, textW) : [];
    const range = timeRange(s.start, s.end);
    const textH =
      titleLines.length * 15 +
      (range ? 12 : 0) +
      bodyLines.length * 13 +
      (calloutLines.length ? calloutLines.length * 12 + 8 : 0) +
      partLines.length * 12;
    const blockH = Math.max(textH, pictureH) + 14;
    ensure(ctx, Math.min(blockH, PAGE_H - MARGIN - BOTTOM));

    const top = ctx.y;
    text(ctx, String(s.n), MARGIN, 14, { bold: true });
    if (picture) {
      ctx.page.drawImage(picture, { x: RIGHT - PICTURE_W, y: top - pictureH + 10, width: PICTURE_W, height: pictureH });
    }
    for (const line of titleLines) {
      text(ctx, line, textX, 12, { bold: true });
      ctx.y -= 15;
    }
    if (range) {
      text(ctx, `Video ${range}`, textX, 9, { color: muted });
      ctx.y -= 12;
    }
    for (const line of bodyLines) {
      ensure(ctx, 13);
      text(ctx, line, textX, 10);
      ctx.y -= 13;
    }
    if (calloutLines.length) {
      const h = calloutLines.length * 12 + 6;
      ctx.page.drawRectangle({ x: textX, y: ctx.y - h + 11, width: textW, height: h, color: amberBg });
      ctx.page.drawRectangle({ x: textX, y: ctx.y - h + 11, width: 2.5, height: h, color: amber });
      ctx.y -= 2;
      for (const line of calloutLines) {
        text(ctx, line, textX + 8, 9.5, { bold: true, color: amber });
        ctx.y -= 12;
      }
      ctx.y -= 6;
    }
    for (const line of partLines) {
      text(ctx, line, textX, 9, { color: muted });
      ctx.y -= 12;
    }
    ctx.y = Math.min(ctx.y, top - pictureH) - 8;
    ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y + 4 }, end: { x: RIGHT, y: ctx.y + 4 }, thickness: 0.5, color: rule });
    ctx.y -= 8;
  }

  // ---- Parts -----------------------------------------------------------------
  sectionHeading(ctx, "Parts detached");
  if (!input.parts.length) {
    text(ctx, "No parts have been listed.", MARGIN, 10, { color: muted });
    ctx.y -= 14;
  } else {
    const COL = { box: MARGIN, name: MARGIN + 16, kind: 360, qty: 440, step: 490 };
    const head = () => {
      for (const [label, x] of [["Part", COL.name], ["Kind", COL.kind], ["Qty", COL.qty], ["Step", COL.step]] as const) {
        text(ctx, label.toUpperCase(), x, 8, { bold: true, color: muted });
      }
      ctx.y -= 14;
    };
    head();
    for (const p of input.parts) {
      const lines = wrap(p.note ? `${p.name} (${p.note})` : p.name, font, 9.5, COL.kind - COL.name - 8);
      const h = lines.length * 12 + 4;
      if (ctx.y - h < BOTTOM) {
        newPage(ctx);
        head();
      }
      checkbox(ctx, COL.box, p.reassembled);
      text(ctx, KIND_LABEL[p.kind], COL.kind, 9.5, { color: muted });
      text(ctx, String(p.qty), COL.qty, 9.5);
      text(ctx, p.stepN === null ? "-" : String(p.stepN), COL.step, 9.5);
      for (const line of lines) {
        text(ctx, line, COL.name, 9.5);
        ctx.y -= 12;
      }
      ctx.y -= 4;
    }
  }

  // ---- Reassembly, in reverse -------------------------------------------------
  if (input.steps.length > 1) {
    sectionHeading(ctx, "Reassembly (reverse order)");
    for (const s of [...input.steps].reverse()) {
      const detached = partsByStep.get(s.n) ?? [];
      const suffix = detached.length ? ` - refit ${detached.map(partLine).join(", ")}` : "";
      const lines = wrap(`Step ${s.n}: ${s.title}${suffix}`, font, 10, RIGHT - MARGIN - 16);
      ensure(ctx, lines.length * 13 + 4);
      checkbox(ctx, MARGIN, false);
      for (const line of lines) {
        text(ctx, line, MARGIN + 16, 10);
        ctx.y -= 13;
      }
      ctx.y -= 4;
    }
  }

  // ---- Footers ---------------------------------------------------------------
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const y = MARGIN - 14;
    page.drawText(pdfText(`${clip(input.title, 70)}  ·  printed ${printed}`), { x: MARGIN, y, size: 8, font, color: muted });
    const right = pdfText(`${input.appName}  ·  Page ${i + 1} of ${pages.length}`);
    page.drawText(right, { x: RIGHT - font.widthOfTextAtSize(right, 8), y, size: 8, font, color: muted });
  });

  return Buffer.from(await doc.save());
}

// ---- Bag labels ----------------------------------------------------------------

export type BagInput = {
  guideId: string;
  baseUrl: string;
  itemName: string;
  unitName: string | null;
  /** The asset code of the unit, or of the item: scanning the bag opens it. */
  code: string;
  steps: { n: number; title: string }[];
  parts: { name: string; kind: TeardownPartKind; qty: number; stepN: number | null }[];
};

/**
 * One label per bag of hardware: a bag per step that detached any, and one for
 * hardware not tied to a step. The barcode is the item's (or unit's) own code,
 * so a scan brings up the record; the QR opens the guide at that step.
 */
export function bagLabels(input: BagInput, onlySteps?: number[] | null): LabelData[] {
  const hardware = input.parts.filter((p) => p.kind === "hardware");
  const sub = clip(input.unitName ? `${input.itemName} · ${input.unitName}` : input.itemName, 40);
  const guideUrl = `${input.baseUrl.replace(/\/+$/, "")}/teardown/${input.guideId}`;
  const labels: LabelData[] = [];
  for (const step of input.steps) {
    if (onlySteps?.length && !onlySteps.includes(step.n)) continue;
    const mine = hardware.filter((p) => p.stepN === step.n);
    if (!mine.length) continue;
    labels.push({
      name: clip(`Step ${step.n}: ${mine.map(partLine).join(", ")}`, 110),
      sub,
      code: input.code,
      url: `${guideUrl}?step=${step.n}`,
    });
  }
  const loose = hardware.filter((p) => p.stepN === null);
  if (loose.length && (!onlySteps?.length || onlySteps.includes(0))) {
    labels.push({ name: clip(`Hardware: ${loose.map(partLine).join(", ")}`, 110), sub, code: input.code, url: guideUrl });
  }
  return labels;
}
