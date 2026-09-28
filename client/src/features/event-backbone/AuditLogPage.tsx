import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { BUTTON, BUTTON_QUIET, FIELD, Field } from "../../components/ui";
import { useTerms } from "../../config/useConfig";
import { auditLogApi, webhooksApi } from "./api";
import { AdminOnly, PageHeader, errorText, formatTime, shortHash } from "./shared";
import type { AuditEntry, AuditFilters, AuditStatus, EventTypeInfo, VerifyResult } from "./types";
import { VerifyResultView } from "./VerifyResultView";

/** Settings → Audit log: browse, filter, verify and export the chained log. */
export function AuditLogPage() {
  return (
    <AdminOnly>
      <AuditLog />
    </AdminOnly>
  );
}

const EMPTY: AuditFilters = { type: "", subjectType: "", subjectId: "", actor: "", from: "", to: "" };

function AuditLog() {
  const [draft, setDraft] = useState<AuditFilters>(EMPTY);
  // What the list shows: the applied filters, and the id to start below
  // (null for the newest entries).
  const [query, setQuery] = useState<{ filters: AuditFilters; start: number | null }>({
    filters: EMPTY,
    start: null,
  });
  const filters = query.filters;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AuditStatus | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<EventTypeInfo[]>([]);

  const loadStatus = () => auditLogApi.status().then(setStatus).catch(() => undefined);

  const load = useCallback(async (f: AuditFilters, before: number | null, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const page = await auditLogApi.list(f, before);
      setEntries((prev) => (append ? [...prev, ...page.entries] : page.entries));
      setNextBefore(page.nextBefore);
    } catch (err) {
      setError(errorText(err, "Could not load the audit log."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(query.filters, query.start, false);
  }, [query, load]);

  useEffect(() => {
    void loadStatus();
    webhooksApi.catalog().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setQuery({ filters: { ...draft }, start: null });
  };

  const clear = () => {
    setDraft(EMPTY);
    setQuery({ filters: EMPTY, start: null });
  };

  const showBroken = (id: number) => {
    // Newest first, so starting below id + 1 puts the broken entry at the top.
    setDraft(EMPTY);
    setQuery({ filters: EMPTY, start: id + 1 });
  };

  const verify = async () => {
    setVerifying(true);
    setMessage(null);
    try {
      setResult(await auditLogApi.verify());
      void loadStatus();
    } catch (err) {
      setMessage(errorText(err, "Verification did not run."));
    } finally {
      setVerifying(false);
    }
  };

  const checkpoint = async () => {
    setMessage(null);
    try {
      const cp = await auditLogApi.checkpoint();
      setMessage(`Checkpoint #${cp.id} written and signed.`);
      void loadStatus();
      setQuery({ filters, start: null });
    } catch (err) {
      setMessage(errorText(err, "Could not write a checkpoint."));
    }
  };

  const typeSuggestions = [
    ...new Set([...catalog.map((t) => `${t.type.split(".")[0]}.`), ...catalog.map((t) => t.type)]),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Append-only and hash-chained in the database: each entry's hash covers the one before it, so an edit or a removal anywhere breaks the chain from that point. Export as NDJSON to hand over evidence that can be checked without this server."
      />

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-400">
          <span>
            <span className="text-slate-200">{status?.count.toLocaleString() ?? "…"}</span> entries
          </span>
          {status?.head && (
            <span>
              Head #{status.head.id} <code className="text-slate-500">{shortHash(status.head.hash)}</code>
            </span>
          )}
          <span>
            Last checkpoint:{" "}
            {status?.lastCheckpoint
              ? `#${status.lastCheckpoint.id}, ${formatTime(status.lastCheckpoint.occurredAt)}`
              : "none yet"}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={verify} disabled={verifying} className={BUTTON}>
            {verifying ? "Verifying…" : "Verify chain"}
          </button>
          <button onClick={checkpoint} className={BUTTON_QUIET}>
            Checkpoint now
          </button>
          <a href={auditLogApi.exportUrl("ndjson", filters)} className={BUTTON_QUIET}>
            Export NDJSON
          </a>
          <a href={auditLogApi.exportUrl("csv", filters)} className={BUTTON_QUIET}>
            Export CSV
          </a>
          {message && <span className="text-sm text-slate-400">{message}</span>}
        </div>
        {result && <VerifyResultView result={result} />}
        {result && !result.ok && result.firstBrokenId !== null && (
          <button onClick={() => showBroken(result.firstBrokenId!)} className="mt-2 text-sm text-sky-400 hover:text-sky-300">
            Show entries from #{result.firstBrokenId}
          </button>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Exports follow the filters below. NDJSON carries every field exactly as hashed; CSV is for spreadsheets.
        </p>
      </section>

      <form onSubmit={apply} className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5 sm:grid-cols-3">
        <Field label="Event type" hint="A prefix such as item. or a pattern such as *.deleted">
          <input
            className={FIELD}
            list="audit-type-suggestions"
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value })}
            placeholder="item."
          />
          <datalist id="audit-type-suggestions">
            {typeSuggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
        <Field label="Actor" hint="Name or id">
          <input
            className={FIELD}
            value={draft.actor}
            onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
          />
        </Field>
        <Field label="Subject" hint="Type and id, e.g. item and its id">
          <div className="flex gap-2">
            <input
              className={`${FIELD} w-28`}
              value={draft.subjectType}
              onChange={(e) => setDraft({ ...draft, subjectType: e.target.value })}
              placeholder="item"
            />
            <input
              className={FIELD}
              value={draft.subjectId}
              onChange={(e) => setDraft({ ...draft, subjectId: e.target.value })}
              placeholder="id"
            />
          </div>
        </Field>
        <Field label="From">
          <input
            type="date"
            className={FIELD}
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </Field>
        <Field label="To" hint="Includes the whole day">
          <input
            type="date"
            className={FIELD}
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </Field>
        <div className="flex items-end gap-3">
          <button type="submit" className={BUTTON}>
            Apply
          </button>
          <button type="button" onClick={clear} className={BUTTON_QUIET}>
            Clear
          </button>
        </div>
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Event</th>
              <th className="px-4 py-2 font-medium">By</th>
              <th className="px-4 py-2 font-medium">About</th>
              <th className="px-4 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <EntryRow key={e.id} entry={e} />
            ))}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextBefore && (
        <button onClick={() => void load(filters, nextBefore, true)} disabled={loading} className={BUTTON_QUIET}>
          {loading ? "Loading…" : "Load older entries"}
        </button>
      )}
    </div>
  );
}

