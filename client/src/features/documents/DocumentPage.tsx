import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { Modal, SignDialog } from "../media-ai-core";
import { documentsApi } from "./api";
import type { CopySource, DocumentDetail, FieldDef, RenderBlock, SignatureValue, VerifyReport } from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  LABEL,
  Notice,
  SELECT,
  StatusBadge,
  errorText,
  fmtDateTime,
  openPdf,
  useDocumentsMeta,
  useIsAdmin,
} from "./ui";

/**
 * Fill in one document. Every change saves itself a moment after typing
 * stops. Completing checks the required fields and fixes the values; each
 * signature field is then signed through the signing dialog, against exactly
 * the content the server hashed.
 */

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const isSigning = (f: FieldDef) => f.type === "signature" || f.type === "initials";

function isEmpty(f: FieldDef, v: unknown): boolean {
  if (f.type === "checkbox") return v !== true;
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

export function DocumentPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const admin = useIsAdmin();
  const meta = useDocumentsMeta();
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn" | "info"; text: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [signing, setSigning] = useState<FieldDef | null>(null);
  const [dialog, setDialog] = useState<"copy" | "verify" | "share" | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<number | undefined>(undefined);

  const apply = useCallback((d: DocumentDetail) => {
    setDetail(d);
    setValues(d.document.values);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await documentsApi.get(id));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, "This document could not be loaded."));
    }
  }, [id, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  // Merge fields such as {{field.customer}} in the text follow what is typed.
  const mergesFields = !!detail?.version.body.some(
    (b) => (b.type === "heading" || b.type === "paragraph") && /\{\{\s*field\./.test(b.text),
  );

  const flush = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return true;
    setSaveState("saving");
    try {
      await documentsApi.save(id, { values: patch });
      setSaveState(Object.keys(pending.current).length ? "dirty" : "saved");
      setFieldErrors((e) => {
        const next = { ...e };
        for (const k of Object.keys(patch)) delete next[k];
        return next;
      });
      if (mergesFields) {
        documentsApi
          .get(id)
          .then((d) => setDetail((cur) => (cur ? { ...cur, render: d.render } : d)))
          .catch(() => undefined);
      }
      return true;
    } catch (err) {
      const problems = (err instanceof ApiError ? (err.details as { problems?: { key: string; message: string }[] }) : undefined)
        ?.problems;
      if (problems?.length) setFieldErrors((e) => ({ ...e, ...Object.fromEntries(problems.map((p) => [p.key, p.message])) }));
      setSaveState("error");
      setMessage({ tone: "error", text: errorText(err, "Your last change could not be saved.") });
      return false;
    }
  }, [id, mergesFields]);

  // Save what is left when leaving the page.
  useEffect(() => () => void flush(), [flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const change = (key: string, value: unknown) => {
    setValues((v) => ({ ...v, [key]: value }));
    setMissing((m) => {
      if (!m.has(key)) return m;
      const next = new Set(m);
      next.delete(key);
      return next;
    });
    pending.current[key] = value;
    setSaveState("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 700);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  if (loadError && !detail) return <Notice tone="error">{loadError}</Notice>;
  if (!detail) return <p className="text-slate-400">Loading…</p>;

  const doc = detail.document;
  const fields = detail.version.body.flatMap((b) => (b.type === "field" ? [b.field] : []));
  const draft = doc.status === "draft";
  const anySigned = fields.some((f) => isSigning(f) && !!(values[f.key] as SignatureValue | undefined)?.signatureId);
  const newer = detail.template.latestVersion !== null && detail.template.latestVersion > detail.version.version;

  const complete = () =>
    run(async () => {
      if (!(await flush())) return;
      const empty = fields.filter((f) => f.required && !isSigning(f) && isEmpty(f, values[f.key]));
      if (empty.length) {
        setMissing(new Set(empty.map((f) => f.key)));
        setMessage({ tone: "warn", text: `Fill in ${empty.map((f) => f.label).join(", ")} first.` });
        document.getElementById(`field-${empty[0]!.key}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      apply(await documentsApi.complete(id));
      setMessage({ tone: "ok", text: "Completed. The values are fixed; signature fields can now be signed." });
    });

  const reopen = () =>
    run(async () => {
      apply(await documentsApi.reopen(id));
      setMessage({ tone: "info", text: "Back to draft." });
    });

  const duplicate = () =>
    run(async () => {
      await flush();
      const copy = await documentsApi.duplicate(id);
      navigate(`/documents/${copy.document.id}`);
    });

  const remove = () =>
    run(async () => {
      if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
      await documentsApi.remove(id);
      navigate(doc.jobId ? `/documents/jobs/${doc.jobId}` : "/documents");
    });

  const signed = async (fieldKey: string, signatureId: string) => {
    setSigning(null);
    await run(async () => {
      apply(await documentsApi.attachSignature(id, fieldKey, signatureId));
      setMessage({ tone: "ok", text: "Signed." });
    });
  };

  const saveLabel = { idle: "", dirty: "Unsaved changes…", saving: "Saving…", saved: "All changes saved", error: "Not saved" }[saveState];

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
          <Link to="/documents" className="hover:text-slate-200">
            Documents
          </Link>
          {detail.job && (
            <>
              <span>/</span>
              <Link to={`/documents/jobs/${detail.job.id}`} className="hover:text-slate-200">
                {detail.job.code} {detail.job.name}
              </Link>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-100">{detail.render.title || doc.title}</h1>
            <p className="text-sm text-slate-500">
              {detail.template.name}, version {detail.version.version}
              {detail.packet ? ` · ${detail.packet.name}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {draft && <span className={`text-xs ${saveState === "error" ? "text-red-400" : "text-slate-500"}`}>{saveLabel}</span>}
            <StatusBadge status={doc.status} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {draft && (
            <button className={BTN} disabled={busy} onClick={complete}>
              Complete
            </button>
          )}
          <button className={BTN_QUIET} onClick={() => void flush().then(() => openPdf(documentsApi.pdfUrl(id)))}>
            {draft ? "Draft PDF" : "Export PDF"}
          </button>
          {draft && (
            <button className={BTN_QUIET} disabled={busy} onClick={() => setDialog("copy")}>
              Copy from…
            </button>
          )}
          <button className={BTN_QUIET} disabled={busy} onClick={duplicate}>
            Duplicate
          </button>
          {!draft && (
            <button className={BTN_QUIET} onClick={() => setDialog("verify")}>
              Verify
            </button>
          )}
          {doc.status === "completed" && !anySigned && (
            <button className={BTN_QUIET} disabled={busy} onClick={reopen}>
              Reopen
            </button>
          )}
          {meta?.share.available && (
            <button className={BTN_QUIET} onClick={() => setDialog("share")}>
              Share
            </button>
          )}
          {(draft || admin) && (
            <button className={BTN_DANGER} disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </header>

      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {draft && newer && (
        <Notice tone="info">
          This draft uses version {detail.version.version}; version {detail.template.latestVersion} is now published.
          Duplicate it to carry the values over to the new version.
        </Notice>
      )}
      {admin && detail.render.unknown.length > 0 && (
        <Notice tone="warn">
          This template mentions placeholders that match nothing: {detail.render.unknown.map((u) => `{{${u}}}`).join(", ")}.
        </Notice>
      )}

      <article className={`${CARD} space-y-4 p-5`}>
        {detail.render.blocks.map((block) => (
          <BlockView
            key={block.id}
            block={block}
            value={block.type === "field" ? values[block.field.key] : undefined}
            editable={draft}
            error={block.type === "field" ? fieldErrors[block.field.key] : undefined}
            missing={block.type === "field" && missing.has(block.field.key)}
            canSign={!draft && !!detail.signing}
            signatureImage={(sigId) => detail.signatures.find((s) => s.id === sigId)?.imageUrl ?? null}
            onChange={change}
            onBlur={() => void flush()}
            onSign={setSigning}
          />
        ))}
      </article>

      {!draft && <RecordPanel detail={detail} />}

      {signing && detail.signing?.[signing.key] && (
        <SignDialog
          ownerType="document"
          ownerId={doc.id}
          title={signing.type === "initials" ? `Initial: ${signing.label}` : `Sign: ${signing.label}`}
          statement={detail.signing[signing.key]!.statement}
          content={detail.signing[signing.key]!.content}
          onSigned={(sig) => void signed(signing.key, sig.id)}
          onClose={() => setSigning(null)}
        />
      )}
      {dialog === "copy" && (
        <CopyFromDialog
          documentId={id}
          onClose={() => setDialog(null)}
          onCopied={(text) => {
            setDialog(null);
            setMessage({ tone: "ok", text });
            void load();
          }}
          flush={flush}
        />
      )}
      {dialog === "verify" && <VerifyDialog documentId={id} onClose={() => setDialog(null)} />}
      {dialog === "share" && <ShareDialog documentId={id} onClose={() => setDialog(null)} />}
    </div>
  );
}

function BlockView({
  block,
  value,
  editable,
  error,
  missing,
  canSign,
  signatureImage,
  onChange,
  onBlur,
  onSign,
}: {
  block: RenderBlock;
  value: unknown;
  editable: boolean;
  error?: string;
  missing: boolean;
  canSign: boolean;
  signatureImage: (signatureId: string) => string | null;
  onChange: (key: string, value: unknown) => void;
  onBlur: () => void;
  onSign: (field: FieldDef) => void;
}) {
  switch (block.type) {
    case "heading": {
      const cls = block.level === 1 ? "text-xl" : block.level === 2 ? "text-lg" : "text-base";
      return <h2 className={`${cls} pt-2 font-semibold text-slate-100`}>{block.text}</h2>;
    }
    case "paragraph":
      return <p className="whitespace-pre-line text-sm leading-relaxed text-slate-300">{block.text}</p>;
    case "divider":
      return <hr className="border-slate-800" />;
    case "table":
      return <TableView block={block} />;
    case "field":
      return (
        <FieldView
          field={block.field}
          value={value}
          display={block.display}
          signature={block.signature}
          editable={editable}
          error={error ?? (missing ? "Required" : undefined)}
          canSign={canSign}
          signatureImage={signatureImage}
          onChange={(v) => onChange(block.field.key, v)}
          onBlur={onBlur}
          onSign={() => onSign(block.field)}
        />
      );
  }
}

function FieldView({
  field,
  value,
  display,
  signature,
  editable,
  error,
  canSign,
  signatureImage,
  onChange,
  onBlur,
  onSign,
}: {
  field: FieldDef;
  value: unknown;
  display: string;
  signature: SignatureValue | null;
  editable: boolean;
  error?: string;
  canSign: boolean;
  signatureImage: (signatureId: string) => string | null;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  onSign: () => void;
}) {
  const id = `field-${field.key}`;
  const border = error ? "border-red-600" : "";
  const label = (
    <>
      {field.label}
      {field.required && <span className="text-red-400"> *</span>}
    </>
  );
  const help = field.help && <span className="mt-1 block text-xs text-slate-500">{field.help}</span>;
  const problem = error && <span className="mt-1 block text-xs text-red-400">{error}</span>;

  if (isSigning(field)) {
    const img = signature ? signatureImage(signature.signatureId) : null;
    return (
      <div id={id} className={`rounded-lg border ${error ? "border-red-600" : "border-slate-800"} bg-slate-950/40 p-3`}>
        <span className={LABEL}>{label}</span>
        {signature ? (
          <div className="mt-2 space-y-1">
            {img && (
              <img
                src={img}
                alt={`Signature of ${signature.signerName}`}
                className={`${field.type === "initials" ? "h-12" : "h-20"} rounded bg-white p-1`}
              />
            )}
            <p className="text-sm text-slate-200">
              {signature.signerName}
              {signature.signerRole ? `, ${signature.signerRole}` : ""}
            </p>
            <p className="text-xs text-slate-500">Signed {fmtDateTime(signature.signedAt)}</p>
          </div>
        ) : canSign ? (
          <button type="button" className={`${BTN} mt-2`} onClick={onSign}>
            {field.type === "initials" ? "Initial" : "Sign"}
          </button>
        ) : (
          <p className="mt-2 text-sm text-slate-500">Signed after the document is completed.</p>
        )}
        {help}
        {problem}
      </div>
    );
  }

  if (!editable) {
    return (
      <div id={id}>
        <span className={LABEL}>{label}</span>
        <p className="mt-1 min-h-[1.5rem] whitespace-pre-line border-b border-slate-800 pb-1 text-sm text-slate-100">
          {field.type === "checkbox" ? (value === true ? "Yes" : "No") : display || <span className="text-slate-600">Not filled in</span>}
        </p>
      </div>
    );
  }

  if (field.type === "checkbox") {
    return (
      <div id={id}>
        <label className="flex items-start gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-sky-500"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{label}</span>
        </label>
        {help}
        {problem}
      </div>
    );
  }

  const str = value === undefined || value === null ? "" : String(value);
  let input: ReactNode;
  switch (field.type) {
    case "select":
      input = (
        <select id={`${id}-input`} className={`${SELECT} w-full ${border}`} value={str} onChange={(e) => onChange(e.target.value)} onBlur={onBlur}>
          <option value="">Choose…</option>
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case "number":
      input = (
        <input
          id={`${id}-input`}
          type="number"
          inputMode="decimal"
          className={`${FIELD} ${border}`}
          value={str}
          min={field.min}
          max={field.max}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      );
      break;
    case "date":
      input = (
        <input id={`${id}-input`} type="date" className={`${FIELD} ${border}`} value={str} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />
      );
      break;
    default:
      input = field.multiline ? (
        <textarea
          id={`${id}-input`}
          rows={4}
          className={`${FIELD} ${border}`}
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      ) : (
        <input
          id={`${id}-input`}
          className={`${FIELD} ${border}`}
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      );
  }
  return (
    <div id={id}>
      <label htmlFor={`${id}-input`} className={LABEL}>
        {label}
      </label>
      <div className="mt-1">{input}</div>
      {help}
      {problem}
    </div>
  );
}

const TABLE_PREVIEW_ROWS = 100;

function TableView({ block }: { block: Extract<RenderBlock, { type: "table" }> }) {
  const [all, setAll] = useState(false);
  const rows = all ? block.rows : block.rows.slice(0, TABLE_PREVIEW_ROWS);
  return (
    <div className="space-y-2">
      {block.title && <h3 className="font-semibold text-slate-200">{block.title}</h3>}
      {block.rows.length === 0 ? (
        <p className="text-sm italic text-slate-500">{block.emptyText}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-800/60 text-xs uppercase text-slate-400">
              <tr>
                {block.columns.map((c) => (
                  <th key={c.key} className="px-3 py-2 font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-1.5 text-slate-300">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(block.rows.length > TABLE_PREVIEW_ROWS || block.truncated) && (
        <p className="text-xs text-slate-500">
          {all ? `${block.rows.length} rows` : `Showing ${rows.length} of ${block.total}`}
          {block.rows.length > TABLE_PREVIEW_ROWS && (
            <button className="ml-2 text-sky-400 hover:underline" onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer" : "Show all"}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** Content hash, who completed it, and every PDF exported, for a completed document. */
function RecordPanel({ detail }: { detail: DocumentDetail }) {
  const doc = detail.document;
  return (
    <section className={`${CARD} space-y-2 text-sm`} aria-label="Record">
      <h2 className={H2}>Record</h2>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-slate-500">Completed</dt>
        <dd className="text-slate-200">
          {fmtDateTime(doc.completedAt)}
          {doc.completedBy ? ` by ${doc.completedBy}` : ""}
        </dd>
        {doc.signedAt && (
          <>
            <dt className="text-slate-500">Signed</dt>
            <dd className="text-slate-200">{fmtDateTime(doc.signedAt)}</dd>
          </>
        )}
        <dt className="text-slate-500">Document id</dt>
        <dd className="break-all font-mono text-xs text-slate-300">{doc.id}</dd>
        <dt className="text-slate-500">Content sha256</dt>
        <dd className="break-all font-mono text-xs text-slate-300">{doc.contentHash}</dd>
      </dl>
      {detail.exports.length > 0 && (
        <div>
          <h3 className="mt-2 text-xs font-medium uppercase text-slate-500">Exported PDFs</h3>
          <ul className="mt-1 space-y-1">
            {detail.exports.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-3 text-xs text-slate-400">
                <span>{fmtDateTime(e.createdAt)}</span>
                <span>{e.status}</span>
                <span className="break-all font-mono">sha256 {e.sha256}</span>
                {e.attachmentId && (
                  <a className="text-sky-400 hover:underline" href={`/api/attachments/${e.attachmentId}`} target="_blank" rel="noreferrer">
                    Download
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function CopyFromDialog({
  documentId,
  onClose,
  onCopied,
  flush,
}: {
  documentId: string;
  onClose: () => void;
  onCopied: (message: string) => void;
  flush: () => Promise<boolean>;
}) {
  const [sources, setSources] = useState<CopySource[] | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    documentsApi
      .copySources(documentId)
      .then(setSources)
      .catch((err) => setError(errorText(err)));
  }, [documentId]);

  const copy = async (source: CopySource) => {
    setBusy(true);
    setError(null);
    try {
      await flush();
      const r = await documentsApi.copyFrom(documentId, source.id, overwrite);
      const skipped = r.skipped.length ? ` ${r.skipped.length} left as they were.` : "";
      onCopied(`Copied ${r.copied.length} field${r.copied.length === 1 ? "" : "s"} from "${source.title}".${skipped}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Copy from another document" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-slate-400">
          Fields with the same key are filled in from the document you pick. Signatures are never copied.
        </p>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" className="accent-sky-500" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          Replace fields already filled in here
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        {sources && sources.length === 0 && <Notice>No other document has fields in common with this one.</Notice>}
        <ul className="divide-y divide-slate-800">
          {sources?.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-100">{s.title}</span>
                <span className="block truncate text-xs text-slate-500">
                  {s.templateName}
                  {s.jobCode ? ` · ${s.jobCode}` : ""} · {s.shared} field{s.shared === 1 ? "" : "s"} in common · {fmtDateTime(s.updatedAt)}
                </span>
              </span>
              <StatusBadge status={s.status} />
              <button className={BTN_QUIET} disabled={busy} onClick={() => void copy(s)}>
                Copy
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

const REASONS: Record<string, string> = {
  ok: "valid",
  content_changed: "the document changed after signing",
  image_missing: "the signature image is missing",
  image_altered: "the signature image was altered",
  signature_missing: "the signature record is missing",
};

export function VerifyReportView({ report }: { report: VerifyReport }) {
  return (
    <div className="space-y-2 text-sm">
      <Notice tone={report.valid ? "ok" : "error"}>
        {report.valid
          ? "Verified: the document matches its recorded content hash and every signature is intact."
          : report.status === "draft"
            ? "This document is a draft; nothing is fixed yet."
            : "Verification failed. See below."}
      </Notice>
      {report.status !== "draft" && (
        <ul className="space-y-1 text-slate-300">
          <li>
            Content: {report.content.matches ? "matches" : "does not match"} the recorded hash
            <span className="block break-all font-mono text-xs text-slate-500">recorded {report.content.storedHash}</span>
            {!report.content.matches && (
              <span className="block break-all font-mono text-xs text-slate-500">now {report.content.currentHash}</span>
            )}
          </li>
          {report.signatures.map((s) => (
            <li key={s.signatureId} className={s.valid ? "" : "text-red-300"}>
              {s.label}: {s.signerName}, {REASONS[s.reason] ?? s.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VerifyDialog({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    documentsApi
      .verify(documentId)
      .then(setReport)
      .catch((err) => setError(errorText(err)));
  }, [documentId]);
  return (
    <Modal title="Verify document" onClose={onClose}>
      {error && <Notice tone="error">{error}</Notice>}
      {report ? <VerifyReportView report={report} /> : !error && <p className="text-slate-400">Checking…</p>}
    </Modal>
  );
}

function ShareDialog({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(14);
  const [allowSigning, setAllowSigning] = useState(true);
  const [result, setResult] = useState<{ url: string; expiresAt: string | null; message?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const share = async () => {
    setError(null);
    try {
      setResult(await documentsApi.share(documentId, { email: email.trim() || null, expiresInDays: days, allowSigning }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title="Share through the portal" onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className={LABEL}>Email (optional)</span>
          <input className={`${FIELD} mt-1`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">
          <span className={LABEL}>Link lasts (days)</span>
          <input className={`${FIELD} mt-1`} type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value) || 14)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" className="accent-sky-500" checked={allowSigning} onChange={(e) => setAllowSigning(e.target.checked)} />
          Let them sign fields that are still unsigned
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        {result && (
          <Notice tone="ok">
            {result.message ?? "Link ready:"} <span className="break-all font-mono">{result.url}</span>
          </Notice>
        )}
        <button className={BTN} onClick={() => void share()}>
          Create link
        </button>
      </div>
    </Modal>
  );
}
