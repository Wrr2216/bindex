import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useConfig, useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import { useScan } from "../../scan/ScanProvider";
import type { Entity, Location } from "../../types";
import { FIELD } from "../../components/ui";
import { ArrowLeftIcon } from "../../components/icons";
import { suppliesApi } from "./api";
import type { LowStockRow } from "./types";

// min-w-0 lets a card in a grid shrink, so long names truncate instead of widening the page.
export const CARD = "min-w-0 rounded-xl border border-slate-800 bg-slate-900 p-4";
export const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";
export const SMALL_BUTTON =
  "rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";

/** The entity kinds that act as holders of supplies and equipment. */
export const HOLDER_KINDS = [
  { value: "crew", label: "Crew" },
  { value: "vehicle", label: "Truck" },
  { value: "branch", label: "Branch" },
] as const;

export const kindLabel = (kind: string | null): string | null =>
  HOLDER_KINDS.find((k) => k.value === kind)?.label ?? kind;

export const errText = (e: unknown, fallback = "Something went wrong."): string =>
  e instanceof Error && e.message ? e.message : fallback;

export const fmtQty = (n: number): string => String(Math.round(n * 1000) / 1000);

export const fmtWhen = (s: string | null): string =>
  s
    ? new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

/** Local midnight today, as the server expects it for "since". */
export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** yyyy-mm-dd in local time, for date inputs. */
export function dateInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local midnight of a yyyy-mm-dd string, optionally some days later. */
export function localDay(value: string, addDays = 0): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, (d ?? 1) + addDays);
}

/** Money with cents: supplies are cheap enough that rounding to whole units hides the cost. */
export function useCost(): (cents: number | null | undefined) => string {
  const { currency, locale } = useConfig().config;
  return useCallback(
    (cents) =>
      cents == null
        ? "—"
        : new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100),
    [currency, locale],
  );
}

/**
 * Route every scan on this screen to `handler`. "one" re-arms the one-shot
 * capture after each scan, so the camera closes between entries; "bulk" keeps
 * collecting until the screen goes away, for scan sessions.
 */
export function useScanTo(handler: (code: string) => void, mode: "one" | "bulk", active = true) {
  const { armCapture, armBulkCapture } = useScan();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    if (mode === "bulk") {
      armBulkCapture((code) => ref.current(code));
      return () => armBulkCapture(null);
    }
    const once = (code: string) => {
      armCapture(once);
      ref.current(code);
    };
    armCapture(once);
    return () => armCapture(null);
  }, [mode, active, armCapture, armBulkCapture]);
}

export function useLocations() {
  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);
  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const sorted = useMemo(
    () => [...locations].sort((a, b) => label(a).localeCompare(label(b))),
    [locations, label],
  );
  return { locations: sorted, label };
}

export function useHolders() {
  const [holders, setHolders] = useState<Entity[]>([]);
  const reload = useCallback(() => {
    api.listEntities().then(setHolders).catch(() => undefined);
  }, []);
  useEffect(reload, [reload]);
  return { holders, reload };
}

export function LocationSelect({
  value,
  onChange,
  label,
  placeholder,
  exclude,
}: {
  value: string;
  onChange: (id: string) => void;
  label: string;
  placeholder?: string;
  exclude?: string;
}) {
  const { locations, label: path } = useLocations();
  return (
    <label className="block">
      <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${FIELD} mt-1`} aria-label={label}>
        <option value="">{placeholder ?? "Choose…"}</option>
        {locations
          .filter((l) => l.id !== exclude)
          .map((l) => (
            <option key={l.id} value={l.id}>
              {path(l)}
            </option>
          ))}
      </select>
    </label>
  );
}

/** Crews, trucks and branches first; any other holder after, so nothing is unreachable. */
export function HolderSelect({
  value,
  onChange,
  label,
  placeholder,
  holders,
}: {
  value: string;
  onChange: (id: string) => void;
  label: string;
  placeholder?: string;
  holders: Entity[];
}) {
  const terms = useTerms();
  const primary = holders.filter((h) => HOLDER_KINDS.some((k) => k.value === h.kind));
  const other = holders.filter((h) => !HOLDER_KINDS.some((k) => k.value === h.kind));
  return (
    <label className="block">
      <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${FIELD} mt-1`} aria-label={label}>
        <option value="">{placeholder ?? "Choose…"}</option>
        {primary.length > 0 && (
          <optgroup label="Crews, trucks and branches">
            {primary.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} ({kindLabel(h.kind)})
              </option>
            ))}
          </optgroup>
        )}
        {other.length > 0 && (
          <optgroup label={`Other ${terms.holder.plural.toLowerCase()}`}>
            {other.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

export function PageHeader({ title, back, children }: { title: string; back?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {back && (
          <Link to={back} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100" aria-label="Back">
            <ArrowLeftIcon className="h-5 w-5" />
          </Link>
        )}
        <h1 className="text-xl font-semibold text-slate-100">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "ok" | "warn" | "error"; children: ReactNode }) {
  const cls =
    tone === "ok"
      ? "border-emerald-800 bg-emerald-950/60 text-emerald-300"
      : tone === "warn"
        ? "border-amber-800 bg-amber-950/50 text-amber-300"
        : "border-red-800 bg-red-950/50 text-red-300";
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${cls}`}>
      {children}
    </p>
  );
}

export function Badge({ tone, children }: { tone: "low" | "late" | "ok" | "muted"; children: ReactNode }) {
  const cls = {
    low: "bg-amber-950 text-amber-300",
    late: "bg-red-950 text-red-300",
    ok: "bg-emerald-950 text-emerald-400",
    muted: "bg-slate-800 text-slate-400",
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

/** Where everything at or below its reorder point is summarised. */
export function LowStockCard({ limit = 5 }: { limit?: number }) {
  const terms = useTerms();
  const [rows, setRows] = useState<LowStockRow[] | null>(null);
  useEffect(() => {
    suppliesApi.lowStock().then(setRows).catch(() => setRows([]));
  }, []);
  return (
    <section className={CARD}>
      <div className="flex items-center justify-between">
        <h2 className={H2}>Low stock</h2>
        {rows && rows.length > 0 && (
          <Link to="/supplies/low" className="text-sm text-sky-400 hover:underline">
            See all {rows.length}
          </Link>
        )}
      </div>
      {rows === null ? (
        <p className="mt-2 text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Nothing is at or below its reorder point.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-800">
          {rows.slice(0, limit).map((r) => (
            <li key={`${r.itemId}|${r.locationId}`} className="flex items-center justify-between gap-3 py-2 text-sm">
              <Link to={`/supplies/items/${r.itemId}`} className="truncate text-slate-200 hover:underline">
                {r.itemName}
                <span className="ml-2 text-slate-500">
                  {r.locationName ?? `No ${terms.location.singular.toLowerCase()} has any`}
                </span>
              </Link>
              <span className="shrink-0 text-amber-300">
                {fmtQty(r.qty)} / {fmtQty(r.reorderPoint)} {r.unit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