function ActorLabel({ actor }: { actor: AuditEntry["actor"] }) {
  if (actor.kind === "system") return <span className="text-slate-500">System</span>;
  const kind = actor.kind === "api_key" ? "API key" : actor.kind === "device" ? "Device" : null;
  return (
    <span title={actor.id ?? undefined}>
      {actor.name ?? actor.id ?? "Unknown"}
      {kind && !actor.name?.startsWith("API key") && <span className="text-slate-500"> ({kind})</span>}
    </span>
  );
}

function SubjectLabel({ subject }: { subject: AuditEntry["subject"] }) {
  const terms = useTerms();
  if (!subject) return <span className="text-slate-600">—</span>;
  const short = subject.id.length > 12 ? `${subject.id.slice(0, 8)}…` : subject.id;
  if (subject.type === "item") {
    return (
      <Link to={`/items/${subject.id}`} className="text-sky-400 hover:text-sky-300" title={subject.id}>
        {terms.item.singular} {short}
      </Link>
    );
  }
  if (subject.type === "location") {
    return (
      <Link to={`/locations/${subject.id}`} className="text-sky-400 hover:text-sky-300" title={subject.id}>
        {terms.location.singular} {short}
      </Link>
    );
  }
  return (
    <span title={subject.id}>
      {subject.type.replace(/_/g, " ")} {short}
    </span>
  );
}

function EntryRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const summary = JSON.stringify(entry.data);
  return (
    <>
      <tr
        className="cursor-pointer border-b border-slate-800/50 align-top hover:bg-slate-800/40"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <td className="px-4 py-2 text-slate-500">{entry.id}</td>
        <td className="whitespace-nowrap px-4 py-2 text-slate-400">{formatTime(entry.occurredAt)}</td>
        <td className="px-4 py-2">
          <code className="text-slate-200">{entry.type}</code>
        </td>
        <td className="px-4 py-2 text-slate-300">
          <ActorLabel actor={entry.actor} />
        </td>
        <td className="px-4 py-2 text-slate-300" onClick={(e) => e.stopPropagation()}>
          <SubjectLabel subject={entry.subject} />
        </td>
        <td className="max-w-xs truncate px-4 py-2 font-mono text-xs text-slate-500">
          {summary === "{}" ? "" : summary}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-slate-800/50 bg-slate-950/40">
          <td colSpan={6} className="px-4 py-3">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-300">
              {JSON.stringify(entry.data, null, 2)}
            </pre>
            <dl className="mt-3 grid gap-1 font-mono text-xs text-slate-500">
              <div>
                <dt className="inline text-slate-400">prev_hash </dt>
                <dd className="inline break-all">{entry.prevHash}</dd>
              </div>
              <div>
                <dt className="inline text-slate-400">hash </dt>
                <dd className="inline break-all">{entry.hash}</dd>
              </div>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}
