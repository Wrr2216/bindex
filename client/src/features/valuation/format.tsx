import type { ReactNode } from "react";
import { useConfig } from "../../config/useConfig";
import type { ServiceStatus, ValuationSource, WarrantyState } from "./types";

/** Small helpers and shared bits of UI for the valuation screens. */

export const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";
export const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";
export const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
export const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
export const CARD = "rounded-xl border border-slate-800 bg-slate-900 p-4";
export const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";

export const SOURCE_LABEL: Record<ValuationSource, string> = {
  ai: "AI estimate",
  web: "Web price",
  receipt: "Receipt",
  manual: "Entered",
  appraisal: "Appraisal",
};

export const errorText = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof Error && err.message ? err.message : fallback;

/** Money to the cent in the instance currency, for receipts and declarations. */
export function useMoneyExact(): (cents: number | null | undefined, currency?: string | null) => string {
  const { currency, locale } = useConfig().config;
  return (cents, cur) => {
    if (cents == null) return "";
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: cur || currency }).format(cents / 100);
    } catch {
      return (cents / 100).toFixed(2);
    }
  };
}

/** "1,299.99", "1299,99" or "$1,299" typed by a person, as cents; null when blank or unreadable. */
export function parseMoneyInput(text: string): number | null {
  let s = text.replace(/[^\d.,-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    s = s.split(decimal === "." ? "," : ".").join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    const parts = s.split(",");
    s = parts.length === 2 && parts[1]!.length <= 2 ? `${parts[0]}.${parts[1]}` : parts.join("");
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export const centsToInput = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));

export const todayIso = () => new Date().toISOString().slice(0, 10);

/** A YYYY-MM-DD date as the viewer writes dates, without letting a time zone move it a day. */
export function formatDay(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(locale);
}

export function Pill({ tone, children, title }: { tone: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode; title?: string }) {
  const cls = {
    ok: "bg-emerald-950 text-emerald-300",
    warn: "bg-amber-950 text-amber-300",
    bad: "bg-red-950 text-red-300",
    info: "bg-sky-950 text-sky-300",
    muted: "bg-slate-800 text-slate-400",
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}

export function HighValueBadge() {
  return (
    <Pill tone="warn" title="At or over the high-value threshold, or marked high value by hand">
      High value
    </Pill>
  );
}

export function warrantyTone(state: WarrantyState): "ok" | "warn" | "bad" | "muted" {
  return state === "active" ? "ok" : state === "expiring" ? "warn" : state === "expired" ? "bad" : "muted";
}

export function describeWarranty(state: WarrantyState, daysLeft: number | null): string {
  if (state === "none" || daysLeft === null) return "No warranty on file";
  if (state === "expired") return `Expired ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago`;
  if (daysLeft === 0) return "Ends today";
  return `Ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
}

export function describeService(st: ServiceStatus): string {
  const parts: string[] = [];
  if (st.daysLeft !== null) {
    parts.push(st.daysLeft < 0 ? `${-st.daysLeft}d overdue` : st.daysLeft === 0 ? "due today" : `due in ${st.daysLeft}d`);
  }
  if (st.dueHours !== null) {
    parts.push(
      st.hoursLeft === null
        ? `due at ${st.dueHours} h`
        : st.hoursLeft <= 0
          ? `${-st.hoursLeft} h overdue`
          : `${st.hoursLeft} h to go (at ${st.dueHours} h)`,
    );
  }
  return parts.join(" · ") || "No interval";
}

export function serviceTone(state: ServiceStatus["state"]): "ok" | "warn" | "bad" | "muted" {
  return state === "ok" ? "ok" : state === "soon" ? "warn" : state === "overdue" ? "bad" : "muted";
}

export const SERVICE_LABEL: Record<ServiceStatus["state"], string> = {
  ok: "On schedule",
  soon: "Due soon",
  overdue: "Overdue",
  inactive: "Paused",
};

/** The standing reminder that an AI value is an estimate. */
export function EstimateNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-slate-500 ${className}`}>
      AI values are estimates made from photos, not appraisals. Check them before relying on them for insurance or a claim.
    </p>
  );
}
