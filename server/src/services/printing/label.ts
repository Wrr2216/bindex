import path from "node:path";
import { createCanvas, loadImage, GlobalFonts, type Canvas } from "@napi-rs/canvas";
import bwipjs from "bwip-js";
import { env } from "../../env";

// Physical label on DK-22205 62mm continuous tape (across tape × feed length),
// landscape. These mm values also size the printed PDF page.
export const LABEL_W_MM = env.LABEL_WIDTH_MM;
export const LABEL_H_MM = env.LABEL_HEIGHT_MM;
const DPI = 300;
const W = Math.round((LABEL_W_MM / 25.4) * DPI);
const H = Math.round((LABEL_H_MM / 25.4) * DPI);
const PAD = 24;

let fontReady = false;
function ensureFont(): void {
  if (fontReady) return;
  try {
    const dir = path.join(path.dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
    GlobalFonts.registerFromPath(path.join(dir, "DejaVuSans.ttf"), "Label");
    GlobalFonts.registerFromPath(path.join(dir, "DejaVuSans-Bold.ttf"), "Label Bold");
  } catch {
    // Fall back to whatever system fonts exist (dev machines have them).
  }
  fontReady = true;
}

export type LabelData = { name: string; code: string; sub?: string; url?: string };

function wrapLines(
  ctx: ReturnType<Canvas["getContext"]>,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines - 1) {
      const rest = words.slice(i).join(" ");
      let fit = rest;
      while (fit.length > 1 && ctx.measureText(fit).width > maxWidth) fit = fit.slice(0, -1);
      lines.push(fit.length < rest.length ? `${fit.replace(/\s?\S$/, "")}…` : fit);
      return lines;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Wrap the full text into at most maxLines without truncating; returns null if
 *  it doesn't fit (caller can then try a smaller font). */
function fitLines(
  ctx: ReturnType<Canvas["getContext"]>,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (ctx.measureText(word).width > maxWidth) return null; // single word too wide
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) return null; // would spill past maxLines
  }
  if (line) lines.push(line);
  return lines;
}

/** Render an item label to a canvas: content centered as a block. */
export async function renderLabelCanvas(data: LabelData): Promise<Canvas> {
  ensureFont();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";

  // Optional QR (deep-links to the item page). Drawn as a square on the left;
  // the text/barcode stack then uses the remaining width on the right.
  let contentLeft = PAD;
  let contentRight = W - PAD;
  if (data.url) {
    const qrSize = H - PAD * 2;
    const qrPng = await bwipjs.toBuffer({
      bcid: "qrcode",
      text: data.url,
      scale: 4,
      paddingwidth: 0,
      paddingheight: 0,
    });
    const qr = await loadImage(qrPng);
    ctx.drawImage(qr, PAD, Math.round((H - qrSize) / 2), qrSize, qrSize);
    contentLeft = PAD + qrSize + PAD;
  }

  const cx = Math.round((contentLeft + contentRight) / 2);
  const maxW = contentRight - contentLeft;

  // --- measure the stack so it can be vertically centered ---
  const subSize = 22;
  const codeSize = 26;
  const barcodeH = Math.round(H * 0.34);
  const gap = 10;

  // Fit the full name across up to 2 lines, shrinking the font as needed so long
  // names stay readable instead of being chopped mid-word ("…"). Only fall back
  // to truncation if the name is still too long at the smallest size.
  const NAME_MAX = 40;
  const NAME_MIN = 24;
  const NAME_LINES = 2;
  let nameSize = NAME_MAX;
  let nameLines: string[] | null = null;
  for (let size = NAME_MAX; size >= NAME_MIN; size -= 2) {
    ctx.font = `bold ${size}px 'Label Bold', sans-serif`;
    const fitted = fitLines(ctx, data.name, maxW, NAME_LINES);
    if (fitted) {
      nameSize = size;
      nameLines = fitted;
      break;
    }
  }
  if (!nameLines) {
    nameSize = NAME_MIN;
    ctx.font = `bold ${nameSize}px 'Label Bold', sans-serif`;
    nameLines = wrapLines(ctx, data.name, maxW, NAME_LINES);
  }
  const nameLineH = Math.round(nameSize * 1.1);

  let stackH = nameLines.length * nameLineH;
  if (data.sub) stackH += gap * 0.5 + subSize;
  stackH += gap + barcodeH + gap * 0.5 + codeSize;

  let y = Math.max(PAD, Math.round((H - stackH) / 2));

  // Name
  ctx.font = `bold ${nameSize}px 'Label Bold', sans-serif`;
  for (const line of nameLines) {
    ctx.fillText(line, cx, y);
    y += nameLineH;
  }

  // Sub line
  if (data.sub) {
    y += gap * 0.5;
    ctx.font = `${subSize}px 'Label', sans-serif`;
    ctx.fillStyle = "#333333";
    ctx.fillText(data.sub, cx, y);
    ctx.fillStyle = "#000000";
    y += subSize;
  }

  // Barcode (centered, ~80% width for quiet zones)
  y += gap;
  const bcW = Math.round(maxW * 0.92);
  const barcodePng = await bwipjs.toBuffer({
    bcid: "code128",
    text: data.code,
    scale: 4,
    height: 14,
    includetext: false,
    paddingwidth: 0,
    paddingheight: 0,
  });
  const barcode = await loadImage(barcodePng);
  ctx.drawImage(barcode, Math.round(cx - bcW / 2), y, bcW, barcodeH);
  y += barcodeH + gap * 0.5;

  // Human-readable code
  ctx.font = `${codeSize}px 'Label', sans-serif`;
  ctx.fillText(data.code, cx, y);

  return canvas;
}

