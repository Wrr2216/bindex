import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import type { CaptureBbox } from "../../db/tables/bulk-capture";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getAttachmentStream } from "../media-ai-core";

/**
 * Turning a video into frames and a PDF into page images, with the external
 * tools that do it best (ffmpeg, and pdftoppm from poppler). Both are
 * optional: when one is not on the PATH the feature says so and takes photos
 * or images only. Arguments are passed as arrays, never through a shell.
 */

const found = new Map<string, string | null>();

/** The absolute path of an executable on PATH, or null. Cached for the process. */
export function findTool(name: string): string | null {
  if (found.has(name)) return found.get(name)!;
  let hit: string | null = null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        hit = candidate;
        break;
      }
    } catch {
      // not here
    }
  }
  found.set(name, hit);
  return hit;
}

/** Which conversions this server can do. */
export function mediaTools(): { video: boolean; pdf: boolean } {
  return {
    video: Boolean(findTool("ffmpeg") && findTool("ffprobe")),
    pdf: Boolean(findTool("pdftoppm")),
  };
}

function run(cmd: string, args: string[], opts: { timeoutMs: number; binary?: boolean }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8").slice(-400) : "";
          reject(new Error(`${path.basename(cmd)} failed: ${err.message}${detail ? ` (${detail.trim()})` : ""}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Copy an attachment to a temporary file, for tools that need a path. */
export async function attachmentToTempFile(attachmentId: string, ext: string): Promise<{ dir: string; file: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bindex-capture-"));
  const file = path.join(dir, `input.${ext}`);
  try {
    const opened = await getAttachmentStream(attachmentId);
    if (opened.status === 416) throw new Error("empty attachment");
    await pipeline(opened.stream, fs.createWriteStream(file));
    return { dir, file };
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Seconds of video, from ffprobe. */
export async function probeDuration(file: string): Promise<number | null> {
  const ffprobe = findTool("ffprobe");
  if (!ffprobe) return null;
  try {
    const out = await run(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { timeoutMs: 30_000 },
    );
    const seconds = Number(out.toString("utf8").trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (err) {
    logger.warn("bulk_capture.video.probe_failed", { err: describeError(err) });
    return null;
  }
}

/** One frame every this many seconds of walkthrough video. */
export const FRAME_EVERY_SECONDS = 3;
export const MAX_FRAMES_PER_VIDEO = 24;

/**
 * Evenly spaced sample times, in the middle of each slice so the first frame
 * is not the black one a recording often starts with. Pure.
 */
export function frameTimes(durationSec: number, max: number): number[] {
  if (!(durationSec > 0) || max < 1) return [];
  const count = Math.max(1, Math.min(max, MAX_FRAMES_PER_VIDEO, Math.ceil(durationSec / FRAME_EVERY_SECONDS)));
  const step = durationSec / count;
  return Array.from({ length: count }, (_, i) => Math.round((i + 0.5) * step * 1000) / 1000);
}

/**
 * JPEG frames from a video file at the given times. Each is scaled to at most
 * 1600 px, which is all a vision model is sent anyway.
 */
export async function extractFrames(file: string, times: number[]): Promise<{ ms: number; bytes: Buffer }[]> {
  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) return [];
  const frames: { ms: number; bytes: Buffer }[] = [];
  for (const t of times) {
    try {
      const bytes = await run(
        ffmpeg,
        [
          "-hide_banner", "-loglevel", "error",
          // Seeking before -i jumps to the nearest keyframe and decodes from
          // there, which is fast and exact enough for a walkthrough.
          "-ss", String(t),
          "-i", file,
          "-frames:v", "1",
          "-vf", "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease",
          "-q:v", "3",
          "-f", "image2", "-c:v", "mjpeg", "pipe:1",
        ],
        { timeoutMs: 60_000 },
      );
      if (bytes.length) frames.push({ ms: Math.round(t * 1000), bytes });
    } catch (err) {
      logger.warn("bulk_capture.video.frame_failed", { at: t, err: describeError(err) });
    }
  }
  return frames;
}

/** Pages in a PDF, from pdfinfo when it is there. */
async function pdfPageCount(file: string): Promise<number | null> {
  const pdfinfo = findTool("pdfinfo");
  if (!pdfinfo) return null;
  try {
    const out = (await run(pdfinfo, [file], { timeoutMs: 30_000 })).toString("utf8");
    const m = /^Pages:\s+(\d+)/m.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The first `maxPages` pages of a PDF as JPEGs, 150 dpi and at most 2000 px, which
 * keeps handwriting legible. `total` is the page count when it could be read.
 */
export async function renderPdfPages(
  file: string,
  maxPages: number,
): Promise<{ pages: { page: number; bytes: Buffer }[]; total: number | null }> {
  const pdftoppm = findTool("pdftoppm");
  if (!pdftoppm || maxPages < 1) return { pages: [], total: null };
  const total = await pdfPageCount(file);
  const last = total ? Math.min(total, maxPages) : maxPages;
  const outDir = path.dirname(file);
  const prefix = path.join(outDir, "page");
  await run(
    pdftoppm,
    ["-jpeg", "-jpegopt", "quality=85", "-r", "150", "-scale-to", "2000", "-f", "1", "-l", String(last), file, prefix],
    { timeoutMs: 180_000 },
  );
  const names = (await fsp.readdir(outDir)).filter((n) => /^page-\d+\.jpg$/.test(n));
  const pages = await Promise.all(
    names.map(async (n) => ({ page: Number(/(\d+)\.jpg$/.exec(n)![1]), bytes: await fsp.readFile(path.join(outDir, n)) })),
  );
  pages.sort((a, b) => a.page - b.page);
  return { pages, total };
}

export async function removeTemp(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

// ---- Crops -------------------------------------------------------------------

export async function decodeImage(bytes: Buffer): Promise<Image | null> {
  try {
    const img = await loadImage(bytes);
    return img.width && img.height ? img : null;
  } catch (err) {
    logger.debug("bulk_capture.decode_failed", { err: describeError(err) });
    return null;
  }
}

/**
 * A JPEG of one region of an image, padded a little so the thing is not cut
 * off at the edge, or of the whole image when there is no box. At most
 * `maxEdge` px on its longest side.
 */
export function cropJpeg(img: Image, bbox: CaptureBbox | null, maxEdge = 800): Buffer {
  const pad = bbox ? 0.08 : 0;
  const bx = bbox ?? { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.max(0, bx.x - bx.w * pad);
  const y0 = Math.max(0, bx.y - bx.h * pad);
  const x1 = Math.min(1, bx.x + bx.w * (1 + pad));
  const y1 = Math.min(1, bx.y + bx.h * (1 + pad));
  const sx = Math.floor(x0 * img.width);
  const sy = Math.floor(y0 * img.height);
  const sw = Math.max(1, Math.ceil((x1 - x0) * img.width));
  const sh = Math.max(1, Math.ceil((y1 - y0) * img.height));
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return canvas.toBuffer("image/jpeg", 82);
}
