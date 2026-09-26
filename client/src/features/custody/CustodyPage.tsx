import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useFeatures } from "../../config/useConfig";
import { custodyApi } from "./api";
import type { AwaitingShipment, CustodyStatus, TransferSummary } from "./types";
import { BTN, CARD, FIELD, H2, ReceiptChecker, StatusBadge, errorText, when } from "./ui";

const FILTERS: { value: CustodyStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "draft", label: "Scanning" },
  { value: "locked", label: "Awaiting signatures" },
  { value: "completed", label: "Signed" },
  { value: "void", label: "Void" },
];

/** Every custody transfer, and the shipments waiting for a delivery sign-off. */
export function CustodyPage() {
  const features = useFeatures();
  const [status, setStatus] = useState<CustodyStatus | "">("");
  const [q, setQ] = useState("");
  const [transfers, setTransfers] = useState<TransferSummary[] | null>(null);
  const [awaiting, setAwaiting] = useState<AwaitingShipment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      custodyApi
        .list({ status: status || undefined, q: q.trim() || undefined })
        .then(setTransfers)
        .catch((err) => setError(errorText(err, "Transfers could not be loaded.")));
    }, 200);
    return () => window.clearTimeout(t);
  }, [status, q]);

  useEffect(() => {
    if (features.jobs) custodyApi.awaiting().then(setAwaiting).catch(() => undefined);
  }, [features.jobs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Chain of custody</h1>
          <p className="text-sm text-slate-400">Signed handoffs, delivery sign-offs and their receipts.</p>
        </div>
        <Link to="/custody/new" className={BTN}>
          New handoff
        </Link>
      </div>

      {awaiting.length > 0 && (
        <section className={`${CARD} space-y-2`} aria-label="Awaiting delivery sign-off">
          <h2 className={H2}>Awaiting delivery sign-off</h2>
          <ul className="divide-y divide-slate-800">
            {awaiting.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <p className="text-sm text-slate-100">
                    <span className="font-mono text-sky-300">{s.code}</span> {s.name}
                  </p>
                  <p className="text-xs text-slate-400">
                    {s.jobCode} {s.jobName} · {s.lines} line{s.lines === 1 ? "" : "s"} · {s.status.replace(/_/g, " ")}
                    {s.eta ? ` · due ${when(s.eta)}` : ""}
                  </p>
                </div>
                <Link to={`/custody/shipments/${s.id}/sign-off`} className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-600">
                  {s.openTransferId ? "Continue sign-off" : "Review and sign"}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Status">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatus(f.value)}
                aria-pressed={status === f.value}
                className={`rounded-full px-3 py-1 text-sm ${status === f.value ? "bg-sky-900 text-sky-100" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Code, party or seal number"
            aria-label="Search transfers"
            className={`${FIELD} sm:max-w-xs`}
          />
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
        {transfers === null ? (
          <p className="text-slate-400">Loading…</p>
        ) : transfers.length === 0 ? (
          <p className="text-sm text-slate-400">No transfers{status || q ? " match" : " yet. Start one with New handoff"}.</p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900">
            {transfers.map((t) => (
              <li key={t.id}>
                <Link to={`/custody/transfers/${t.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-slate-800/50">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-100">
                      <span className="font-mono text-sky-300">{t.code}</span>{" "}
                      <span className="text-xs uppercase tracking-wide text-slate-400">{t.purposeLabel}</span>
                    </p>
                    <p className="truncate text-sm text-slate-300">
                      {t.fromName} → {t.toName}
                    </p>
                    <p className="text-xs text-slate-500">
                      {[
                        when(t.at ?? t.createdAt),
                        `${t.lineCount ?? 0} line${t.lineCount === 1 ? "" : "s"}`,
                        t.exceptionCount ? `${t.exceptionCount} exception${t.exceptionCount === 1 ? "" : "s"}` : null,
                        t.jobCode,
                        t.shipmentCode,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <StatusBadge status={t.status} purpose={t.purpose} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`${CARD} space-y-2`}>
        <h2 className={H2}>Check a receipt</h2>
        <p className="text-sm text-slate-400">
          Pick a custody receipt PDF to see which transfer it belongs to and whether it still matches what was signed.
        </p>
        <ReceiptChecker />
      </section>
    </div>
  );
}
