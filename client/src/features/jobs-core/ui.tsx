import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { makeLocationLabel } from "../../lib/locationLabel";
import { useScan } from "../../scan/ScanProvider";
import type { Location } from "../../types";
import { jobsApi } from "./api";
import type { JobsMeta, Progress, StageInfo } from "./types";

/** Small pieces shared by the jobs screens. */

let metaPromise: Promise<JobsMeta> | null = null;

/** Stage names, task kinds and lifecycles. Fetched once per page load. */
export function useJobsMeta(): JobsMeta | null {
  const [meta, setMeta] = useState<JobsMeta | null>(null);
  useEffect(() => {
    metaPromise ??= jobsApi.meta().catch((err) => {
      metaPromise = null;
      throw err;
    });
    let live = true;
    metaPromise.then((m) => live && setMeta(m)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return meta;
}

/** Every location with a full-path label, for pickers. */
export function useLocations() {
  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);
  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const options = useMemo(
    () =>
      locations
        .map((l) => ({ id: l.id, label: label(l) }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [locations, label],
  );
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o.label])), [options]);
  return { locations, options, labelOf: (id: string | null | undefined) => (id ? byId.get(id) ?? null : null) };
}

export const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
export const SELECT =
  "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none";
export const BTN = "rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
export const BTN_QUIET =
  "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
export const BTN_DANGER =
  "rounded-lg border border-red-900 px-3 py-2 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-50";
export const CARD = "rounded-xl border border-slate-800 bg-slate-900 p-4";
export const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";

export function LocationSelect({
  value,
  onChange,
  options,
  placeholder = "None",
  label,
  className = SELECT,
}: {
  value: string;
  onChange: (id: string) => void;
  options: { id: string; label: string }[];
  placeholder?: string;
  label: string;
  className?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={className}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const STATUS_TONE: Record<string, string> = {
  planned: "bg-slate-800 text-slate-300",
  active: "bg-sky-950 text-sky-300",
  in_progress: "bg-sky-950 text-sky-300",
  on_hold: "bg-amber-950 text-amber-300",
  staged: "bg-indigo-950 text-indigo-300",
  loaded: "bg-indigo-950 text-indigo-300",
  in_transit: "bg-violet-950 text-violet-300",
  delivered: "bg-emerald-950 text-emerald-300",
  completed: "bg-emerald-950 text-emerald-300",
  closed: "bg-slate-800 text-slate-400",
  cancelled: "bg-red-950 text-red-300",
  todo: "bg-slate-800 text-slate-300",
  doing: "bg-sky-950 text-sky-300",
  done: "bg-emerald-950 text-emerald-300",
  skipped: "bg-slate-800 text-slate-500",
};

export const statusText = (s: string) => s.replace(/_/g, " ");

/** "5" reads as "Floor 5"; "Level 5" is left as it is. Same rule as the printed manifest. */
export const floorLabel = (f: string) => (/^(floor|level|lvl|fl)\b/i.test(f) ? f : `Floor ${f}`);

/**
 * The page-level owner of scan capture: whichever panel is active arms its own
 * handler, and this disarms when none is, and on leaving the page.
 */
export function useCaptureOwner<T extends string>() {
  const { armBulkCapture } = useScan();
  const [owner, setOwner] = useState<T | null>(null);
  useEffect(() => {
    if (owner === null) armBulkCapture(null);
  }, [owner, armBulkCapture]);
  useEffect(() => () => armBulkCapture(null), [armBulkCapture]);
  const claim = useCallback((who: T, on: boolean) => setOwner((cur) => (on ? who : cur === who ? null : cur)), []);
  return { owner, claim };
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[status] ?? STATUS_TONE.planned}`}>
      {statusText(status)}
    </span>
  );
}

export function stageInfo(meta: JobsMeta | null, stage: string): StageInfo {
  return (
    meta?.stages.find((s) => s.name === stage) ?? {
      name: stage,
      label: statusText(stage),
      kind: "exception",
      color: "#64748b",
    }
  );
}

export function StageBadge({ stage, meta }: { stage: string; meta: JobsMeta | null }) {
  const info = stageInfo(meta, stage);
  return (
    <span
      className="whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${info.color}26`, color: info.color }}
    >
      {info.label}
    </span>
  );
}

export function TypeChip({ name, color }: { name: string | null; color: string | null }) {
  if (!name) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color ?? "#64748b" }} />
      {name}
    </span>
  );
}

const STEPS: { key: keyof Progress["percent"]; label: string; color: string }[] = [
  { key: "packed", label: "Packed", color: "#0ea5e9" },
  { key: "loaded", label: "Loaded", color: "#6366f1" },
  { key: "delivered", label: "Delivered", color: "#a855f7" },
  { key: "placed", label: "Placed", color: "#10b981" },
];

/** One bar, one number: how far the lines have got overall. */
export function ProgressBar({ progress, className = "" }: { progress: Progress | null; className?: string }) {
  const pct = progress?.overall ?? 0;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full ${progress?.complete ? "bg-emerald-500" : "bg-sky-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 text-right text-xs tabular-nums text-slate-400">{pct}%</span>
    </div>
  );
}

/** A bar per step, with counts, for the job and shipment pages. */
export function StepBars({ progress }: { progress: Progress }) {
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      {STEPS.map((s) => (
        <div key={s.key}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-slate-300">{s.label}</span>
            <span className="tabular-nums text-slate-400">
              {progress.reached[s.key]}/{progress.total}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full" style={{ width: `${progress.percent[s.key]}%`, backgroundColor: s.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error" | "warn"; children: ReactNode }) {
  const cls = {
    info: "bg-slate-800/60 text-slate-300",
    ok: "bg-emerald-950/50 text-emerald-300",
    error: "bg-red-950/50 text-red-300",
    warn: "bg-amber-950/50 text-amber-300",
  }[tone];
  return <p className={`rounded-lg px-3 py-2 text-sm ${cls}`}>{children}</p>;
}

export const errorText = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof Error && err.message ? err.message : fallback;

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** An ISO timestamp as a datetime-local input value, in the viewer's zone. */
export function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value back to ISO, or null when empty. */
export const fromLocalInput = (value: string): string | null => (value ? new Date(value).toISOString() : null);

/** Open a document in a new tab; the session cookie authenticates it. */
export const openDocument = (url: string) => window.open(url, "_blank", "noopener");
