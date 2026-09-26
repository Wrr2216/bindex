import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { documentsApi } from "./api";
import { VerifyReportView } from "./DocumentPage";
import type { PdfCheck, VerifyReport } from "./types";
import { BTN, BTN_QUIET, CARD, DocumentsNav, FIELD, LABEL, Notice, errorText, fmtDateTime } from "./ui";

/**
 * Check a PDF someone holds: which exported document it is, and whether that
 * document still matches. Or check a document by the id printed in its footer.
 */
export function VerifyPage() {
  const [check, setCheck] = useState<PdfCheck | null>(null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [docId, setDocId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setCheck(null);
    setReport(null);
    try {
      setCheck(await documentsApi.verifyPdf(file));
    } catch (err) {
      setError(errorText(err, "The file could not be checked."));
    } finally {
      setBusy(false);
    }
  };

  const byId = async (e: FormEvent) => {
    e.preventDefault();
    const id = docId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      setError("Enter the document id exactly as printed in the footer.");
      return;
    }
    setError(null);
    setCheck(null);
    try {
      setReport(await documentsApi.verify(id));
    } catch (err) {
      setError(errorText(err, "That document could not be checked."));
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Verify a document</h1>
      <DocumentsNav />
      <section className={`${CARD} space-y-3`}>
        <p className="text-sm text-slate-400">
          Every PDF exported from a completed document is recorded by its SHA-256. Choose a copy to see which document it is
          and whether that document still matches what was exported. A copy that was edited, even by one byte, is not found.
        </p>
        <label className={`${BTN} inline-block cursor-pointer`}>
          {busy ? "Checking…" : "Choose a PDF"}
          <input type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
        </label>
      </section>
      <form onSubmit={byId} className={`${CARD} flex flex-col gap-2 sm:flex-row sm:items-end`}>
        <label className="flex-1">
          <span className={LABEL}>Or check a document by id</span>
          <input className={`${FIELD} mt-1 font-mono`} value={docId} onChange={(e) => setDocId(e.target.value)} placeholder="0f8fad5b-d9cb-469f-…" />
        </label>
        <button className={BTN_QUIET}>Check</button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
      {check && !check.found && (
        <Notice tone="error">
          No exported document has this file's hash (<span className="break-all font-mono">{check.sha256}</span>). It was not exported
          from here, or it has been changed since.
        </Notice>
      )}
      {check?.found && check.document && (
        <section className={`${CARD} space-y-3`}>
          <p className="text-sm text-slate-200">
            This is an export of <Link to={`/documents/${check.document.documentId}`} className="text-sky-400 hover:underline">{check.document.title}</Link>,
            made {fmtDateTime(check.exports[0]?.createdAt)} while it was {check.exports[0]?.status}.
          </p>
          {!check.document.exportedContentStillCurrent && (
            <Notice tone="warn">The document no longer matches what this copy was exported from.</Notice>
          )}
          <VerifyReportView report={check.document} />
        </section>
      )}
      {report && (
        <section className={CARD}>
          <VerifyReportView report={report} />
        </section>
      )}
    </div>
  );
}
