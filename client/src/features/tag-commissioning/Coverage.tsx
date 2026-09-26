import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useFeatures, useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";
import { FIELD } from "../../components/ui";
import { tagsApi } from "./api";
import { TIER_HELP, TIER_LABELS } from "./badges";
import type { TagTier, TierCounts, TierReport } from "./types";

const BAR: Record<TagTier, string> = {
  none: "bg-slate-700",
  barcode: "bg-slate-400",
  legacy: "bg-amber-500",
  rfid: "bg-sky-500",
  rfid_nfc: "bg-emerald-500",
};

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

function Bar({ counts, tiers }: { counts: TierCounts; tiers: TagTier[] }) {
  return (
    <div className="flex h-2 w-full min-w-24 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
      {tiers.map((t) =>
        counts[t] ? (
          <div key={t} className={BAR[t]} style={{ width: `${(counts[t] / counts.total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}

/**
 * Items by tag tier for each location: how much of a site can be read in bulk
 * by RFID, and how much still depends on stickers or scanning one at a time.
 */
export function Coverage() {
  const terms = useTerms();
  const features = useFeatures();
  const [locations, setLocations] = useState<Location[]>([]);
  const [scope, setScope] = useState("");
  const [report, setReport] = useState<TierReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);
  useEffect(() => {
    setReport(null);
    tagsApi
      .tierReport(scope || undefined)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the report"));
  }, [scope]);

  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  const sorted = useMemo(
    () => [...locations].sort((a, b) => label(a).localeCompare(label(b))),
    [locations, label],
  );

  // Legacy stays in the table while any item still has a sticker, even with
  // the feature off, so the numbers add up.
  const tiers: TagTier[] = ["none", "barcode", "legacy", "rfid", "rfid_nfc"].filter(
    (t) => t !== "legacy" || features.legacyTags || (report?.totals.legacy ?? 0) > 0,
  ) as TagTier[];

  const rowName = (id: string | null, fallback: string | null) => {
    if (!id) return `No ${terms.location.singular.toLowerCase()}`;
    const loc = byId.get(id);
    return loc ? label(loc) : (fallback ?? "Unknown");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-slate-400">
          How each {terms.item.singular.toLowerCase()} can be identified, per{" "}
          {terms.location.singular.toLowerCase()}. RFID coverage is the share that a reader picks up
          in bulk.
        </p>
        <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope" className={`${FIELD} sm:w-72`}>
          <option value="">Everywhere</option>
          {sorted.map((l) => (
            <option key={l.id} value={l.id}>
              {label(l)}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {!report ? (
        !error && <p className="text-slate-500">Loading…</p>
      ) : report.totals.total === 0 ? (
        <p className="text-slate-500">No {terms.item.plural.toLowerCase()} here yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2">{terms.location.singular}</th>
                <th className="px-3 py-2 text-right">Total</th>
                {tiers.map((t) => (
                  <th key={t} className="px-3 py-2 text-right" title={TIER_HELP[t]}>
                    {TIER_LABELS[t]}
                  </th>
                ))}
                <th className="px-3 py-2 text-right">RFID coverage</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {report.rows.map((r) => (
                <tr key={r.locationId ?? "none"} className="text-slate-300">
                  <td className="px-3 py-2">
                    {r.locationId ? (
                      <Link to={`/locations/${r.locationId}`} className="text-sky-400 hover:underline">
                        {rowName(r.locationId, r.locationName)}
                      </Link>
                    ) : (
                      rowName(null, null)
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{r.total}</td>
                  {tiers.map((t) => (
                    <td key={t} className="px-3 py-2 text-right tabular-nums">
                      {r[t] || <span className="text-slate-600">0</span>}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right tabular-nums">{pct(r.rfid + r.rfid_nfc, r.total)}%</td>
                  <td className="px-3 py-2">
                    <Bar counts={r} tiers={tiers} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-900 font-medium text-slate-200">
              <tr>
                <td className="px-3 py-2">All</td>
                <td className="px-3 py-2 text-right">{report.totals.total}</td>
                {tiers.map((t) => (
                  <td key={t} className="px-3 py-2 text-right tabular-nums">
                    {report.totals[t]}
                  </td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">
                  {pct(report.totals.rfid + report.totals.rfid_nfc, report.totals.total)}%
                </td>
                <td className="px-3 py-2">
                  <Bar counts={report.totals} tiers={tiers} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
