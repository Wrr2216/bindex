import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useFeatures, useTerms } from "../../config/useConfig";
import type { Company, Location } from "../../types";
import { valuationApi } from "./api";
import {
  BTN,
  BTN_PRIMARY,
  CARD,
  EstimateNote,
  FIELD,
  H2,
  LABEL,
  Pill,
  SERVICE_LABEL,
  SOURCE_LABEL,
  describeService,
  errorText,
  formatDay,
  serviceTone,
  todayIso,
  useMoneyExact,
} from "./format";
import type { DeclarationScope, DeclarationSummary, Overview, ReceiptSummary } from "./types";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "declarations", label: "Declarations" },
  { key: "receipts", label: "Receipts" },
  { key: "report", label: "Report" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={CARD}>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-100">{value}</p>
      {sub && <p className="text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function OverviewTab() {
  const money = useMoneyExact();
  const terms = useTerms();
  const { user } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

  useEffect(() => {
    valuationApi.overview().then(setData).catch((err) => setError(errorText(err, "Could not load the overview.")));
  }, []);

  if (!data) return <p className="text-sm text-slate-500">{error ?? "Loading…"}</p>;
  const t = data.totals;
  const dueCount = data.due.warranty.length + data.due.service.length;

  const runDigest = async () => {
    try {
      const r = await valuationApi.runDigest();
      setDigest(r.skipped ? "Another check is running." : r.announced ? `Announced ${r.announced}${r.notified ? " and sent a notification" : ""}.` : "Nothing new to announce.");
    } catch (err) {
      setDigest(errorText(err));
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total value" value={money(t.valueCents)} sub={`${t.valued} of ${t.records} valued`} />
        <Stat label="High value" value={String(t.highValue)} sub={`${money(t.highValueCents)} · from ${money(data.thresholdCents)}`} />
        <Stat label="AI estimates" value={String(t.aiEstimated)} sub="current values from photos" />
        <Stat label="Due" value={String(dueCount)} sub={`${data.due.warranty.length} warranty · ${data.due.service.length} service`} />
      </div>
      {(data.drafts.receipts > 0 || data.drafts.declarations > 0) && (
        <p className="text-sm text-slate-400">
          Waiting to be finished:{" "}
          {data.drafts.receipts > 0 && (
            <Link to="/valuation?tab=receipts" className="text-sky-400 hover:underline">
              {data.drafts.receipts} receipt{data.drafts.receipts === 1 ? "" : "s"}
            </Link>
          )}
          {data.drafts.receipts > 0 && data.drafts.declarations > 0 && " and "}
          {data.drafts.declarations > 0 && (
            <Link to="/valuation?tab=declarations" className="text-sky-400 hover:underline">
              {data.drafts.declarations} declaration{data.drafts.declarations === 1 ? "" : "s"}
            </Link>
          )}
          .
        </p>
      )}

      <section className={`${CARD} space-y-2`}>
        <div className="flex items-center justify-between">
          <h2 className={H2}>Warranty and service due</h2>
          {user?.role === "admin" && (
            <button type="button" className={BTN} onClick={runDigest} title="Announce anything newly due now, rather than at the next hourly check">
              Send reminders now
            </button>
          )}
        </div>
        {digest && <p className="text-sm text-slate-400">{digest}</p>}
        {dueCount === 0 ? (
          <p className="text-sm text-slate-500">Nothing is due.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.due.service.map((s) => (
              <li key={s.planId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-800/50 px-3 py-2 text-sm">
                <Link to={`/items/${s.itemId}${s.unitId ? `?unit=${s.unitId}` : ""}`} className="text-sky-400 hover:underline">
                  {s.name}
                </Link>
                <span className="text-slate-300">
                  {s.planName} · {describeService(s.status)}
                </span>
                <Pill tone={serviceTone(s.status.state)}>{SERVICE_LABEL[s.status.state]}</Pill>
              </li>
            ))}
            {data.due.warranty.map((w) => (
              <li key={`${w.itemId}-${w.unitId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-800/50 px-3 py-2 text-sm">
                <Link to={`/items/${w.itemId}${w.unitId ? `?unit=${w.unitId}` : ""}`} className="text-sky-400 hover:underline">
                  {w.name}
                </Link>
                <span className="text-slate-300">
                  Warranty ends {formatDay(w.warrantyEnds)}
                  {w.provider ? ` (${w.provider})` : ""}
                </span>
                <Pill tone="warn">{w.daysLeft === 0 ? "Today" : `${w.daysLeft} days`}</Pill>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`${CARD} space-y-2`}>
        <h2 className={H2}>High-value {terms.item.plural.toLowerCase()}</h2>
        {data.highValue.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing is at or over {money(data.thresholdCents)} yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {data.highValue.map((r) => (
              <li key={`${r.itemId}-${r.unitId}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                <Link to={`/items/${r.itemId}${r.unitId ? `?unit=${r.unitId}` : ""}`} className="text-sky-400 hover:underline">
                  {r.name}
                  {r.unitLabel ? ` (${r.unitLabel})` : ""}
                </Link>
                <span className="text-slate-400">{r.locationName ?? ""}</span>
                <span className="font-medium text-slate-100">
                  {money(r.valueCents)}
                  {r.lastSource === "ai" && <span className="ml-1 text-xs text-amber-300">AI</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.recent.length > 0 && (
        <section className={`${CARD} space-y-2`}>
          <h2 className={H2}>Recently valued</h2>
          <ul className="space-y-1 text-sm">
            {data.recent.map((v) => (
              <li key={v.id} className="flex flex-wrap justify-between gap-2">
                <Link to={`/items/${v.itemId}`} className="text-sky-400 hover:underline">
                  {v.itemName}
                </Link>
                <span className="text-slate-400">
                  {money(v.valueCents)} · {SOURCE_LABEL[v.source]} · {formatDay(v.valuedOn)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <EstimateNote />
    </div>
  );
}

function DeclarationsTab({ locations, companies }: { locations: Location[]; companies: Company[] }) {
  const money = useMoneyExact();
  const terms = useTerms();
  const features = useFeatures();
  const navigate = useNavigate();
  const [list, setList] = useState<DeclarationSummary[] | null>(null);
  const [scope, setScope] = useState<DeclarationScope>("location");
  const [scopeId, setScopeId] = useState("");
  const [jobRef, setJobRef] = useState("");
  const [title, setTitle] = useState("");
  const [populate, setPopulate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    valuationApi.declarations().then(setList).catch((err) => setError(errorText(err)));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await valuationApi.createDeclaration({
        scope,
        scopeId: scope === "job" ? null : scopeId || null,
        scopeLabel: scope === "job" ? jobRef : null,
        title: title.trim() || null,
        populate,
      });
      navigate(`/valuation/declarations/${d.id}`);
    } catch (err) {
      setError(errorText(err, "Could not start the declaration."));
    } finally {
      setBusy(false);
    }
  };

  const options = scope === "company" ? companies : locations;
  return (
    <div className="space-y-5">
      <form onSubmit={create} className={`${CARD} space-y-3`}>
        <h2 className={H2}>New high-value declaration</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label>
            <span className={LABEL}>Covers a</span>
            <select className={`${FIELD} mt-1`} value={scope} onChange={(e) => { setScope(e.target.value as DeclarationScope); setScopeId(""); }}>
              <option value="location">{terms.location.singular}</option>
              {features.groups && <option value="company">{terms.group.singular}</option>}
              <option value="job">Job (by reference)</option>
            </select>
          </label>
          <label className="sm:col-span-2">
            <span className={LABEL}>{scope === "job" ? "Job reference" : "Which"}</span>
            {scope === "job" ? (
              <input className={`${FIELD} mt-1`} value={jobRef} onChange={(e) => setJobRef(e.target.value)} placeholder="e.g. JOB-1042, Smith relocation" required maxLength={200} />
            ) : (
              <select className={`${FIELD} mt-1`} value={scopeId} onChange={(e) => setScopeId(e.target.value)} required>
                <option value="">Choose…</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="sm:col-span-2">
            <span className={LABEL}>Title (optional)</span>
            <input className={`${FIELD} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </label>
          {scope !== "job" && (
            <label className="flex items-center gap-2 pt-6 text-sm text-slate-300">
              <input type="checkbox" checked={populate} onChange={(e) => setPopulate(e.target.checked)} />
              Add its high-value {terms.item.plural.toLowerCase()}
            </label>
          )}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {busy ? "Starting…" : "Start declaration"}
        </button>
      </form>

      {list === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-slate-500">No declarations yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((d) => (
            <li key={d.id}>
              <Link to={`/valuation/declarations/${d.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-900 px-3 py-2 hover:bg-slate-800">
                <span className="text-sm text-slate-100">
                  <span className="font-mono text-slate-400">{d.code}</span> {d.title}
                </span>
                <span className="flex items-center gap-2 text-sm text-slate-400">
                  {d.lineCount} · {money(d.totalCents, d.currency)}
                  <Pill tone={d.status === "signed" ? "ok" : "muted"}>
                    {d.status === "signed" && d.signedAt ? `Signed ${new Date(d.signedAt).toLocaleDateString()}` : "Draft"}
                  </Pill>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReceiptsTab() {
  const money = useMoneyExact();
  const navigate = useNavigate();
  const [list, setList] = useState<ReceiptSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    valuationApi.receipts().then(setList).catch((err) => setError(errorText(err)));
  }, []);

  const start = async () => {
    try {
      const r = await valuationApi.createReceipt();
      navigate(`/valuation/receipts/${r.id}`);
    } catch (err) {
      setError(errorText(err, "Could not start a receipt."));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-400">Photograph a receipt or upload its PDF, check the lines, and match each to what it bought.</p>
        <button type="button" onClick={start} className={BTN_PRIMARY}>
          New receipt
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {list === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-slate-500">No receipts yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((r) => (
            <li key={r.id}>
              <Link to={`/valuation/receipts/${r.id}`} className="flex items-center gap-3 rounded-lg bg-slate-900 px-3 py-2 hover:bg-slate-800">
                {r.thumbUrl ? <img src={`${r.thumbUrl}?w=96`} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="h-10 w-10 rounded bg-slate-800" />}
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate text-slate-100">{r.vendor ?? "Unread receipt"}</span>
                  <span className="text-xs text-slate-400">
                    {r.purchaseDate ? formatDay(r.purchaseDate) : "No date"} · {r.lineCount} line{r.lineCount === 1 ? "" : "s"} · {r.matchedCount} matched
                  </span>
                </span>
                <span className="text-sm text-slate-300">{money(r.totalCents, r.currency)}</span>
                <Pill tone={r.status === "confirmed" ? "ok" : "muted"}>{r.status === "confirmed" ? "Confirmed" : "Draft"}</Pill>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportTab({ locations, companies }: { locations: Location[]; companies: Company[] }) {
  const terms = useTerms();
  const features = useFeatures();
  const [locationId, setLocationId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [groupBy, setGroupBy] = useState<"location" | "company">("location");
  const [highValueOnly, setHighValueOnly] = useState(false);
  const [asOf, setAsOf] = useState(todayIso());
  const opts = { locationId: locationId || undefined, companyId: companyId || undefined, groupBy, highValueOnly, asOf };
  return (
    <div className={`${CARD} space-y-4`}>
      <p className="text-sm text-slate-400">
        Every {terms.item.singular.toLowerCase()} in a place with its photo, serials, purchase, value and straight-line book value, for insurers and
        asset registers.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className={LABEL}>{terms.location.singular}</span>
          <select className={`${FIELD} mt-1`} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.parentName ? `${l.parentName} › ` : ""}
                {l.name}
              </option>
            ))}
          </select>
        </label>
        {features.groups && (
          <label>
            <span className={LABEL}>{terms.group.singular}</span>
            <select className={`${FIELD} mt-1`} value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">All</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span className={LABEL}>Group by</span>
          <select className={`${FIELD} mt-1`} value={groupBy} onChange={(e) => setGroupBy(e.target.value as "location" | "company")}>
            <option value="location">{terms.location.singular}</option>
            {features.groups && <option value="company">{terms.group.singular}</option>}
          </select>
        </label>
        <label>
          <span className={LABEL}>Values as of</span>
          <input type="date" className={`${FIELD} mt-1`} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={highValueOnly} onChange={(e) => setHighValueOnly(e.target.checked)} />
          High-value only
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <a className={BTN_PRIMARY} href={valuationApi.reportUrl({ format: "pdf", ...opts })} target="_blank" rel="noreferrer">
          Download PDF
        </a>
        <a className={BTN} href={valuationApi.reportUrl({ format: "xlsx", ...opts })}>
          Download spreadsheet
        </a>
      </div>
      <EstimateNote />
    </div>
  );
}

/**
 * The Valuation screen: what everything is worth and what is due, high-value
 * declarations, receipts, and the valuation report.
 */
export function ValuationPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "overview") as Tab;
  const [locations, setLocations] = useState<Location[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const features = useFeatures();

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
    if (features.groups) api.listCompanies().then(setCompanies).catch(() => undefined);
  }, [features.groups]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Valuation</h1>
        <p className="text-sm text-slate-400">Values and their history, high-value declarations, receipts, warranty and service.</p>
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams(t.key === "overview" ? {} : { tab: t.key })}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === t.key ? "bg-slate-800 text-sky-300" : "text-slate-300 hover:bg-slate-800/60"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <OverviewTab />}
      {tab === "declarations" && <DeclarationsTab locations={locations} companies={companies} />}
      {tab === "receipts" && <ReceiptsTab />}
      {tab === "report" && <ReportTab locations={locations} companies={companies} />}
    </div>
  );
}
