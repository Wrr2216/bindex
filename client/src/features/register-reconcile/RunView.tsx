import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useConfig, useFeatures, useMoney, useTerms } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET, FIELD } from "../../components/ui";
import { registerApi } from "./api";
import {
  CLASS_HELP,
  CLASS_LABEL,
  ClassBadge,
  Notice,
  SELECT,
  errorText,
  formatDate,
  useCompanies,
  useLocationOptions,
} from "./shared";
import {
  CLASS_ORDER,
  type ActionOutcome,
  type ActionRequest,
  type CopyField,
  type ReconcileClass,
  type ReconcileResult,
  type ResultPage,
  type RunComparison,
  type RunDetail,
  type RunSummary,
} from "./types";

type Status = "open" | "all" | "resolved" | "ignored";
const PAGE = 100;

const FIELD_LABEL: Record<string, string> = {
  assetTag: "Asset tag",
  serial: "Serial",
  epc: "EPC",
  model: "Model",
  cost: "Cost",
  name: "Name",
};
const METHOD_LABEL: Record<string, string> = {
  asset_tag: "asset tag",
  serial: "serial",
  epc: "EPC",
  asset_code: "printed code",
};

export function RunView() {
  const { runId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { config } = useConfig();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [page, setPage] = useState<ResultPage | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(params.get("q") ?? "");

  const status = (params.get("status") as Status | null) ?? "open";
  const offset = Number(params.get("offset") ?? 0) || 0;
  const q = params.get("q") ?? "";
  const cls: ReconcileClass = useMemo(() => {
    const fromUrl = params.get("class") as ReconcileClass | null;
    if (fromUrl && CLASS_ORDER.includes(fromUrl)) return fromUrl;
    // Start on the first class that has something left to do.
    const first = run && CLASS_ORDER.find((c) => c !== "matched" && run.status[c].open > 0);
    return first ?? "matched";
  }, [params, run]);

  const setParam = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    if (!("offset" in next)) p.delete("offset");
    setParams(p, { replace: true });
    setSelected(new Set());
  };

  const loadRun = useCallback(() => {
    registerApi.getRun(runId).then(setRun).catch((e) => setError(errorText(e)));
  }, [runId]);
  const loadPage = useCallback(() => {
    registerApi
      .results(runId, { cls, status, q: q || undefined, offset, limit: PAGE })
      .then(setPage)
      .catch((e) => setError(errorText(e)));
  }, [runId, cls, status, q, offset]);

  useEffect(loadRun, [loadRun]);
  useEffect(() => {
    if (run) loadPage();
  }, [run, loadPage]);
  // Pin the opening tab in the URL, so resolving its last result does not
  // move the screen to another class under the person's cursor.
  useEffect(() => {
    if (run && !params.get("class")) {
      const p = new URLSearchParams(params);
      p.set("class", cls);
      setParams(p, { replace: true });
    }
  }, [run, params, cls, setParams]);
  const selectedResults = useMemo(
    () => page?.results.filter((r) => selected.has(r.id)) ?? [],
    [page, selected],
  );

  // Large selections go up in batches; the server takes a bounded list.
  const act = async (body: ActionRequest) => {
    setError(null);
    try {
      const res: ActionOutcome = { action: body.action, done: 0, skipped: [], created: [] };
      for (let i = 0; i < body.resultIds.length; i += 5000) {
        const part = await registerApi.action(runId, { ...body, resultIds: body.resultIds.slice(i, i + 5000) });
        res.done += part.done;
        res.skipped.push(...part.skipped);
        res.created!.push(...(part.created ?? []));
      }
      setOutcome(res);
      setSelected(new Set());
      loadRun();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const selectAll = async () => {
    if (!page) return;
    const ids: string[] = [];
    for (let off = 0; off < page.total; off += 1000) {
      const res = await registerApi.results(runId, { cls, status, q: q || undefined, offset: off, limit: 1000 });
      ids.push(...res.results.map((r) => r.id));
    }
    setSelected(new Set(ids));
  };

  if (error && !run) return <Notice tone="error">{error}</Notice>;
  if (!run) return <p className="text-sm text-slate-500">Loading…</p>;

  const search = (e: FormEvent) => {
    e.preventDefault();
    setParam({ q: query.trim() || null });
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pageIds = page?.results.map((r) => r.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Reconciliation</h1>
          <p className="text-sm text-slate-400">
            <Link to={`/audit/register/${run.importId}`} className="text-sky-400 hover:underline">
              {run.importName}
            </Link>{" "}
            · {run.importRowCount} rows · {run.scopeLabel} · {formatDate(run.createdAt, config.locale)}
          </p>
        </div>
        <div className="flex gap-2">
          <a href={registerApi.reportXlsxUrl(run.id)} className={BUTTON_QUIET}>
            Report (XLSX)
          </a>
          <a href={registerApi.reportPdfUrl(run.id)} target="_blank" rel="noreferrer" className={BUTTON_QUIET}>
            Report (PDF)
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {CLASS_ORDER.map((c) => {
          const s = run.status[c];
          const active = c === cls;
          return (
            <button
              key={c}
              onClick={() => setParam({ class: c })}
              className={`rounded-xl border p-3 text-left transition ${
                active ? "border-sky-500 bg-slate-800" : "border-slate-800 bg-slate-900 hover:bg-slate-800/60"
              }`}
            >
              <p className="text-2xl font-semibold text-slate-100">{c === "matched" ? s.total : s.open}</p>
              <p className="text-xs text-slate-400">{CLASS_LABEL[c]}</p>
              {c !== "matched" && s.total > s.open && <p className="text-[11px] text-slate-500">of {s.total}</p>}
            </button>
          );
        })}
      </div>
      <p className="text-sm text-slate-400">{CLASS_HELP[cls]}</p>

      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setParam({ status: e.target.value === "open" ? null : e.target.value })} aria-label="Status" className={SELECT}>
          <option value="open">Open</option>
          <option value="all">All</option>
          <option value="resolved">Resolved</option>
          <option value="ignored">Ignored</option>
        </select>
        <form onSubmit={search} className="flex flex-1 gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tag, serial, name or code" className={FIELD} />
        </form>
      </div>

      {outcome && <OutcomeNotice outcome={outcome} onClose={() => setOutcome(null)} />}
      {error && <Notice tone="error">{error}</Notice>}

      {selected.size > 0 && (
        <ActionBar cls={cls} status={status} selected={[...selected]} selectedResults={selectedResults} onAct={act} />
      )}

      {page && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allOnPage}
                onChange={() => setSelected(allOnPage ? new Set() : new Set(pageIds))}
                aria-label="Select this page"
              />
              {page.total} {page.total === 1 ? "result" : "results"}
            </label>
            {page.total > pageIds.length && selected.size < page.total && (
              <button onClick={() => void selectAll()} className="text-sky-400 hover:underline">
                Select all {page.total}
              </button>
            )}
            {selected.size > 0 && <span>{selected.size} selected</span>}
          </div>
          {page.results.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing here.</p>
          ) : (
            <ul className="space-y-1.5">
              {page.results.map((r) => (
                <ResultItem key={r.id} r={r} checked={selected.has(r.id)} onToggle={() => toggle(r.id)} />
              ))}
            </ul>
          )}
          {page.total > PAGE && (
            <div className="flex items-center gap-3 text-sm">
              <button
                disabled={offset === 0}
                onClick={() => setParam({ offset: String(Math.max(0, offset - PAGE)) })}
                className={BUTTON_QUIET}
              >
                Previous
              </button>
              <span className="text-slate-400">
                {offset + 1}–{Math.min(offset + PAGE, page.total)} of {page.total}
              </span>
              <button
                disabled={offset + PAGE >= page.total}
                onClick={() => setParam({ offset: String(offset + PAGE) })}
                className={BUTTON_QUIET}
              >
                Next
              </button>
            </div>
          )}
        </section>
      )}

      <ComparePanel run={run} />
    </div>
  );
}

