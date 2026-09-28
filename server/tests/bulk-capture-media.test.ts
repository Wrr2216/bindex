import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Frames from video, pages from PDF, and crops. ffmpeg and pdftoppm are
// optional at runtime, so their tests skip with a reason where they are not
// installed; the pure parts always run.

type Media = typeof import("../src/services/bulk-capture/media");
let media: Media;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-capture-test-"));

const onPath = (name: string) =>
  (process.env.PATH ?? "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, name)));
const hasVideo = onPath("ffmpeg") && onPath("ffprobe");
const hasPdf = onPath("pdftoppm");

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  process.env.LOG_LEVEL ??= "error";
  media = await import("../src/services/bulk-capture/media");
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const isJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

describe("frame sampling", () => {
  it("spreads frames across the video, one per few seconds, within the cap", () => {
    assert.deepEqual(media.frameTimes(9, 50), [1.5, 4.5, 7.5]);
    assert.deepEqual(media.frameTimes(2, 50), [1]);
    assert.equal(media.frameTimes(600, 50).length, media.MAX_FRAMES_PER_VIDEO);
    assert.equal(media.frameTimes(600, 5).length, 5);
    assert.deepEqual(media.frameTimes(0, 5), []);
    assert.deepEqual(media.frameTimes(10, 0), []);
  });

  it("reports which tools this machine has", () => {
    assert.deepEqual(media.mediaTools(), { video: hasVideo, pdf: hasPdf });
    assert.equal(media.findTool("definitely-not-a-real-tool-name"), null);
  });

  it("takes JPEG frames from a real video", { skip: hasVideo ? false : "ffmpeg is not installed" }, async () => {
    const file = path.join(dir, "walk.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=7:size=320x240:rate=10",
      "-pix_fmt", "yuv420p", file,
    ]);
    const duration = await media.probeDuration(file);
    assert.ok(duration && Math.abs(duration - 7) < 0.3, `duration ${duration}`);
    const frames = await media.extractFrames(file, media.frameTimes(duration!, 10));
    assert.deepEqual(frames.map((f) => f.ms), [1167, 3500, 5833]);
    for (const f of frames) assert.ok(isJpeg(f.bytes));
    const img = await loadImage(frames[0]!.bytes);
    assert.equal(img.width, 320);
  });

  it("gives nothing for a file that is not a video", { skip: hasVideo ? false : "ffmpeg is not installed" }, async () => {
    const file = path.join(dir, "junk.mp4");
    fs.writeFileSync(file, "not a video");
    assert.equal(await media.probeDuration(file), null);
    assert.deepEqual(await media.extractFrames(file, [1]), []);
  });
});

describe("PDF pages", () => {
  it("renders pages to JPEG, up to the limit", { skip: hasPdf ? false : "pdftoppm is not installed" }, async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) doc.addPage([595, 842]).drawText(`Inventory page ${i}`, { x: 50, y: 780, size: 18, font });
    const pdfDir = fs.mkdtempSync(path.join(dir, "pdf-"));
    const file = path.join(pdfDir, "input.pdf");
    fs.writeFileSync(file, await doc.save());

    const { pages, total } = await media.renderPdfPages(file, 2);
    assert.equal(total, onPath("pdfinfo") ? 3 : null);
    assert.deepEqual(pages.map((p) => p.page), [1, 2]);
    for (const p of pages) assert.ok(isJpeg(p.bytes));
    const img = await loadImage(pages[0]!.bytes);
    assert.equal(Math.max(img.width, img.height), 2000);
  });

  it("fails loudly on a file that is not a PDF", { skip: hasPdf ? false : "pdftoppm is not installed" }, async () => {
    const pdfDir = fs.mkdtempSync(path.join(dir, "bad-"));
    const file = path.join(pdfDir, "input.pdf");
    fs.writeFileSync(file, "%PDF-1.4 but not really");
    await assert.rejects(media.renderPdfPages(file, 2));
  });
});

describe("crops", () => {
  it("cuts out the boxed region with a little padding", async () => {
    const c = createCanvas(1000, 500);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 1000, 500);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(500, 250, 200, 100);
    const img = (await media.decodeImage(c.toBuffer("image/png")))!;
    const crop = await loadImage(media.cropJpeg(img, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }));
    // 200 x 100 px plus 8% each side.
    assert.equal(crop.width, 232);
    assert.equal(crop.height, 116);
    const whole = await loadImage(media.cropJpeg(img, null, 400));
    assert.deepEqual([whole.width, whole.height], [400, 200]);
    assert.equal(await media.decodeImage(Buffer.from("nope")), null);
  });
});
