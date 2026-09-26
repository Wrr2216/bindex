import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Company, Location } from "../../types";
import type { ReconcileClass } from "./types";

export const CLASS_LABEL: Record<ReconcileClass, string> = {
  matched: "Matched",
  misplaced: "Misplaced",
  conflict: "Field conflicts",
  register_only: "Only in the register",
  bindex_only: "Not in the register",
  duplicate: "Duplicates",
  flagged_missing: "Flagged missing",
};

export const CLASS_HELP: Record<ReconcileClass, string> = {
  matched: "Matched on a key, with nothing to fix.",
  misplaced: "The register puts it somewhere else.",
  conflict: "Serial, tag, EPC, model or cost disagree.",
  register_only: "In the register, not found here. Fuzzy name matches are shown as proposals only.",
  bindex_only: "On file here, but no register row accounts for it.",
  duplicate: "Two rows, or two records here, claim the same key.",
  flagged_missing: "Flagged missing here.",
};

const TONE: Record<ReconcileClass, string> = {
  matched: "bg-emerald-950 text-emerald-300 border-emerald-900",
  misplaced: "bg-amber-950 text-amber-300 border-amber-900",
  conflict: "bg-orange-950 text-orange-300 border-orange-900",
  register_only: "bg-sky-950 text-sky-300 border-sky-900",
  bindex_only: "bg-violet-950 text-violet-300 border-violet-900",
  duplicate: "bg-rose-950 text-rose-300 border-rose-900",
  flagged_missing: "bg-red-950 text-red-300 border-red-900",
};

export function ClassBadge({ cls }: { cls: ReconcileClass }) {
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${TONE[cls]}`}>{CLASS_LABEL[cls]}</span>;
}

export const PRESET_LABEL: Record<string, string> = {
  generic: "Generic",
  snipeit: "Snipe-IT",
  homebox: "Homebox",
  erp: "ERP fixed-asset register",
};

/** Locations with full paths, sorted, for pickers. */
export function useLocationOptions() {
  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => setLocations([]));
  }, []);
  return useMemo(() => {
    const label = makeLocationLabel(locations);
    return locations.map((l) => ({ id: l.id, label: label(l) })).sort((a, b) => a.label.localeCompare(b.label));
  }, [locations]);
}

export function useCompanies(enabled: boolean) {
  const [companies, setCompanies] = useState<Company[]>([]);
  useEffect(() => {
    if (enabled) api.listCompanies().then(setCompanies).catch(() => setCompanies([]));
  }, [enabled]);
  return companies;
}

export const SELECT =
  "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:opacity-60";

export function Notice({ tone, children }: { tone: "ok" | "error" | "info"; children: ReactNode }) {
  const cls =
    tone === "ok"
      ? "border-emerald-900 bg-emerald-950/40 text-emerald-300"
      : tone === "error"
        ? "border-red-900 bg-red-950/40 text-red-300"
        : "border-slate-700 bg-slate-800/60 text-slate-300";
  return <div className={`rounded-lg border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function formatDate(iso: string, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}
