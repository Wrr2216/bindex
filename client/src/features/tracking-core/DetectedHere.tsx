import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { trackingApi } from "./api";
import { ago, TECH_LABELS } from "./format";
import type { Position } from "./types";

const WINDOWS: { label: string; minutes?: number }[] = [
  { label: "Any time" },
  { label: "Last hour", minutes: 60 },
  { label: "Last day", minutes: 24 * 60 },
  { label: "Last week", minutes: 7 * 24 * 60 },
];

/**
 * What readers last placed in this location or anything inside it, which can
 * differ from what is on file here. Only rendered while tracking is on.
 */
export function DetectedHere({ locationId }: { locationId: string }) {
  const terms = useTerms();
  const [present, setPresent] = useState<Position[] | null>(null);
  const [within, setWithin] = useState<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    trackingApi
      .present(locationId, within)
      .then((rows) => active && setPresent(rows))
      .catch(() => active && setPresent([]));
    return () => {
      active = false;
    };
  }, [locationId, within]);

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Detected here now{present ? ` (${present.length})` : ""}
        </h2>
        <select
          value={within ?? ""}
          onChange={(e) => setWithin(e.target.value ? Number(e.target.value) : undefined)}
          aria-label="Detected within"
          className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100"
        >
          {WINDOWS.map((w) => (
            <option key={w.label} value={w.minutes ?? ""}>
              {w.label}
            </option>
          ))}
        </select>
      </div>
      {present === null ? null : present.length === 0 ? (
        <p className="text-sm text-slate-500">
          No reader has placed any {terms.item.plural.toLowerCase()} here{within ? " in that time" : ""}.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {present.map((p) => (
            <li
              key={`${p.itemId}/${p.unitId ?? ""}`}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-slate-800/60 px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <Link to={`/items/${p.itemId}`} className="text-sky-400 hover:underline">
                  {p.itemName}
                </Link>
                {(p.unitLabel || p.unitAssetCode) && (
                  <span className="ml-1 font-mono text-xs text-slate-500">{p.unitLabel || p.unitAssetCode}</span>
                )}
                {p.locationId !== locationId && p.locationName && (
                  <span className="ml-1 text-xs text-slate-500">in {p.locationName}</span>
                )}
                {p.recordedLocationId !== p.locationId && (
                  <span className="ml-2 text-xs text-amber-400">
                    on file in {p.recordedLocationName ?? `no ${terms.location.singular.toLowerCase()}`}
                  </span>
                )}
              </span>
              <span className="text-xs text-slate-500" title={new Date(p.observedAt).toLocaleString()}>
                {TECH_LABELS[p.tech]}
                {p.deviceName ? ` · ${p.deviceName}` : ""} · {ago(p.observedAt).toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