function ResultItem({ r, checked, onToggle }: { r: ReconcileResult; checked: boolean; onToggle: () => void }) {
  const money = useMoney();
  const value = (field: string, v: string | null) =>
    v == null ? "empty" : field === "cost" && /^-?\d+$/.test(v) ? money(Number(v)) : v;
  const row = r.row;
  return (
    <li className={`rounded-lg border px-3 py-2 text-sm ${checked ? "border-sky-700 bg-slate-800" : "border-slate-800 bg-slate-800/40"}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1" aria-label="Select result" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {row ? (
              <span className="text-slate-200">
                <span className="text-slate-500">Row {row.rowNumber}</span>{" "}
                {[row.assetTag, row.serial].filter(Boolean).map((k) => (
                  <span key={k} className="mr-1 font-mono text-xs text-slate-300">
                    {k}
                  </span>
                ))}
                {row.name ?? row.model ?? ""}
                {row.locationText && (
                  <span className="text-slate-500">
                    {" "}
                    · {row.locationText}
                    {r.registerLocation?.path && r.registerLocation.path !== row.locationText ? ` (${r.registerLocation.path})` : ""}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-slate-500">No register row</span>
            )}
            {r.asset && (
              <span className="text-slate-300">
                →{" "}
                {r.asset.exists ? (
                  <Link to={`/items/${r.asset.itemId}`} className="text-sky-300 hover:underline">
                    <span className="font-mono text-xs">{r.asset.assetCode}</span> {r.asset.name}
                    {r.asset.unitLabel ? ` (${r.asset.unitLabel})` : ""}
                  </Link>
                ) : (
                  <span className="text-slate-500">{r.asset.name ?? r.asset.assetCode} (deleted)</span>
                )}
                {r.asset.location?.path && <span className="text-slate-500"> · {r.asset.location.path}</span>}
              </span>
            )}
            <span className="ml-auto flex flex-wrap gap-1">
              {r.classes.map((c) => (
                <ClassBadge key={c} cls={c} />
              ))}
            </span>
          </div>
          {r.matchMethod && <p className="text-xs text-slate-500">Matched on {METHOD_LABEL[r.matchMethod]}.</p>}
          {r.conflicts.map((c) => (
            <p key={c.field} className="text-xs text-orange-300">
              {FIELD_LABEL[c.field] ?? c.field}: register {value(c.field, c.register)}, here {value(c.field, c.bindex)}
            </p>
          ))}
          {r.proposal && (
            <p className="text-xs text-sky-300">
              Possible match:{" "}
              <Link to={`/items/${r.proposal.itemId}`} className="hover:underline">
                <span className="font-mono">{r.proposal.assetCode}</span> {r.proposal.name}
              </Link>{" "}
              <span className="text-slate-500">(similarity {r.proposal.score.toFixed(2)}; a proposal, not a match)</span>
            </p>
          )}
          {r.notes.map((n) => (
            <p key={n} className="text-xs text-slate-400">
              {n}
            </p>
          ))}
          {r.resolution && (
            <p className={`text-xs ${r.resolution === "ignored" ? "text-slate-500" : "text-emerald-400"}`}>
              {r.resolution === "ignored" ? "Ignored" : "Resolved"}
              {r.resolutionNote ? `: ${r.resolutionNote}` : ""}
              {r.resolvedBy ? ` (${r.resolvedBy})` : ""}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function OutcomeNotice({ outcome, onClose }: { outcome: ActionOutcome; onClose: () => void }) {
  const reasons = new Map<string, number>();
  for (const s of outcome.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  return (
    <Notice tone={outcome.done ? "ok" : "info"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          {outcome.done} done{outcome.skipped.length ? `, ${outcome.skipped.length} skipped` : ""}.
          {outcome.created && outcome.created.length > 0 && (
            <span> Created {outcome.created.map((c) => c.assetCode).slice(0, 10).join(", ")}{outcome.created.length > 10 ? "…" : ""}.</span>
          )}
          {[...reasons].map(([reason, n]) => (
            <div key={reason} className="text-xs opacity-80">
              {n > 1 ? `${n} × ` : ""}
              {reason}
            </div>
          ))}
        </div>
        <button onClick={onClose} className="text-xs opacity-70 hover:opacity-100" aria-label="Dismiss">
          Dismiss
        </button>
      </div>
    </Notice>
  );
}

// --- Actions ------------------------------------------------------------------

const COPYABLE: CopyField[] = ["serial", "assetTag", "epc", "model", "cost", "name"];

function ActionBar({
  cls,
  status,
  selected,
  selectedResults,
  onAct,
}: {
  cls: ReconcileClass;
  status: Status;
  selected: string[];
  selectedResults: ReconcileResult[];
  onAct: (body: ActionRequest) => Promise<void>;
}) {
  const terms = useTerms();
  const features = useFeatures();
  const { config } = useConfig();
  const companies = useCompanies(features.groups && cls === "register_only");
  const options = useLocationOptions();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [defaultLocationId, setDefaultLocationId] = useState("");
  // Preselect the fields that actually disagree on what is selected.
  const conflictKey = [...new Set(selectedResults.flatMap((r) => r.conflicts.map((c) => c.field)))].sort().join(",");
  const [fields, setFields] = useState<Set<CopyField>>(new Set());
  useEffect(() => {
    setFields(new Set(conflictKey ? (conflictKey.split(",") as CopyField[]) : []));
  }, [conflictKey]);

  const run = async (body: ActionRequest) => {
    setBusy(true);
    try {
      await onAct(body);
    } finally {
      setBusy(false);
    }
  };
  const n = selected.length;
  const items = n === 1 ? terms.item.singular.toLowerCase() : terms.item.plural.toLowerCase();
  const canCopy = cls !== "register_only" && cls !== "bindex_only";

  return (
    <div className="sticky top-16 z-20 space-y-3 rounded-xl border border-slate-700 bg-slate-900/95 p-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-300">{n} selected:</span>
        {status !== "open" && (
          <button disabled={busy} onClick={() => void run({ action: "reopen", resultIds: selected })} className={BUTTON_QUIET}>
            Reopen
          </button>
        )}
        {cls === "misplaced" && (
          <>
            <button disabled={busy} onClick={() => void run({ action: "move_to_register", resultIds: selected })} className={BUTTON}>
              Move to the register's {terms.location.singular.toLowerCase()}
            </button>
            <button disabled={busy} onClick={() => void run({ action: "accept_bindex_location", resultIds: selected })} className={BUTTON_QUIET}>
              Keep it where it is here
            </button>
          </>
        )}
        {cls === "bindex_only" && (
          <button disabled={busy} onClick={() => void run({ action: "flag_missing", resultIds: selected })} className={BUTTON}>
            Flag missing
          </button>
        )}
        {cls === "flagged_missing" && (
          <button disabled={busy} onClick={() => void run({ action: "clear_missing", resultIds: selected })} className={BUTTON}>
            Clear missing flag
          </button>
        )}
        {cls === "register_only" && selectedResults.some((r) => r.proposal) && (
          <button disabled={busy} onClick={() => void run({ action: "link_proposal", resultIds: selected })} className={BUTTON_QUIET}>
            Link to the proposed match
          </button>
        )}
      </div>

      {cls === "register_only" && (
        <div className="flex flex-wrap items-center gap-2">
          {features.groups && (
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label="Group for new records" className={SELECT}>
              <option value="">No {terms.group.singular.toLowerCase()}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={defaultLocationId}
            onChange={(e) => setDefaultLocationId(e.target.value)}
            aria-label="Default location"
            className={`${SELECT} max-w-72`}
          >
            <option value="">Unmatched {terms.location.plural.toLowerCase()}: leave empty</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                Unmatched: {o.label}
              </option>
            ))}
          </select>
          <button
            disabled={busy}
            onClick={() =>
              void run({
                action: "create_items",
                resultIds: selected,
                companyId: companyId || null,
                defaultLocationId: defaultLocationId || null,
              })
            }
            className={BUTTON}
          >
            Create {n} {items}
          </button>
        </div>
      )}

      {canCopy && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
          <span>Copy</span>
          {COPYABLE.map((f) => (
            <label key={f} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={fields.has(f)}
                onChange={() =>
                  setFields((s) => {
                    const next = new Set(s);
                    if (next.has(f)) next.delete(f);
                    else next.add(f);
                    return next;
                  })
                }
              />
              {FIELD_LABEL[f]}
            </label>
          ))}
          <button
            disabled={busy || fields.size === 0}
            onClick={() => void run({ action: "copy_fields", resultIds: selected, direction: "to_bindex", fields: [...fields] })}
            className={BUTTON_QUIET}
          >
            Register → {config.appName}
          </button>
          <button
            disabled={busy || fields.size === 0}
            onClick={() => void run({ action: "copy_fields", resultIds: selected, direction: "to_register", fields: [...fields] })}
            className={BUTTON_QUIET}
          >
            {config.appName} → register copy
          </button>
        </div>
      )}

      {status === "open" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) void run({ action: "ignore", resultIds: selected, reason: reason.trim() }).then(() => setReason(""));
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason to ignore (required)"
            className={`${FIELD} max-w-md`}
          />
          <button disabled={busy || !reason.trim()} className={BUTTON_QUIET}>
            Ignore
          </button>
        </form>
      )}
    </div>
  );
}

// --- Compare ------------------------------------------------------------------

function ComparePanel({ run }: { run: RunDetail }) {
  const { config } = useConfig();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [other, setOther] = useState("");
  const [cmp, setCmp] = useState<RunComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    registerApi
      .listRuns()
      .then((all) => {
        const others = all.filter((r) => r.id !== run.id);
        setRuns(others);
        setOther((cur) => cur || run.previousRunId || others[0]?.id || "");
      })
      .catch(() => setRuns([]));
  }, [run.id, run.previousRunId]);

  if (!runs.length) return null;
  const compare = async () => {
    setError(null);
    try {
      setCmp(await registerApi.compare(run.id, other));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const list = (title: string, entries: RunComparison["cleared"], tone: string) =>
    entries.length > 0 && (
      <details className="text-sm">
        <summary className={`cursor-pointer ${tone}`}>
          {title} ({entries.length})
        </summary>
        <ul className="mt-1 space-y-0.5 text-slate-400">
          {entries.slice(0, 200).map((e) => (
            <li key={e.key}>
              {e.label}:{" "}
              <span className="text-slate-500">
                {e.before.map((c) => CLASS_LABEL[c]).join(", ") || "absent"} → {e.after.map((c) => CLASS_LABEL[c]).join(", ") || "absent"}
              </span>
            </li>
          ))}
          {entries.length > 200 && <li>and {entries.length - 200} more</li>}
        </ul>
      </details>
    );

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="font-semibold text-slate-100">Compare with another run</h2>
      <div className="flex flex-wrap items-center gap-2">
        <select value={other} onChange={(e) => setOther(e.target.value)} aria-label="Run to compare" className={`${SELECT} max-w-md`}>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.importName} · {formatDate(r.createdAt, config.locale)} · {r.scopeLabel}
            </option>
          ))}
        </select>
        <button onClick={() => void compare()} disabled={!other} className={BUTTON_QUIET}>
          Compare
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {cmp && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            From {formatDate(cmp.before.createdAt, config.locale)} to {formatDate(cmp.after.createdAt, config.locale)}.
          </p>
          <div className="overflow-x-auto">
            <table className="text-left text-sm">
              <tbody>
                {CLASS_ORDER.map((c) => (
                  <tr key={c}>
                    <td className="pr-6 text-slate-300">{CLASS_LABEL[c]}</td>
                    <td className="pr-3 text-slate-400">{cmp.counts[c].before}</td>
                    <td className="pr-3 text-slate-500">→</td>
                    <td className="text-slate-200">{cmp.counts[c].after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list("Cleared", cmp.cleared, "text-emerald-400")}
          {list("New", cmp.appeared, "text-amber-400")}
          {list("Changed class", cmp.changed, "text-sky-400")}
          <p className="text-xs text-slate-500">{cmp.unchanged} unchanged.</p>
        </div>
      )}
    </section>
  );
}
