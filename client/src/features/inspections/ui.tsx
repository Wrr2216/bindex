import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";
import { inspectionsApi } from "./api";
import type { ChangeKind, InspectionKind, InspectionStatus, InspectionsMeta, Severity } from "./types";

/** Small pieces shared by the inspection screens. */

export const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
export const SELECT =
  "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none";
export const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";
export const BTN = "rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
export const BTN_QUIET =
  "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
export const BTN_DANGER =
  "rounded-lg border border-red-900 px-3 py-2 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-50";
export const CARD = "rounded-xl border border-slate-800 bg-slate-900 p-4";
export const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";

export const KIND_LABEL: Record<InspectionKind, string> = {
  pre: "Pre-move",
  post: "Post-move",
  adhoc: "Site",
};

const STATUS_TONE: Record<InspectionStatus, string> = {
  draft: "bg-slate-800 text-slate-300",
  completed: "bg-sky-950 text-sky-300",
  signed: "bg-emerald-950 text-emerald-300",
};

export const SEVERITY_COLOR: Record<Severity, string> = { minor: "#ca8a04", moderate: "#ea580c", major: "#dc2626" };

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  new: "New damage",
  worsened: "Worse than before",
  resolved: "Recorded before, not found after",
  unchanged: "Unchanged",
};

export function StatusBadge({ status }: { status: InspectionStatus }) {
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[status]}`}>{status}</span>;
}

export function KindBadge({ kind }: { kind: InspectionKind }) {
  const tone = kind === "pre" ? "bg-indigo-950 text-indigo-300" : kind === "post" ? "bg-violet-950 text-violet-300" : "bg-slate-800 text-slate-300";
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${tone}`}>{KIND_LABEL[kind]}</span>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const color = SEVERITY_COLOR[severity];
  return (
    <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: `${color}26`, color }}>
      {severity}
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

/** Spots, severities and the rest. Fetched once per page load. */
export function useInspectionsMeta(): InspectionsMeta | null {
  const [meta, setMeta] = useState<InspectionsMeta | null>(null);
  useEffect(() => {
    let live = true;
    inspectionsApi
      .meta()
      .then((m) => live && setMeta(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return meta;
}

export const spotLabel = (meta: InspectionsMeta | null, spot: string) =>
  meta?.spots.find((s) => s.value === spot)?.label ?? spot.replace(/_/g, " ");

/** Every location with a full-path label, for the site picker. */
export function useLocationOptions() {
  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);
  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  return useMemo(
    () =>
      locations
        .map((l) => ({ id: l.id, label: label(l) }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [locations, label],
  );
}
