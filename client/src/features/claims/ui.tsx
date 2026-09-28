import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { useConfig } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";
import { claimsApi } from "./api";
import type { ClaimStatus, ClaimsMeta, Sla } from "./types";

/** Small pieces shared by the claims screens. */

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
export const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";

let metaPromise: Promise<ClaimsMeta> | null = null;

/** Types, statuses and transitions. Fetched once per page load. */
export function useClaimsMeta(): ClaimsMeta | null {
  const [meta, setMeta] = useState<ClaimsMeta | null>(null);
  useEffect(() => {
    metaPromise ??= claimsApi.meta().catch((err) => {
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

/** Every location with its full path, for the "where" picker. */
export function useLocationOptions() {
  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);
  return useMemo(() => {
    const label = makeLocationLabel(locations);
    return locations
      .map((l) => ({ id: l.id, label: label(l) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [locations]);
}

/** Cents as money in the claim's currency, with the cents shown: claims are settled to the cent. */
export function useCents(currency?: string): (cents: number | null | undefined) => string {
  const { config } = useConfig();
  const code = currency ?? config.currency;
  return useMemo(() => {
    let fmt: Intl.NumberFormat;
    try {
      fmt = new Intl.NumberFormat(config.locale, { style: "currency", currency: code });
    } catch {
      fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
    }
    return (cents) => (cents === null || cents === undefined ? "—" : fmt.format(cents / 100));
  }, [config.locale, code]);
}

/**
 * Typed money to cents. Accepts "1234.5", "1,234.50", "1.234,50" and "12,5";
 * the last separator followed by one or two digits is the decimal point.
 * Empty is null; anything else unreadable is NaN.
 */
export function parseMoney(text: string): number | null {
  if (!text.trim()) return null;
  const s = text.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(s)) return Number.NaN;
  const m = /^(-?[\d.,]*?)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return Number.NaN;
  const whole = (m[1] ?? "").replace(/[.,]/g, "");
  const frac = (m[2] ?? "").padEnd(2, "0");
  const cents = Number(whole || "0") * 100 + Number(frac || "0");
  return Number.isFinite(cents) && cents >= 0 ? Math.round(cents) : Number.NaN;
}

export const centsToInput = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));

/** A money field that keeps its own text while typing and reports cents on blur. */
export function MoneyInput({
  value,
  onCommit,
  label,
  disabled,
  placeholder = "0.00",
  className = "",
}: {
  value: number | null;
  onCommit: (cents: number | null) => void;
  label: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(centsToInput(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(centsToInput(value)), [value]);
  const commit = () => {
    const cents = parseMoney(text);
    if (cents !== null && Number.isNaN(cents)) {
      setBad(true);
      return;
    }
    setBad(false);
    if (cents !== value) onCommit(cents);
  };
  return (
    <input
      inputMode="decimal"
      value={text}
      disabled={disabled}
      aria-label={label}
      aria-invalid={bad}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`${FIELD} text-right tabular-nums ${bad ? "border-red-600" : ""} ${className}`}
    />
  );
}

const STATUS_TONE: Record<ClaimStatus, string> = {
  draft: "bg-slate-800 text-slate-300",
  submitted: "bg-sky-950 text-sky-300",
  under_review: "bg-amber-950 text-amber-300",
  approved: "bg-emerald-950 text-emerald-300",
  denied: "bg-red-950 text-red-300",
  paid: "bg-emerald-900 text-emerald-200",
  closed: "bg-slate-800 text-slate-400",
};

export const statusText = (s: string) => s.replace(/_/g, " ");

export function StatusBadge({ status }: { status: ClaimStatus }) {
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[status]}`}>{statusText(status)}</span>;
}

function duration(ms: number): string {
  const abs = Math.abs(ms);
  const h = Math.round(abs / 3600_000);
  if (h < 1) return `${Math.max(1, Math.round(abs / 60_000))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** The decision deadline: how long is left, or how late it is. */
export function SlaChip({ sla }: { sla: Sla }) {
  if (sla.state === "none") return null;
  const tone = {
    running: "bg-slate-800 text-slate-300",
    due_soon: "bg-amber-950 text-amber-300",
    overdue: "bg-red-950 text-red-300",
    met: "bg-emerald-950/60 text-emerald-300",
    missed: "bg-red-950/60 text-red-300",
  }[sla.state];
  const text =
    sla.state === "met"
      ? "Decided in time"
      : sla.state === "missed"
        ? "Decided late"
        : sla.state === "overdue"
          ? `Overdue by ${duration(sla.remainingMs ?? 0)}`
          : `Due in ${duration(sla.remainingMs ?? 0)}`;
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${tone}`} title={sla.dueAt ? `Decision due ${fmtDateTime(sla.dueAt)}` : undefined}>
      {text}
    </span>
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

export const fromLocalInput = (value: string): string | null => (value ? new Date(value).toISOString() : null);

/** Open a document in a new tab; the session cookie authenticates it. */
export const openDocument = (url: string) => window.open(url, "_blank", "noopener");
