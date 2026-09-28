import path from "node:path";
import bwipjs from "bwip-js";
import { createCanvas, GlobalFonts, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { PDFDocument, rgb } from "pdf-lib";
import type { CrewWorker } from "../../db/schema";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { readAttachmentBytes, renderJpeg } from "../media-ai-core";

/**
 * Printable crew badges: a CR80 card (the size of a bank card, portrait) with
 * the worker's photo, name, company and a QR that checks them in. Drawn with
 * the same canvas, bwip-js and pdf-lib pipeline as item labels.
 *
 * The QR holds a link to /crew/badge/<code>: scanned in the app it checks the
 * worker in; scanned with a phone's own camera it opens their page.
 */

const DPI = 300;
const MM_TO_PT = 72 / 25.4;
export const CARD_W_MM = 53.98;
export const CARD_H_MM = 85.6;
const W = Math.round((CARD_W_MM / 25.4) * DPI);
const H = Math.round((CARD_H_MM / 25.4) * DPI);
const PAD = 28;

let fontReady = false;
function ensureFont(): void {
  if (fontReady) return;
  try {
    const dir = path.join(path.dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
    GlobalFonts.registerFromPath(path.join(dir, "DejaVuSans.ttf"), "Badge");
    GlobalFonts.registerFromPath(path.join(dir, "DejaVuSans-Bold.ttf"), "Badge Bold");
  } catch {
    // Fall back to whatever system fonts exist.
  }
  fontReady = true;
}

export const badgeUrl = (code: string) => `${env.APP_BASE_URL.replace(/\/+$/, "")}/crew/badge/${encodeURIComponent(code)}`;

export type BadgeData = {
  name: string;
  company: string | null;
  role: string | null;
  code: string;
  title: string;
  accent: string;
  photo: Buffer | null;
};

/** Longest prefix of `text` that fits `width`, with an ellipsis when cut. */
function fit(ctx: SKRSContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** The name on at most two lines, at the largest size between max and min that fits. */
function nameLines(ctx: SKRSContext2D, name: string, width: number): { size: number; lines: string[] } {
  const words = name.split(/\s+/).filter(Boolean);
  for (let size = 50; size >= 30; size -= 2) {
    ctx.font = `bold ${size}px 'Badge Bold', sans-serif`;
    const lines: string[] = [];
    let line = "";
    let ok = true;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= width) {
        line = next;
        continue;
      }
      if (!line || lines.length === 1) {
        ok = false;
        break;
      }
      lines.push(line);
      line = word;
    }
    if (ok) {
      if (line) lines.push(line);
      if (lines.every((l) => ctx.measureText(l).width <= width)) return { size, lines };
    }
  }
  ctx.font = "bold 30px 'Badge Bold', sans-serif";
  return { size: 30, lines: [fit(ctx, name, width)] };
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export async function renderBadgeCanvas(data: BadgeData): Promise<Canvas> {
  ensureFont();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const cx = W / 2;
  const inner = W - PAD * 2;

  // Band with the organisation's name, in the instance accent colour.
  ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(data.accent) ? data.accent : "#0284c7";
  ctx.fillRect(0, 0, W, 120);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 38px 'Badge Bold', sans-serif";
  ctx.fillText(fit(ctx, data.title, inner), cx, 40);

  // Photo, cropped to fill its frame; initials when there is none.
  const pw = 250;
  const ph = 300;
  const px = Math.round(cx - pw / 2);
  const py = 145;
  let drewPhoto = false;
  if (data.photo) {
    try {
      const img = await loadImage(data.photo);
      const scale = Math.max(pw / img.width, ph / img.height);
      const sw = pw / scale;
      const sh = ph / scale;
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 3, sw, sh, px, py, pw, ph);
      drewPhoto = true;
    } catch (err) {
      logger.debug("crew.badge.photo_unreadable", { err: describeError(err) });
    }
  }
  if (!drewPhoto) {
    ctx.fillStyle = "#e2e8f0";
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = "#64748b";
    ctx.font = "bold 110px 'Badge Bold', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(data.name) || "?", cx, py + ph / 2);
    ctx.textBaseline = "top";
  }
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, pw, ph);

  // Name, company, role.
  let y = py + ph + 20;
  const { size, lines } = nameLines(ctx, data.name, inner);
  ctx.fillStyle = "#0f172a";
  ctx.font = `bold ${size}px 'Badge Bold', sans-serif`;
  for (const line of lines) {
    ctx.fillText(line, cx, y);
    y += Math.round(size * 1.12);
  }
  ctx.fillStyle = "#334155";
  if (data.company) {
    y += 6;
    ctx.font = "28px 'Badge', sans-serif";
    ctx.fillText(fit(ctx, data.company, inner), cx, y);
    y += 34;
  }
  if (data.role) {
    ctx.font = "26px 'Badge', sans-serif";
    ctx.fillStyle = "#64748b";
    ctx.fillText(fit(ctx, data.role, inner), cx, y);
  }

  // QR and the code beneath it, anchored to the bottom.
  const qrSize = 250;
  const codeY = H - PAD - 34;
  const qrY = codeY - 8 - qrSize;
  const qrPng = await bwipjs.toBuffer({
    bcid: "qrcode",
    text: badgeUrl(data.code),
    scale: 4,
    paddingwidth: 0,
    paddingheight: 0,
  });
  const qr = await loadImage(qrPng);
  ctx.drawImage(qr, Math.round(cx - qrSize / 2), qrY, qrSize, qrSize);
  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 30px 'Badge Bold', sans-serif";
  ctx.fillText(fit(ctx, data.code, inner), cx, codeY);

  return canvas;
}

