import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FIELD } from "../../components/ui";
import { suppliesApi } from "./api";
import { CARD, H2, Notice, PageHeader, SMALL_BUTTON, dateInputValue, errText, fmtQty, localDay, useCost } from "./shared";
import type { UsageReport } from "./types";

/** Usage and its cost over a date range, by holder and by supply, with a workbook export. */
export function ReportsPage() {
  const cost = useCost();
  const today = new Date();
  const [from, setFrom] = useState(dateInputValue(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)));
  const [to, setTo] = useState(dateInputValue(today));
  const [report, setReport] = useState<UsageReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The range is whole local days: from the start of `from` to the end of `to`.
  const range = useCallback(
    () => ({ from: localDay(from).toISOString(), to: localDay(to, 1).toISOString() }),
    [from, to],
  );

  useEffect(() => {
    if (!from || !to) return;
    setErr(null);
    const r = range();
    suppliesApi
      .usage(r.from, r.to)
      .then(setReport)
      .catch((e) => {
        setReport(null);
        setErr(errText(e));
      });
  }, [from, to, range]);

  const holders = new Map<string, UsageReport["byHolder"]>();
  for (const r of report?.byHolder ?? []) {
    const k = r.holderId ?? r.holderName;
    holders.set(k, [...(holders.get(k) ?? []), r]);
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Supply usage" back="/supplies">
        {report && (
          <a href={suppliesApi.usageXlsxUrl(range().from, range().to)} className={SMALL_BUTTON}>
            Download XLSX
          </a>
        )}
      </PageHeader>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-400">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-sm text-slate-400">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        {report && (
          <p className="pb-2 text-sm text-slate-300">
            Cost of supplies used: <span className="font-semibold text-slate-100">{cost(report.totalCostCents)}</span>
          </p>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Used is what was issued and not returned, plus anything used straight off a shelf. Cost uses the price at the
        time of each movement.
      </p>
      {err && <Notice tone="error">{err}</Notice>}

      {report && (
        <>
          <section className={CARD}>
            <h2 className={H2}>By crew, truck or branch</h2>
            {holders.size === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Nothing issued in this period.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[32rem] text-sm">
                  <thead className="text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-1 font-medium">Supply</th>
                      <th className="py-1 text-right font-medium">Issued</th>
                      <th className="py-1 text-right font-medium">Returned</th>
                      <th className="py-1 text-right font-medium">Used</th>
                      <th className="py-1 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  {[...holders.values()].map((rows) => {
                    const first = rows[0]!;
                    const total = rows.reduce((n, r) => n + r.costCents, 0);
                    return (
                      <tbody key={first.holderId ?? first.holderName} className="border-t border-slate-800">
                        <tr>
                          <td colSpan={4} className="pt-2 font-medium text-slate-100">
                            {first.holderId ? (
                              <Link to={`/supplies/holders/${first.holderId}`} className="hover:underline">
                                {first.holderName}
                              </Link>
                            ) : (
                              first.holderName
                            )}
                          </td>
                          <td className="pt-2 text-right font-medium text-slate-100">{cost(total)}</td>
                        </tr>
                        {rows.map((r) => (
                          <tr key={r.itemId} className="text-slate-300">
                            <td className="py-0.5 pl-3">{r.itemName}</td>
                            <td className="text-right">{fmtQty(r.issued)}</td>
                            <td className="text-right">{fmtQty(r.returned)}</td>
                            <td className="text-right">
                              {fmtQty(r.used)} {r.unit}
                            </td>
                            <td className="text-right">{cost(r.costCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    );
                  })}
                </table>
              </div>
            )}
          </section>

          <section className={CARD}>
            <h2 className={H2}>By supply</h2>
            {report.byItem.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No movements in this period.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead className="text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-1 font-medium">Supply</th>
                      <th className="py-1 text-right font-medium">Received</th>
                      <th className="py-1 text-right font-medium">Used</th>
                      <th className="py-1 text-right font-medium">Shrinkage</th>
                      <th className="py-1 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byItem.map((r) => (
                      <tr key={r.itemId} className="border-t border-slate-800 text-slate-300">
                        <td className="py-1">
                          <Link to={`/supplies/items/${r.itemId}`} className="text-slate-100 hover:underline">
                            {r.itemName}
                          </Link>
                        </td>
                        <td className="text-right">{fmtQty(r.received)}</td>
                        <td className="text-right">
                          {fmtQty(r.used)} {r.unit}
                        </td>
                        <td className={`text-right ${r.shrinkage > 0 ? "text-amber-300" : ""}`}>{fmtQty(r.shrinkage)}</td>
                        <td className="text-right">{cost(r.costCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
