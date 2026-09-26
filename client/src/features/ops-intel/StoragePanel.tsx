import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { opsApi } from "./api";
import type { AbcClass, StorageItem, StorageReport } from "./types";
import { BTN_QUIET, CARD, FIELD, H2, NUM, Notice, SELECT, StatTile, TABLE, TD, TH, compact, errorText, fmtDate, fmtDateTime, metres } from "./ui";

/**
 * Dwell time and storage analytics: how long things have sat where they are,
 * which places turn over and which never do, and what is likely to be asked
 * for next.
 */
export function StoragePanel() {
  const terms = useTerms();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (fresh = false) => {
    setBusy(true);
    return opsApi
      .storage(fresh)
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((err) => setError(errorText(err, "Storage analytics could not be loaded.")))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    void load();
  }, []);

  if (error && !report) return <Notice tone="error">{error}</Notice>;
  if (!report) return <p className="text-sm text-slate-500">Loading…</p>;
  const t = report.totals;
  const share = (n: number) => (t.assets ? `${Math.round((n / t.assets) * 100)}% of ${terms.item.plural.toLowerCase()}` : "");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          Movements over the last {report.windowDays} days; long stored means {report.longStoredDays} days or more in one place.
          Worked out {fmtDateTime(report.generatedAt)}.
        </p>
        <button onClick={() => void load(true)} disabled={busy} className={BTN_QUIET}>
          {busy ? "Working…" : "Recalculate"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label={terms.item.plural} value={compact(t.assets)} hint={`${compact(t.movements)} movements`} />
        <StatTile label="Long stored" value={compact(t.longStored)} hint={share(t.longStored)} />
        <StatTile label="Class A" value={compact(t.A)} hint="most of the movement" />
        <StatTile label="Class B" value={compact(t.B)} hint={share(t.B)} />
        <StatTile label="Class C" value={compact(t.C)} hint="slow or never moved" />
      </div>

      <section className={`${CARD} space-y-2`}>
        <h2 className={H2}>By {terms.location.singular.toLowerCase()}</h2>
        {report.zones.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing is stored anywhere yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH}>{terms.location.singular}</th>
                  <th className={`${TH} text-right`}>To dock</th>
                  <th className={`${TH} text-right`}>Held</th>
                  <th className={`${TH} text-right`}>Avg days</th>
                  <th className={`${TH} text-right`}>Longest</th>
                  <th className={`${TH} text-right`}>Long stored</th>
                  <th className={`${TH} text-right`}>In / out</th>
                  <th className={`${TH} text-right`}>Turnover</th>
                  <th className={`${TH} text-right`}>A / B / C</th>
                </tr>
              </thead>
              <tbody>
                {report.zones.slice(0, 200).map((z) => (
                  <tr key={z.locationId} className="border-t border-slate-800">
                    <td className={TD}>
                      <Link to={`/locations/${z.locationId}`} className="text-sky-400 hover:underline">
                        {z.path}
                      </Link>
                    </td>
                    <td className={NUM}>{z.distanceToDockM === null ? "" : metres(z.distanceToDockM)}</td>
                    <td className={NUM}>{z.occupancy}</td>
                    <td className={NUM}>{z.avgDwellDays}</td>
                    <td className={NUM}>{z.maxDwellDays}</td>
                    <td className={NUM}>{z.longStored || ""}</td>
                    <td className={NUM}>
                      {z.movesIn} / {z.movesOut}
                    </td>
                    <td className={NUM}>{z.turnover}</td>
                    <td className={NUM}>
                      {z.abc.A} / {z.abc.B} / {z.abc.C}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-slate-500">
          In and out count moves reported by readers; turnover is moves out over the window for each thing held now.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ItemList title="Stored longest" items={report.longStored.slice(0, 15)} metric={(i) => `${Math.round(i.dwellDays)} days`} />
        <ItemList title="Moved most" items={report.topMovers.slice(0, 15)} metric={(i) => `${i.movements} ${i.movements === 1 ? "move" : "moves"}, ${i.movesPerMonth}/month`} />
      </div>

      <ItemBrowser />
    </div>
  );
}

function ItemList({ title, items, metric }: { title: string; items: StorageItem[]; metric: (i: StorageItem) => string }) {
  return (
    <section className={`${CARD} min-w-0 space-y-2`}>
      <h2 className={H2}>{title}</h2>
      {items.length === 0 && <p className="text-sm text-slate-500">None.</p>}
      <ul className="space-y-1.5 text-sm">
        {items.map((i) => (
          <li key={i.itemId} className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate">
              <Link to={`/items/${i.itemId}`} className="text-sky-400 hover:underline">
                {i.name}
              </Link>
              <span className="ml-2 text-xs text-slate-500">{i.locationPath}</span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-slate-400">{metric(i)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ItemBrowser() {
  const terms = useTerms();
  const [abc, setAbc] = useState<AbcClass | "">("");
  const [longStored, setLongStored] = useState(false);
  const [sort, setSort] = useState<"dwell" | "movements" | "next">("next");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<StorageItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      opsApi
        .storageItems({ abc: abc || undefined, longStored: longStored || undefined, sort, q: q.trim() || undefined, limit: 50 })
        .then((r) => {
          setRows(r.items);
          setTotal(r.total);
          setError(null);
        })
        .catch((err) => setError(errorText(err, "The list could not be loaded.")));
    }, 200);
    return () => clearTimeout(t);
  }, [abc, longStored, sort, q]);

  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className={H2}>Retrieval outlook</h2>
      <div className="flex flex-wrap items-center gap-2">
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort" className={SELECT}>
          <option value="next">Likely needed soonest</option>
          <option value="dwell">Stored longest</option>
          <option value="movements">Moved most</option>
        </select>
        <select value={abc} onChange={(e) => setAbc(e.target.value as AbcClass | "")} aria-label="Class" className={SELECT}>
          <option value="">Every class</option>
          <option value="A">Class A</option>
          <option value="B">Class B</option>
          <option value="C">Class C</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={longStored} onChange={(e) => setLongStored(e.target.checked)} />
          Long stored only
        </label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or code" aria-label="Search" className={`${FIELD} sm:w-48`} />
        <span className="ml-auto text-xs text-slate-500">{rows ? `${total} ${terms.item.plural.toLowerCase()}` : ""}</span>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{terms.item.singular}</th>
              <th className={TH}>{terms.location.singular}</th>
              <th className={`${TH} text-right`}>Days there</th>
              <th className={`${TH} text-right`}>Moves</th>
              <th className={TH}>Class</th>
              <th className={TH}>Likely next</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((i) => (
              <tr key={i.itemId} className="border-t border-slate-800">
                <td className={TD}>
                  <Link to={`/items/${i.itemId}`} className="text-sky-400 hover:underline">
                    {i.name}
                  </Link>
                  {i.code && <span className="ml-1 font-mono text-xs text-slate-500">{i.code}</span>}
                </td>
                <td className={TD}>
                  {i.locationPath}
                  {i.source === "tracking" && <span className="ml-1 text-xs text-slate-500">(read)</span>}
                </td>
                <td className={NUM}>{Math.round(i.dwellDays)}</td>
                <td className={NUM}>{i.movements}</td>
                <td className={TD}>{i.abc}</td>
                <td className={TD}>
                  {i.predictedNextAt ? (
                    <span title={`Every ${i.medianIntervalDays} days or so`}>{fmtDate(i.predictedNextAt)}</span>
                  ) : (
                    <span className="text-slate-500">not enough history</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Likely next is the last move plus the median gap between moves in the window; it needs two moves to go by.
      </p>
    </section>
  );
}