/** On-screen preview: always readable (un-rotated). */
export async function renderLabelPng(data: LabelData): Promise<Buffer> {
  const canvas = await renderLabelCanvas(data);
  return canvas.toBuffer("image/png");
}

// Compact label: just the QR code with the code printed beneath it. A small
// square that fits where the full label won't.
export const COMPACT_SIDE_MM = Math.min(LABEL_W_MM, LABEL_H_MM);
const COMPACT_SIDE = Math.round((COMPACT_SIDE_MM / 25.4) * DPI);
const COMPACT_PAD = 10;

export type CompactLabelData = { code: string; url: string };

/** Render a compact label (QR + code) to a square canvas. */
export async function renderCompactLabelCanvas(data: CompactLabelData): Promise<Canvas> {
  ensureFont();
  const canvas = createCanvas(COMPACT_SIDE, COMPACT_SIDE);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, COMPACT_SIDE, COMPACT_SIDE);
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";

  // Shrink the code text until it fits the label width.
  const maxW = COMPACT_SIDE - COMPACT_PAD * 2;
  let codeSize = 30;
  ctx.font = `${codeSize}px 'Label', sans-serif`;
  while (codeSize > 14 && ctx.measureText(data.code).width > maxW) {
    codeSize -= 2;
    ctx.font = `${codeSize}px 'Label', sans-serif`;
  }

  const gap = 6;
  const qrSize = COMPACT_SIDE - COMPACT_PAD * 2 - codeSize - gap;
  const qrPng = await bwipjs.toBuffer({
    bcid: "qrcode",
    text: data.url,
    scale: 4,
    paddingwidth: 0,
    paddingheight: 0,
  });
  const qr = await loadImage(qrPng);
  ctx.drawImage(qr, Math.round((COMPACT_SIDE - qrSize) / 2), COMPACT_PAD, qrSize, qrSize);
  ctx.fillText(data.code, Math.round(COMPACT_SIDE / 2), COMPACT_PAD + qrSize + gap);

  return canvas;
}

/** On-screen preview of a compact label. */
export async function renderCompactPng(data: CompactLabelData): Promise<Buffer> {
  const canvas = await renderCompactLabelCanvas(data);
  return canvas.toBuffer("image/png");
}

function rotateCanvas(src: Canvas, deg: number): Canvas {
  const swap = deg === 90 || deg === 270;
  const out = createCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = out.getContext("2d");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

/** Print-oriented render: rotated to the driver's feed orientation, with the
 *  page dimensions (mm) that match the rotated image. */
export async function renderPrintLabel(
  data: LabelData,
): Promise<{ png: Buffer; wMm: number; hMm: number }> {
  const canvas = await renderLabelCanvas(data);
  const deg = ((Math.round(env.LABEL_ROTATE_DEG / 90) * 90) % 360 + 360) % 360;
  const out = deg === 0 ? canvas : rotateCanvas(canvas, deg);
  const swap = deg === 90 || deg === 270;
  return {
    png: out.toBuffer("image/png"),
    wMm: swap ? LABEL_H_MM : LABEL_W_MM,
    hMm: swap ? LABEL_W_MM : LABEL_H_MM,
  };
}

/** Print-oriented compact render: square page, so rotation only re-orients content. */
export async function renderPrintCompactLabel(
  data: CompactLabelData,
): Promise<{ png: Buffer; wMm: number; hMm: number }> {
  const canvas = await renderCompactLabelCanvas(data);
  const deg = ((Math.round(env.LABEL_ROTATE_DEG / 90) * 90) % 360 + 360) % 360;
  const out = deg === 0 ? canvas : rotateCanvas(canvas, deg);
  return { png: out.toBuffer("image/png"), wMm: COMPACT_SIDE_MM, hMm: COMPACT_SIDE_MM };
}
