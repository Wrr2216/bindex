import type { GuideJob, JobStatus, PartKind } from "./types";

/** "m:ss" under an hour, "h:mm:ss" beyond; empty for no time. */
export function clock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return "";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** "1:23", "83", "1:02:03" or "83.5" as seconds; null for blank; NaN for nonsense. */
export function parseClock(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m || Number(m[3]) >= 60) return Number.NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export const KIND_LABEL: Record<PartKind, string> = {
  hardware: "Hardware",
  component: "Component",
  cable: "Cable",
  other: "Other",
};

export const KIND_TONE: Record<PartKind, string> = {
  hardware: "bg-amber-950 text-amber-300",
  component: "bg-sky-950 text-sky-300",
  cable: "bg-violet-950 text-violet-300",
  other: "bg-slate-800 text-slate-300",
};

const STAGE_LABEL: Record<string, string> = {
  audio: "Taking the sound track out of the video",
  transcribe: "Transcribing the narration",
  steps: "Writing steps from the narration",
  keyframes: "Taking a picture for each step",
  refine: "Naming parts from the pictures",
};

export function jobLine(job: GuideJob): string {
  if (job.status === "queued") return "Waiting to be processed";
  if (job.status !== "running") return "";
  const label = (job.stage && STAGE_LABEL[job.stage]) || "Processing";
  return job.progress && job.progress.total > 1 ? `${label} (${job.progress.done + 1} of ${job.progress.total})` : label;
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  idle: "Not processed",
  queued: "Waiting",
  running: "Processing",
  done: "Ready",
  failed: "Failed",
};

export const isBusy = (status: JobStatus) => status === "queued" || status === "running";

export const errorMessage = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof Error && err.message ? err.message : fallback;

export const partLine = (p: { qty: number; name: string }) => (p.qty > 1 ? `${p.qty} × ${p.name}` : p.name);
