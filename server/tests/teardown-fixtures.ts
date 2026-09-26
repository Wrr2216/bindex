import { execFileSync } from "node:child_process";

/**
 * Fixtures for the teardown tests: a narrated teardown as a transcription
 * provider returns it, and replies a language model and a vision model might
 * give for it, good and bad.
 */

/** verbose_json from /audio/transcriptions for a one-minute narration. */
export const TEARDOWN_TRANSCRIPTION = {
  task: "transcribe",
  language: "english",
  duration: 58,
  text:
    "Okay, this is the teardown of the lab workstation. First, unplug the power cord and the two network cables from the back. " +
    "Next, remove the four M4 screws holding the top cover and slide the cover off. Be careful, the fan cable is still attached to the cover. " +
    "Disconnect the fan cable from the motherboard header. Now lift out the two drive caddies. Label them left and right. " +
    "Then unscrew the six standoff screws and pull the motherboard. That's ten screws total.",
  segments: [
    { id: 0, start: 0, end: 5.2, text: " Okay, this is the teardown of the lab workstation." },
    { id: 1, start: 5.2, end: 12.8, text: " First, unplug the power cord and the two network cables from the back." },
    { id: 2, start: 12.8, end: 21.5, text: " Next, remove the four M4 screws holding the top cover and slide the cover off." },
    { id: 3, start: 21.5, end: 28.0, text: " Be careful, the fan cable is still attached to the cover." },
    { id: 4, start: 28.0, end: 35.4, text: " Disconnect the fan cable from the motherboard header." },
    { id: 5, start: 38.0, end: 47.5, text: " Now lift out the two drive caddies. Label them left and right." },
    { id: 6, start: 47.5, end: 58.0, text: " Then unscrew the six standoff screws and pull the motherboard. That's ten screws total." },
  ],
};

/** What a well-behaved model makes of the narration above. */
export const STEPS_REPLY = {
  steps: [
    {
      n: 1,
      title: "Disconnect external cables",
      instruction: "Unplug the power cord and both network cables from the back.",
      start: 5.2,
      end: 12.8,
      callout: null,
    },
    {
      n: 2,
      title: "Remove the top cover",
      instruction: "Remove the four M4 screws holding the top cover, then slide the cover off.",
      start: 12.8,
      end: 28.0,
      callout: "The fan cable is still attached to the cover",
    },
    {
      n: 3,
      title: "Disconnect the fan cable",
      instruction: "Unplug the fan cable from the motherboard header.",
      start: 28.0,
      end: 35.4,
      callout: null,
    },
    {
      n: 4,
      title: "Lift out the drive caddies",
      instruction: "Lift out both drive caddies.",
      start: 38.0,
      end: 47.5,
      callout: "Label the caddies left and right",
    },
    {
      n: 5,
      title: "Remove the motherboard",
      instruction: "Unscrew the six standoff screws and pull the motherboard.",
      start: 47.5,
      end: 58.0,
      callout: "10 screws total",
    },
  ],
  parts: [
    { name: "Power cord", kind: "cable", qty: 1, stepN: 1 },
    { name: "Network cable", kind: "cable", qty: 2, stepN: 1 },
    { name: "M4 screw", kind: "hardware", qty: 4, stepN: 2 },
    { name: "Top cover", kind: "component", qty: 1, stepN: 2 },
    { name: "Drive caddy", kind: "component", qty: 2, stepN: 4 },
    { name: "Standoff screw", kind: "hardware", qty: 6, stepN: 5 },
    { name: "Motherboard", kind: "component", qty: 1, stepN: 5 },
  ],
};

/**
 * The same guide as a sloppier model returns it: wrapped in another object,
 * out of order, times as strings and out of range, synonyms for kinds,
 * words for numbers, parts nested in steps, a "none" callout.
 */
export const MESSY_STEPS_REPLY = {
  guide: {
    steps: [
      { number: "2", description: "Take the four M4 screws out of the top cover and slide it off", start: "0:12.8", end: "0:28", callout: ["Fan cable still attached", ""] },
      { n: 1, title: "unplug everything", text: "Pull the power cord and the network cables.", start: "5.2s", end: 12.8, callout: "none", parts: [{ part: "power cord", type: "wiring" }, "network cable"] },
      { n: 3, title: "Pull the motherboard", start: 47.5, end: 9999, callout: "N/A" },
      { n: 4, title: "", instruction: "" },
      "Lift out the drive caddies",
    ],
    parts: [
      { name: "M4 screw", kind: "fastener", qty: "four", stepN: "Step 2" },
      { name: "top cover", kind: "furniture", quantity: 1, step: 2 },
      { name: "standoff", kind: "bananas", count: "6x", stepN: 3 },
      { name: "drive caddy", qty: 0, stepN: 42 },
      { name: "   " },
      "SATA cable",
    ],
  },
};

/** A refine reply naming the parts asked about, with one it was not asked about. */
export const REFINE_REPLY = {
  parts: [
    { id: "p1", name: "M4 x 6 mm pan head screw", kind: "hardware" },
    { id: "p2", name: "top cover", kind: "component" },
    { id: "p3", name: "Drive sled", kind: "gizmo" },
    { id: "p99", name: "Invented part", kind: "hardware" },
  ],
};

export function haveFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A short test video: ffmpeg's colour test pattern with a sine tone as its
 * sound track, standing in for a narrated phone video. `audio: false` makes
 * one with no sound track at all.
 */
export function makeSampleVideo(out: string, opts: { seconds?: number; audio?: boolean } = {}): void {
  const seconds = String(opts.seconds ?? 12);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15"];
  if (opts.audio !== false) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000");
  args.push("-t", seconds, "-pix_fmt", "yuv420p", "-c:v", "mpeg4", "-q:v", "8");
  if (opts.audio !== false) args.push("-c:a", "aac", "-b:a", "32k", "-shortest");
  args.push("-movflags", "+faststart", out);
  execFileSync("ffmpeg", args, { stdio: "ignore" });
}
