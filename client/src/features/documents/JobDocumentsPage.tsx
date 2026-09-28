import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useFeatures } from "../../config/useConfig";
import { documentsApi } from "./api";
import { DocumentList, NewDocumentDialog } from "./DocumentsPage";
import type { JobDocuments, Packet } from "./types";
import { BTN, BTN_QUIET, CARD, DocumentsNav, H2, Notice, SELECT, errorText, fmtDateTime } from "./ui";

/** One job's packets and documents: check packets, add one by hand, start a document. */
export function JobDocumentsPage() {
  const { jobId = "" } = useParams();
  return <JobDocumentsPanel jobId={jobId} standalone />;
}

/**
 * The job's documents. Also usable as a panel on the job page:
 * `<JobDocumentsPanel jobId={job.id} />`.
 */
export function JobDocumentsPanel({ jobId, standalone = false }: { jobId: string; standalone?: boolean }) {
  const features = useFeatures();
  const [data, setData] = useState<JobDocuments | null>(null);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [pick, setPick] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await documentsApi.forJob(jobId));
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err, "This job's documents could not be loaded.") });
    }
  }, [jobId]);

  useEffect(() => {
    void load();
    documentsApi.packets().then(setPackets).catch(() => undefined);
  }, [load]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      setMessage({ tone: "ok", text });
      await load();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const sync = () =>
    run(async () => {
      const r = await documentsApi.syncJob(jobId);
      const parts = [
        ...r.attached.map((a) => `attached ${a.name} (${a.documents} document${a.documents === 1 ? "" : "s"})`),
        ...r.withdrawn.map((w) => `withdrew ${w.name}${w.kept ? `, keeping ${w.kept} filled in` : ""}`),
        ...r.attached.flatMap((a) => (a.unpublished.length ? [`${a.unpublished.join(", ")} not published yet`] : [])),
      ];
      return parts.length ? `Packets checked: ${parts.join("; ")}.` : "Packets checked: nothing to change.";
    });

  const attach = () =>
    run(async () => {
      const r = await documentsApi.attachPacket(jobId, pick);
      setPick("");
      const unpublished = r.unpublished.length ? ` Not published yet, so skipped: ${r.unpublished.join(", ")}.` : "";
      return `Added ${r.name}: ${r.documents} document${r.documents === 1 ? "" : "s"}.${unpublished}`;
    });

  const detach = (packetId: string, name: string) => {
    if (!window.confirm(`Take "${name}" off this job? Documents nobody has filled in are removed; the rest stay.`)) return;
    return run(async () => {
      const r = await documentsApi.detachPacket(jobId, packetId);
      return `Removed ${name}: ${r.removed} untouched document${r.removed === 1 ? "" : "s"} deleted, ${r.kept} kept.`;
    });
  };

  if (!data) {
    return message ? <Notice tone="error">{message.text}</Notice> : <p className="text-slate-400">Loading…</p>;
  }

  const attached = new Set(data.packets.filter((p) => p.applies).map((p) => p.packetId));
  const available = packets.filter((p) => p.active && !attached.has(p.id));
  const byPacket = new Map<string | null, JobDocuments["documents"]>();
  for (const d of data.documents) {
    const key = d.packetId && data.packets.some((p) => p.packetId === d.packetId) ? d.packetId : null;
    byPacket.set(key, [...(byPacket.get(key) ?? []), d]);
  }

  return (
    <div className="space-y-4">
      {standalone && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-slate-100">Documents for {data.job.code}</h1>
              <p className="text-sm text-slate-400">
                {features.jobs ? (
                  <Link to={`/jobs/${data.job.id}`} className="hover:text-slate-200">
                    {data.job.name}
                  </Link>
                ) : (
                  data.job.name
                )}
              </p>
            </div>
            <button className={BTN} onClick={() => setCreating(true)}>
              New document
            </button>
          </div>
          <DocumentsNav />
        </>
      )}
      <section className={`${CARD} space-y-3`} aria-label="Packets">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={H2}>Packets</h2>
          <div className="flex flex-wrap gap-2">
            <button className={BTN_QUIET} disabled={busy} onClick={() => void sync()}>
              Check packets
            </button>
            {!standalone && (
              <button className={BTN_QUIET} onClick={() => setCreating(true)}>
                New document
              </button>
            )}
          </div>
        </div>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        {data.packets.length === 0 ? (
          <p className="text-sm text-slate-500">No packet applies to this job yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.packets.map((p) => (
              <li key={p.packetId} className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-200">{p.name}</span>
                <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                  {p.auto ? "by its conditions" : "added by hand"}
                </span>
                {!p.applies && (
                  <span className="rounded-full bg-amber-950 px-2 py-0.5 text-xs text-amber-300">no longer matches this job</span>
                )}
                <span className="text-xs text-slate-500">{fmtDateTime(p.attachedAt)}</span>
                <button className="ml-auto text-xs text-slate-400 hover:text-red-300" disabled={busy} onClick={() => void detach(p.packetId, p.name)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {available.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <select className={`${SELECT} flex-1`} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Packet to add">
              <option value="">Add a packet by hand…</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className={BTN_QUIET} disabled={!pick || busy} onClick={() => void attach()}>
              Add packet
            </button>
          </div>
        )}
      </section>

      {data.documents.length === 0 ? (
        <Notice>No documents on this job yet.</Notice>
      ) : (
        [...byPacket.entries()].map(([packetId, docs]) => (
          <section key={packetId ?? "none"} className="space-y-2">
            <h2 className={H2}>{packetId ? data.packets.find((p) => p.packetId === packetId)?.name : "Other documents"}</h2>
            <DocumentList rows={docs} />
          </section>
        ))
      )}
      {creating && <NewDocumentDialog jobId={jobId} onClose={() => setCreating(false)} />}
    </div>
  );
}
