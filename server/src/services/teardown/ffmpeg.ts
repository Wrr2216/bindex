import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";

/**
 * The few ffmpeg operations teardown guides need, run as a child process.
 * ffmpeg is optional: ffmpegAvailable() looks for it once, and every caller
 * has a path for when it is missing.
 *
 * Only ffmpeg itself is used, not ffprobe: `ffmpeg -i` prints the duration and
 * the streams on its way to complaining that no output was named, which is all
 * that is needed and one binary fewer to install.
 */

type RunResult = { code: number | null; stdout: string; stderr: string };

const STDERR_KEEP = 16 * 1024;

function run(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(env.FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < STDERR_KEEP) stdout += d.toString("utf8");
    });
    // The interesting part of ffmpeg's stderr is the start (stream info) and
    // the end (the error), so keep both ends of a long one.
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (stderr.length > STDERR_KEEP * 2) stderr = stderr.slice(0, STDERR_KEEP) + stderr.slice(-STDERR_KEEP);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let detected: Promise<string | null> | null = null;

/** The ffmpeg version line, or null when there is no working ffmpeg. Checked once. */
export function ffmpegVersion(): Promise<string | null> {
  detected ??= run(["-hide_banner", "-version"], 10_000)
    .then((r) => {
      if (r.code !== 0) return null;
      const line = r.stdout.split("\n")[0]?.trim() ?? "";
      logger.info("teardown.ffmpeg.found", { version: line.slice(0, 120) });
      return line || "ffmpeg";
    })
    .catch((err) => {
      logger.info("teardown.ffmpeg.missing", { path: env.FFMPEG_PATH, err: describeError(err) });
      return null;
    });
  return detected;
}

export async function ffmpegAvailable(): Promise<boolean> {
  return (await ffmpegVersion()) !== null;
}

/** Forget the cached answer; for tests that point FFMPEG_PATH somewhere else. */
export function resetFfmpegDetection(): void {
  detected = null;
}

export type MediaInfo = { durationSec: number | null; hasAudio: boolean; hasVideo: boolean };

/** Duration and streams from the banner `ffmpeg -i` prints. Pure, for tests. */
export function parseMediaInfo(stderr: string): MediaInfo {
  const d = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  return {
    durationSec: durationSec !== null && Number.isFinite(durationSec) ? durationSec : null,
    hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(stderr),
    hasVideo: /Stream #\d+:\d+.*?: Video:/.test(stderr) && !/Video: (mjpeg|png).*\(attached pic\)/.test(stderr),
  };
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public detail: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

const lastLines = (s: string, n = 4) => s.trim().split("\n").slice(-n).join(" | ").slice(0, 600);

export async function probe(file: string): Promise<MediaInfo> {
  const r = await run(["-hide_banner", "-nostdin", "-i", file], 60_000);
  const info = parseMediaInfo(r.stderr);
  if (!info.hasAudio && !info.hasVideo) {
    throw new FfmpegError("ffmpeg could not read this file as audio or video.", lastLines(r.stderr));
  }
  return info;
}

async function nonEmpty(file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).size > 0;
  } catch {
    return false;
  }
}

/**
 * A stretch of the sound track as small mono AAC, which every transcription
 * provider accepts: 16 kHz is what speech models work at, and 32 kbit/s keeps
 * ten minutes near 2.5 MB, well under upload caps.
 */
export async function extractAudio(
  src: string,
  out: string,
  opts: { startSec?: number; durationSec?: number } = {},
): Promise<void> {
  const args = ["-hide_banner", "-nostdin", "-y"];
  if (opts.startSec) args.push("-ss", opts.startSec.toFixed(3));
  if (opts.durationSec) args.push("-t", opts.durationSec.toFixed(3));
  args.push("-i", src, "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", out);
  const r = await run(args, 15 * 60_000);
  if (r.code !== 0 || !(await nonEmpty(out))) {
    throw new FfmpegError("ffmpeg could not extract the sound track.", lastLines(r.stderr));
  }
}

/**
 * One frame as a JPEG no wider than `maxWidth`, or false when there is no
 * frame at that time (past the end, or an audio-only file).
 */
export async function grabFrame(src: string, out: string, atSec: number, maxWidth = 1280): Promise<boolean> {
  const r = await run(
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-ss",
      Math.max(0, atSec).toFixed(3),
      "-i",
      src,
      "-frames:v",
      "1",
      "-an",
      "-vf",
      `scale='min(${maxWidth},iw)':-2`,
      "-q:v",
      "4",
      out,
    ],
    2 * 60_000,
  );
  if (r.code !== 0) {
    logger.debug("teardown.ffmpeg.frame_failed", { atSec, detail: lastLines(r.stderr) });
    return false;
  }
  return nonEmpty(out);
}