export async function badgePng(data: BadgeData): Promise<Buffer> {
  return (await renderBadgeCanvas(data)).toBuffer("image/png");
}

/** The worker's badge photo, shrunk for printing, or null when there is none or it cannot be read. */
export async function badgePhoto(worker: CrewWorker): Promise<Buffer | null> {
  if (!worker.photoAttachmentId) return null;
  try {
    const { bytes } = await readAttachmentBytes(worker.photoAttachmentId, 32 * 1024 * 1024);
    return await renderJpeg(bytes, { maxEdge: 900 });
  } catch (err) {
    logger.debug("crew.badge.photo_missing", { workerId: worker.id, err: describeError(err) });
    return null;
  }
}

/**
 * Badges as a PDF. "card" is one exact-size page per badge, for card
 * printers; "sheet" puts nine to a US Letter page with cut marks, for an
 * ordinary printer and a badge holder.
 */
export async function badgesPdf(badges: BadgeData[], layout: "card" | "sheet"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const pngs = await Promise.all(badges.map((b) => badgePng(b)));
  const cw = CARD_W_MM * MM_TO_PT;
  const ch = CARD_H_MM * MM_TO_PT;
  if (layout === "card") {
    for (const png of pngs) {
      const img = await doc.embedPng(png);
      doc.addPage([cw, ch]).drawImage(img, { x: 0, y: 0, width: cw, height: ch });
    }
  } else {
    const pageW = 8.5 * 72;
    const pageH = 11 * 72;
    const cols = 3;
    const rows = 3;
    const gap = 4 * MM_TO_PT;
    const left = (pageW - cols * cw - (cols - 1) * gap) / 2;
    const top = (pageH - rows * ch - (rows - 1) * gap) / 2;
    const mark = rgb(0.6, 0.6, 0.6);
    for (let i = 0; i < pngs.length; i += cols * rows) {
      const page = doc.addPage([pageW, pageH]);
      for (let j = 0; j < cols * rows && i + j < pngs.length; j++) {
        const img = await doc.embedPng(pngs[i + j]!);
        const x = left + (j % cols) * (cw + gap);
        const y = pageH - top - (Math.floor(j / cols) + 1) * ch - Math.floor(j / cols) * gap;
        page.drawImage(img, { x, y, width: cw, height: ch });
        page.drawRectangle({ x, y, width: cw, height: ch, borderColor: mark, borderWidth: 0.4 });
      }
    }
  }
  if (pngs.length === 0) doc.addPage([cw, ch]);
  return Buffer.from(await doc.save());
}
