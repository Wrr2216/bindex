import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { suppliesApi } from "./api";
import { CARD, H2, Notice, PageHeader, SMALL_BUTTON, errText, fmtQty } from "./shared";
import type { LowStockRow } from "./types";

/** Everything at or below its reorder point, grouped by where it is short. */
export function LowStockPage() {
  const terms = useTerms();
  const [rows, setRows] = useState<LowStockRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    suppliesApi.lowStock().then(setRows).catch((e) => setErr(errText(e)));
  }, []);

  const groups = new Map<string, LowStockRow[]>();
  for (const r of rows ?? []) {
    const k = r.locationName ?? "";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Low stock" back="/supplies" />
      <p className="text-sm text-slate-400">
        A supply is low where it is at or below its reorder point. A daily digest of this list goes to the configured
        notification destinations.
      </p>
      {err && <Notice tone="error">{err}</Notice>}
      {rows && rows.length === 0 && <Notice tone="ok">Nothing is low.</Notice>}
      {[...groups.entries()].map(([name, list]) => (
        <section key={name} className={CARD}>
          <h2 className={H2}>{name || `Not in any ${terms.location.singular.toLowerCase()}`}</h2>
          <ul className="mt-2 divide-y divide-slate-800 text-sm">
            {list.map((r) => (
              <li key={r.itemId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <Link to={`/supplies/items/${r.itemId}`} className="text-slate-100 hover:underline">
                    {r.itemName}
                  </Link>
                  <p className="text-xs text-slate-500">
                    Reorder at {fmtQty(r.reorderPoint)}
                    {r.reorderQty !== null && `, order ${fmtQty(r.reorderQty)}`}
                    {r.supplier && ` from ${r.supplier}`}
                  </p>
                </div>
                <span className="flex items-center gap-2">
                  <span className="text-amber-300">
                    {fmtQty(r.qty)} {r.unit}
                  </span>
                  <Link
                    to={`/supplies/move/receive?item=${r.itemId}${r.locationId ? `&location=${r.locationId}` : ""}`}
                    className={SMALL_BUTTON}
                  >
                    Receive
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
