import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { claimsApi, type ListFilters } from "./api";
import type { ClaimSummary } from "./types";
import { BTN, BTN_QUIET, CARD, FIELD, Notice, SELECT, SlaChip, StatusBadge, errorText, fmtDateTime, useCents, useClaimsMeta } from "./ui";

const VIEWS = [
  { key: "open", label: "Open", status: "draft,submitted,under_review" },
  { key: "decided", label: "Decided", status: "approved,denied,paid" },
  { key: "closed", label: "Closed", status: "closed" },
  { key: "all", label: "All", status: undefined },
] as const;

/** Every claim and incident report, newest first, with the ones needing attention easy to find. */
export function ClaimsPage() {
  const meta = useClaimsMeta();
  const [params, setParams] = useSearchParams();
  const [claims, setClaims] = useState<ClaimSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(params.get("q") ?? "");

  const view = VIEWS.find((v) => v.key === params.get("view")) ?? VIEWS[0];
  const kind = (params.get("kind") as ListFilters["kind"]) ?? undefined;
  const mine = params.get("mine") === "1";
  const overdue = params.get("overdue") === "1";

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const t = setTimeout(() => {
      claimsApi
        .list({ status: view.status, kind, assignee: mine ? "me" : undefined, overdue, q: q.trim() || undefined })
        .then((r) => {
          setClaims(r.claims);
          setTotal(r.total);
          setError(null);
        })
        .catch((err) => setError(errorText(err, "Claims could not be loaded.")));
    }, 200);
    return () => clearTimeout(t);
  }, [view.status, kind, mine, overdue, q]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-100">Claims and incidents</h1>
        <div className="flex flex-wrap gap-2">
          <Link to="/claims/new?kind=incident" className={BTN_QUIET}>
            Report incident
          </Link>
          <Link to="/claims/new" className={BTN}>
            New claim
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-slate-700" role="group" aria-label="Which claims">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => set("view", v.key === "open" ? null : v.key)}
              aria-pressed={v.key === view.key}
              className={`px-3 py-2 text-sm ${v.key === view.key ? "bg-slate-700 text-slate-100" : "text-slate-300 hover:bg-slate-800"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <select value={kind ?? ""} onChange={(e) => set("kind", e.target.value || null)} aria-label="Claims or incidents" className={SELECT}>
          <option value="">Claims and incidents</option>
          <option value="claim">Claims only</option>
          <option value="incident">Incidents only</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={mine} onChange={(e) => set("mine", e.target.checked ? "1" : null)} />
          Assigned to me
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={overdue} onChange={(e) => set("overdue", e.target.checked ? "1" : null)} />
          Overdue
        </label>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search code, title, reference"
          aria-label="Search claims"
          className={`${FIELD} sm:w-64`}
        />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {claims && claims.length === 0 && (
        <p className="text-sm text-slate-500">
          {params.toString()
            ? "Nothing matches. Try another view or clear the search."
            : "No claims yet. When something is lost or damaged, open a claim: it gathers the photos, condition notes and trip history already on file."}
        </p>
      )}
      <ul className="space-y-2">
        {claims?.map((c) => (
          <ClaimRow key={c.id} claim={c} typeLabel={meta?.types.find((t) => t.type === c.type)?.label ?? c.type} />
        ))}
      </ul>
      {claims && total > claims.length && (
        <p className="text-xs text-slate-500">
          Showing the newest {claims.length} of {total}. Narrow the search to see older ones.
        </p>
      )}
    </div>
  );
}

function ClaimRow({ claim: c, typeLabel }: { claim: ClaimSummary; typeLabel: string }) {
  const money = useCents(c.currency);
  return (
    <li>
      <Link to={`/claims/${c.id}`} className={`${CARD} block space-y-1.5 hover:border-slate-700`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-slate-400">{c.code}</span>
          <span className="font-medium text-slate-100">{c.title}</span>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{typeLabel}</span>
          <StatusBadge status={c.status} />
          <SlaChip sla={c.sla} />
        </div>
        <div className="flex flex-wrap gap-x-3 text-xs text-slate-400">
          {c.type !== "incident" && (
            <span>
              {c.estimatedTotalCents === null ? "Not priced yet" : `${money(c.estimatedTotalCents)} claimed`}
              {c.approvedTotalCents !== null ? ` · ${money(c.approvedTotalCents)} approved` : ""}
            </span>
          )}
          <span>
            {c.lineCount} line{c.lineCount === 1 ? "" : "s"}
          </span>
          {c.jobCode && <span>{c.jobCode}</span>}
          {c.shipmentCode && <span>{c.shipmentCode}</span>}
          <span>{c.assigneeName ? `Reviewer: ${c.assigneeName}` : "No reviewer"}</span>
          <span>
            {c.reporterName ? `${c.reporterName}${c.reporterGrantId ? " (portal)" : ""}, ` : ""}
            {fmtDateTime(c.createdAt)}
          </span>
        </div>
      </Link>
    </li>
  );
}
