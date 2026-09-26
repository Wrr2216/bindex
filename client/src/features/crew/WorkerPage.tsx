import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AttachmentGallery, uploadAttachment } from "../media-ai-core";
import { crewApi } from "./api";
import { CredentialForm, WorkerForm } from "./forms";
import type { Credential, CredentialType, WorkerDetail } from "./types";
import {
  Avatar,
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  H2,
  LightChip,
  LightDot,
  Notice,
  errorText,
  fmtDate,
  fmtHours,
  fmtTime,
  openDocument,
  useCrewStatus,
} from "./ui";

/**
 * One worker: their badge, the credentials they hold (each with its documents),
 * and the shifts they have worked.
 */
export function WorkerPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const status = useCrewStatus();
  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [types, setTypes] = useState<CredentialType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [badgeVersion, setBadgeVersion] = useState(() => String(Date.now()));

  const load = useCallback(async () => {
    try {
      setWorker(await crewApi.worker(id));
      setError(null);
    } catch (err) {
      setError(errorText(err, "This worker could not be loaded."));
    }
  }, [id]);

  useEffect(() => {
    void load();
    crewApi.credentialTypes().then(setTypes).catch(() => undefined);
  }, [load]);

  const refreshBadge = async () => {
    setBadgeVersion(String(Date.now()));
    await load();
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: "ok", text: ok });
      await refreshBadge();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  };

  if (error && !worker) {
    return (
      <div className="space-y-4">
        <Link to="/crew?tab=workers" className="text-sm text-sky-400 hover:underline">
          ← Workers
        </Link>
        <Notice tone="error">{error}</Notice>
      </div>
    );
  }
  if (!worker) return <p className="text-slate-400">Loading…</p>;

  const reissue = () => {
    if (!window.confirm(`Issue ${worker.name} a new badge code? The old badge stops checking them in straight away.`)) return;
    void act(() => crewApi.reissueBadge(worker.id), "New badge code issued. Print the new badge.");
  };
  const verify = async () => {
    setMessage(null);
    try {
      const r = await crewApi.verify(worker.id);
      setMessage(
        !r.ok
          ? { tone: "warn", text: r.error ?? "The verifier could not be reached." }
          : !r.found
            ? { tone: "warn", text: "The verifier does not know this badge." }
            : {
                tone: "ok",
                text: `Checked with the verifier: ${r.merged ? `${r.merged} credential${r.merged === 1 ? "" : "s"} updated` : "nothing changed"}.${
                  r.unmatched.length ? ` It also reported ${r.unmatched.join(", ")}, which are not credential types here.` : ""
                }`,
              },
      );
      await load();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${worker.name}? Their credentials and documents go too.`)) return;
    try {
      await crewApi.deleteWorker(worker.id);
      navigate("/crew?tab=workers");
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  };

  return (
    <div className="space-y-5">
      <Link to="/crew?tab=workers" className="text-sm text-sky-400 hover:underline">
        ← Workers
      </Link>

      <section className={`${CARD} space-y-4`}>
        <div className="flex flex-wrap items-start gap-4">
          <Avatar worker={{ name: worker.name, photoUrl: worker.photoLargeUrl }} size="lg" />
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-slate-100">
              {worker.name}
              {!worker.active && <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">inactive</span>}
            </h1>
            <p className="text-sm text-slate-400">{[worker.company, worker.role, worker.phone].filter(Boolean).join(" · ") || "No details yet"}</p>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-slate-300">{worker.badgeCode}</span>
              <LightChip light={worker.light} />
              {worker.onJob && (
                <Link to={`/crew/jobs/${worker.onJob.jobId}`} className="rounded-full bg-sky-950 px-2 py-0.5 text-xs text-sky-300 hover:underline">
                  on {worker.onJob.jobCode} since {fmtTime(worker.onJob.since)}
                </Link>
              )}
            </p>
            {worker.notes && <p className="whitespace-pre-wrap text-sm text-slate-400">{worker.notes}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setEditing(!editing)} className={BTN_QUIET}>
            {editing ? "Close" : "Edit details"}
          </button>
          <button onClick={() => openDocument(crewApi.badgePdfUrl(worker.id, "card"))} className={BTN_QUIET}>
            Print badge
          </button>
          <button onClick={() => openDocument(crewApi.badgePdfUrl(worker.id, "sheet"))} className={BTN_QUIET}>
            Print on a sheet
          </button>
          <button onClick={reissue} className={BTN_QUIET}>
            New badge code
          </button>
          {status?.verifier.available && (
            <button onClick={() => void verify()} className={BTN_QUIET}>
              Check with verifier
            </button>
          )}
          <button onClick={() => void remove()} className={BTN_DANGER}>
            Delete
          </button>
        </div>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        {editing && (
          <WorkerForm
            initial={worker}
            onSaved={() => {
              setEditing(false);
              setMessage({ tone: "ok", text: "Saved." });
              void refreshBadge();
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </section>

      <BadgeSection worker={worker} version={badgeVersion} onChanged={refreshBadge} />
      <Credentials worker={worker} types={types} onChanged={load} />
      <ShiftsSection worker={worker} />
    </div>
  );
}

function BadgeSection({ worker, version, onChanged }: { worker: WorkerDetail; version: string; onChanged: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const a = await uploadAttachment(file, { ownerType: "crew_worker", ownerId: worker.id, kind: "photo", stage: "badge" });
      await crewApi.updateWorker(worker.id, { photoAttachmentId: a.id });
      await onChanged();
    } catch (err) {
      setError(errorText(err, "The photo could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className={H2}>Badge</h2>
      <div className="flex flex-wrap items-start gap-4">
        <img
          src={crewApi.badgePngUrl(worker.id, version)}
          alt={`Badge for ${worker.name}`}
          className="w-40 rounded-lg border border-slate-700 bg-white"
        />
        <div className="space-y-2 text-sm text-slate-400">
          <p>
            The QR opens this page from a phone camera, and checks {worker.name} in when scanned on a job's check-in screen. It
            prints at bank-card size (CR80) for a card printer or badge holder.
          </p>
          <input
            ref={input}
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <button onClick={() => input.current?.click()} disabled={busy} className={BTN}>
              {busy ? "Uploading…" : worker.photoAttachmentId ? "Change photo" : "Add photo"}
            </button>
            {worker.photoAttachmentId && (
              <button
                onClick={() => void crewApi.updateWorker(worker.id, { photoAttachmentId: null }).then(onChanged)}
                className={BTN_QUIET}
              >
                Remove photo from badge
              </button>
            )}
          </div>
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      </div>
    </section>
  );
}

function Credentials({ worker, types, onChanged }: { worker: WorkerDetail; types: CredentialType[]; onChanged: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [docs, setDocs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (c: Credential) => {
    if (!window.confirm(`Delete ${c.typeName}${c.number ? ` ${c.number}` : ""}? Its documents go too.`)) return;
    try {
      await crewApi.deleteCredential(c.id);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className={H2}>Credentials</h2>
        {!adding && types.length > 0 && (
          <button onClick={() => setAdding(true)} className={BTN_QUIET}>
            Add credential
          </button>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {adding && (
        <CredentialForm
          types={types}
          onSubmit={async (input) => {
            await crewApi.addCredential(worker.id, input);
            setAdding(false);
            await onChanged();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {worker.credentials.length === 0 && !adding && (
        <p className="text-sm text-slate-500">Nothing on file. Add their licences, inductions and checks so the door can judge them.</p>
      )}
      <ul className="space-y-2">
        {worker.credentials.map((c) =>
          editing === c.id ? (
            <li key={c.id}>
              <CredentialForm
                types={types}
                initial={c}
                onSubmit={async (input) => {
                  const { typeId: _t, ...patch } = input;
                  await crewApi.updateCredential(c.id, patch);
                  setEditing(null);
                  await onChanged();
                }}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={c.id} className={`${CARD} space-y-2`}>
              <div className="flex flex-wrap items-center gap-3">
                <LightDot light={c.light} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-100">
                    {c.typeName}
                    {c.number && <span className="ml-2 font-mono text-xs text-slate-400">{c.number}</span>}
                    {c.source === "verifier" && <span className="ml-2 rounded bg-slate-800 px-1.5 text-[10px] uppercase text-slate-400">from verifier</span>}
                    {!c.typeActive && <span className="ml-2 text-xs text-slate-500">(retired type)</span>}
                  </p>
                  <p className={`text-xs ${c.light === "red" ? "text-red-300" : c.light === "amber" ? "text-amber-300" : "text-slate-400"}`}>
                    {c.label}
                    {c.issuer ? ` · ${c.issuer}` : ""}
                    {c.issuedOn ? ` · issued ${fmtDate(c.issuedOn)}` : ""}
                    {c.expiresOn ? ` · expires ${fmtDate(c.expiresOn)}` : ""}
                    {c.verifiedAt ? ` · checked ${fmtTime(c.verifiedAt)}` : ""}
                  </p>
                  {c.notes && <p className="text-xs text-slate-500">{c.notes}</p>}
                </div>
                <div className="flex gap-3 text-xs">
                  <button onClick={() => setDocs(docs === c.id ? null : c.id)} className="text-sky-400 hover:underline" aria-expanded={docs === c.id}>
                    Documents{c.documentCount ? ` (${c.documentCount})` : ""}
                  </button>
                  {c.source === "manual" && (
                    <button onClick={() => setEditing(c.id)} className="text-sky-400 hover:underline">
                      Edit
                    </button>
                  )}
                  <button onClick={() => void remove(c)} className="text-red-400 hover:underline">
                    Delete
                  </button>
                </div>
              </div>
              {docs === c.id && (
                <AttachmentGallery
                  ownerType="crew_credential"
                  ownerId={c.id}
                  title="Documents"
                  kinds={["photo", "document"]}
                  onChange={(list) => {
                    if (list.length !== c.documentCount) void onChanged();
                  }}
                />
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

function ShiftsSection({ worker }: { worker: WorkerDetail }) {
  if (worker.checkins.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className={H2}>Shifts</h2>
        <span className="text-sm text-slate-400">
          {worker.totals.shifts} shift{worker.totals.shifts === 1 ? "" : "s"} · {fmtHours(worker.totals.minutes)} h in all
        </span>
      </div>
      <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
        {worker.checkins.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <LightDot light={s.compliance} title={s.overrideReason ? `Overridden: ${s.overrideReason}` : undefined} />
            <Link to={`/crew/jobs/${s.jobId}`} className="text-sky-400 hover:underline">
              {s.jobCode}
            </Link>
            <span className="min-w-0 flex-1 truncate text-slate-300">{s.jobName}</span>
            <span className="text-slate-400">
              {fmtTime(s.checkedInAt)} – {s.checkedOutAt ? fmtTime(s.checkedOutAt) : "on site"}
            </span>
            <span className="w-16 text-right tabular-nums text-slate-100">{fmtHours(s.minutes)} h</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
