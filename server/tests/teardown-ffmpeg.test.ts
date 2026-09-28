import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { haveFfmpeg, makeSampleVideo } from "./teardown-fixtures";

// The ffmpeg wrapper: reading the banner, and, where ffmpeg is installed,
// extracting audio and grabbing frames from a generated sample video.

type Ffmpeg = typeof import("../src/services/teardown/ffmpeg");
type Env = typeof import("../src/env");
let ff: Ffmpeg;
let envModule: Env;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-teardown-ffmpeg-"));

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  process.env.LOG_LEVEL ??= "error";
  ff = await import("../src/services/teardown/ffmpeg");
  envModule = await import("../src/env");
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("parseMediaInfo", () => {
  it("reads duration and streams from the banner", () => {
    const banner = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_0412.MOV':
  Duration: 00:14:32.48, start: 0.000000, bitrate: 17042 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 16912 kb/s, 29.98 fps (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 125 kb/s (default)
At least one output file must be specified`;
    assert.deepEqual(ff.parseMediaInfo(banner), { durationSec: 872.48, hasAudio: true, hasVideo: true });
  });

  it("tells a silent video and an audio file apart", () => {
    assert.deepEqual(
      ff.parseMediaInfo("  Duration: 00:00:05.00, start: 0\n  Stream #0:0(und): Video: h264 (High), yuv420p, 320x240"),
      { durationSec: 5, hasAudio: false, hasVideo: true },
    );
    assert.deepEqual(
      ff.parseMediaInfo(
        "  Duration: 01:02:03.50\n  Stream #0:0: Audio: mp3, 44100 Hz, stereo\n  Stream #0:1: Video: mjpeg (Baseline), yuvj420p, 600x600 (attached pic)",
      ),
      { durationSec: 3723.5, hasAudio: true, hasVideo: false },
    );
    assert.deepEqual(ff.parseMediaInfo("garbage"), { durationSec: null, hasAudio: false, hasVideo: false });
  });
});

describe("ffmpeg detection", () => {
  it("reports ffmpeg missing when the path does not exist", async () => {
    const saved = envModule.env.FFMPEG_PATH;
    envModule.env.FFMPEG_PATH = path.join(dir, "no-such-ffmpeg");
    ff.resetFfmpegDetection();
    try {
      assert.equal(await ff.ffmpegAvailable(), false);
      await assert.rejects(ff.probe(path.join(dir, "x.mp4")));
    } finally {
      envModule.env.FFMPEG_PATH = saved;
      ff.resetFfmpegDetection();
    }
  });
});

describe("with ffmpeg", { skip: haveFfmpeg() ? false : "ffmpeg is not installed" }, () => {
  const video = path.join(dir, "sample.mp4");
  const silent = path.join(dir, "silent.mp4");

  before(() => {
    makeSampleVideo(video, { seconds: 12 });
    makeSampleVideo(silent, { seconds: 3, audio: false });
  });

  it("finds ffmpeg", async () => {
    assert.equal(await ff.ffmpegAvailable(), true);
    assert.match((await ff.ffmpegVersion())!, /ffmpeg/i);
  });

  it("probes duration and streams", async () => {
    const info = await ff.probe(video);
    assert.ok(Math.abs(info.durationSec! - 12) < 0.5, String(info.durationSec));
    assert.equal(info.hasAudio, true);
    assert.equal(info.hasVideo, true);
    assert.equal((await ff.probe(silent)).hasAudio, false);
  });

  it("refuses a file that is not media", async () => {
    const junk = path.join(dir, "junk.mp4");
    fs.writeFileSync(junk, "this is not a video");
    await assert.rejects(ff.probe(junk), ff.FfmpegError);
  });

  it("extracts the sound track as small mono AAC, whole or in pieces", async () => {
    const whole = path.join(dir, "whole.m4a");
    await ff.extractAudio(video, whole);
    const info = await ff.probe(whole);
    assert.equal(info.hasAudio, true);
    assert.equal(info.hasVideo, false);
    assert.ok(Math.abs(info.durationSec! - 12) < 0.5);
    // 32 kbit/s: twelve seconds is tens of kilobytes, not megabytes.
    assert.ok(fs.statSync(whole).size < 100 * 1024, String(fs.statSync(whole).size));

    const piece = path.join(dir, "piece.m4a");
    await ff.extractAudio(video, piece, { startSec: 8, durationSec: 10 });
    assert.ok(Math.abs((await ff.probe(piece)).durationSec! - 4) < 0.5);

    await assert.rejects(ff.extractAudio(silent, path.join(dir, "none.m4a")), ff.FfmpegError);
  });

  it("grabs a frame as a JPEG, and says so when there is none", async () => {
    const frame = path.join(dir, "frame.jpg");
    assert.equal(await ff.grabFrame(video, frame, 6), true);
    const bytes = fs.readFileSync(frame);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    assert.equal(await ff.grabFrame(video, path.join(dir, "late.jpg"), 500), false);
  });
});
