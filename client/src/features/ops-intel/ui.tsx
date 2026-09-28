import type { ReactNode } from "react";
import type { Severity } from "./types";

/** Small pieces shared by the Insights screens. */

export const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
export const SELECT =
  "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none";
export const BTN = "rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
export const BTN_QUIET =
  "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
export const CARD = "rounded-xl border border-slate-800 bg-slate-900 p-4";
export const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";
export const TABLE = "w-full text-left text-sm";
export const TH = "px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-slate-500";
export const TD = "px-2 py-1.5 align-top text-slate-300";
export const NUM = "px-2 py-1.5 text-right align-top text-slate-300 tabular-nums";

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

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString([], { dateStyle: "medium" });
}

/** "3 h ago", "2 days ago". */
export function ago(value: string | null | undefined): string {
  if (!value) return "";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export const compact = (n: number): string =>
  n.toLocaleString(undefined, { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 });

export const kg = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
export const m3 = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} m³`;
export const metres = (n: number) =>
  n < 1000 ? `${Math.round(n)} m` : `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;

// Status colours carry severity; each always travels with a shape and a word,
// so the colour never has to be told apart on its own.
const SEVERITY: Record<Severity, { color: string; label: string; shape: ReactNode }> = {
  high: {
    color: "#d03b3b",
    label: "High",
    shape: <path d="M6 1 L11 10 L1 10 Z" />,
  },
  medium: {
    color: "#ec835a",
    label: "Medium",
    shape: <path d="M6 1 L11 6 L6 11 L1 6 Z" />,
  },
  low: {
    color: "#fab219",
    label: "Low",
    shape: <circle cx="6" cy="6" r="4.5" />,
  },
};

export function SeverityIcon({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill={s.color} className="shrink-0">
      {s.shape}
    </svg>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-200">
      <SeverityIcon severity={severity} />
      {SEVERITY[severity].label}
    </span>
  );
}

export const severityLabel = (s: Severity) => SEVERITY[s].label;

/** Label, value and an optional hint: the KPI row's building block. */
export function StatTile({ label, value, hint, icon }: { label: string; value: string; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={CARD}>
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-slate-100">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/**
 * A share of a limit. The fill turns amber past 90% and red past 100%, and the
 * number beside it says the same, so the colour is never the only signal.
 */
export function Meter({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <span className="text-xs text-slate-500">no limit</span>;
  const pct = Math.round(value * 100);
  const fill = value > 1 ? "#d03b3b" : value > 0.9 ? "#fab219" : "#3987e5";
  return (
    <div className="flex items-center gap-2" title={`${label}: ${pct}%`}>
      <div
        className="h-1.5 w-24 overflow-hidden rounded-full"
        style={{ backgroundColor: "#0d366b" }}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: fill }} />
      </div>
      <span className="text-xs tabular-nums text-slate-300">
        {pct}%{value > 1 ? " over" : ""}
      </span>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-slate-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium ${
            value === t.id ? "border-sky-400 text-sky-300" : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
