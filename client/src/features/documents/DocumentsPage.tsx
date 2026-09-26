import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Modal } from "../media-ai-core";
import { documentsApi } from "./api";
import type { DocumentStatus, DocumentSummary, TemplateSummary } from "./types";
import {
  BTN,
  BTN_QUIET,
  CARD,
  DocumentsNav,
  FIELD,
  JobPicker,
  LABEL,
  Notice,
  SELECT,
  StatusBadge,
  errorText,
  fmtDateTime,
  useDocumentsMeta,
} from "./ui";

/**
 * Every document: filter by status or search, open one, or start a new one
 * from a published template, on a job or on its own.
 */
export function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") ?? "") as DocumentStatus | "";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [rows, setRows] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      documentsApi
        .list({ status: status || undefined, q: q.trim() || undefined })
        .then((r) => {
          if (!live) return;
          setRows(r);
          setError(null);
        })
        .catch((err) => live && setError(errorText(err, "Documents could not be loaded.")));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [status, q]);

  const setStatus = (s: string) => {
    const next = new URLSearchParams(params);
    if (s) next.set("status", s);
    else next.delete("status");
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Documents</h1>
        <button className={BTN} onClick={() => setCreating(true)}>
          New document
        </button>
      </div>
      <DocumentsNav />
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={`${FIELD} sm:max-w-xs`}
          placeholder="Search by title or job"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search documents"
        />
        <select className={SELECT} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="draft">Drafts</option>
          <option value="completed">Completed</option>
          <option value="signed">Signed</option>
        </select>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {rows && rows.length === 0 && (
        <Notice>
          No documents yet. Start one with <strong>New document</strong>, or set up a packet so jobs get theirs automatically.
        </Notice>
      )}
      {rows && rows.length > 0 && <DocumentList rows={rows} showJob />}
      {creating && <NewDocumentDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

export function DocumentList({ rows, showJob = false }: { rows: DocumentSummary[]; showJob?: boolean }) {
  return (
    <ul className={`${CARD} divide-y divide-slate-800 p-0`}>
      {rows.map((d) => (
        <li key={d.id}>
          <Link to={`/documents/${d.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-slate-800/40">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-slate-100">{d.title}</span>
              <span className="block truncate text-xs text-slate-500">
                {d.templateName} v{d.version}
                {showJob && d.jobCode ? ` · ${d.jobCode} ${d.jobName ?? ""}` : ""}
                {d.packetName ? ` · ${d.packetName}` : ""}
              </span>
            </span>
            <span className="text-xs text-slate-500">
              {d.status === "draft" ? `${d.filledCount} filled · ` : ""}
              {fmtDateTime(d.updatedAt)}
            </span>
            <StatusBadge status={d.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Pick a published template and, optionally, the job it is for. */
export function NewDocumentDialog({ onClose, jobId }: { onClose: () => void; jobId?: string }) {
  const navigate = useNavigate();
  const meta = useDocumentsMeta();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [job, setJob] = useState(jobId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    documentsApi
      .templates()
      .then((all) => setTemplates(all.filter((t) => t.publishedVersion !== null)))
      .catch((err) => setError(errorText(err)));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!templateId) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await documentsApi.create({ templateId, jobId: job || null });
      navigate(`/documents/${detail.document.id}`);
    } catch (err) {
      setError(errorText(err, "The document could not be started."));
      setBusy(false);
    }
  };

  return (
    <Modal title="New document" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className={LABEL}>Template</span>
          <select className={`${SELECT} mt-1 w-full`} value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
            <option value="">Pick a template</option>
            {templates?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (version {t.publishedVersion})
              </option>
            ))}
          </select>
        </label>
        {templates && templates.length === 0 && (
          <Notice tone="warn">No template has been published yet. An administrator can publish one under Templates.</Notice>
        )}
        {!jobId && meta?.jobs && (
          <div>
            <span className={LABEL}>Job (optional)</span>
            <div className="mt-1">
              <JobPicker value={job} onChange={(id) => setJob(id)} />
            </div>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex gap-2">
          <button type="submit" className={BTN} disabled={busy || !templateId}>
            {busy ? "Starting…" : "Start document"}
          </button>
          <button type="button" className={BTN_QUIET} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
