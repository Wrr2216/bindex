import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { CameraIcon } from "../../components/icons";
import { useFeatures } from "../../config/useConfig";
import { AttachmentGallery } from "../media-ai-core";
import { inspectionsApi } from "./api";
import { ComparisonPanel } from "./Comparison";
import { FindingEditor, type FindingDefaults } from "./FindingEditor";
import { SharesPanel } from "./Shares";
import { SignoffsPanel } from "./Signoffs";
import type { Finding, InspectionDetail as Detail, InspectionSummary, InspectionsMeta } from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  KIND_LABEL,
  KindBadge,
  LABEL,
  Notice,
  SELECT,
  SeverityBadge,
  StatusBadge,
  errorText,
  fmtDateTime,
  spotLabel,
  useInspectionsMeta,
  useLocationOptions,
} from "./ui";

/**
 * One inspection: its details, the findings by room with "Add damage by AI"
 * and "Enter manually", the comparison for a post-inspection, the two
 * sign-offs, share links and the PDF.
 */
export function InspectionDetail() {
  const { id = "" } = useParams();
  const meta = useInspectionsMeta();
  const [inspection, setInspection] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInspection(await inspectionsApi.get(id));
      setError(null);
    } catch (err) {
      setError(errorText(err, "This inspection could not be loaded."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !inspection) return <Notice tone="error">{error}</Notice>;
  if (!inspection || !meta) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="space-y-5">
      <Header inspection={inspection} onChanged={setInspection} />
      {error && <Notice tone="error">{error}</Notice>}
      {inspection.kind === "post" && <ComparisonPanel inspection={inspection} meta={meta} onChanged={load} />}
      <Findings inspection={inspection} meta={meta} onChanged={load} />
      <section className={CARD}>
        <AttachmentGallery
          ownerType="inspection"
          ownerId={inspection.id}
          stage="overview"
          kinds={["photo", "video"]}
          title="Site photos"
          readOnly={!inspection.editable}
        />
      </section>
      <SignoffsPanel inspection={inspection} meta={meta} onChanged={load} />
      <SharesPanel inspectionId={inspection.id} meta={meta} />
    </div>
  );
}

function Header({ inspection, onChanged }: { inspection: Detail; onChanged: (d: Detail) => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const features = useFeatures();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const act = async (fn: () => Promise<Detail>) => {
    setBusy(true);
    setMessage(null);
    try {
      onChanged(await fn());
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${inspection.code}? Its findings, photos and signatures go with it.`)) return;
    try {
      await inspectionsApi.remove(inspection.id);
      navigate("/inspections");
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const canDelete = inspection.status !== "signed" || user?.role === "admin";

  return (
    <section className={`${CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/inspections" className="text-sm text-slate-400 hover:text-slate-200">
          Inspections
        </Link>
        <span className="text-slate-600">/</span>
        <span className="font-mono text-sm text-slate-400">{inspection.code}</span>
        <KindBadge kind={inspection.kind} />
        <StatusBadge status={inspection.status} />
      </div>
      <div>
        <h1 className="text-xl font-semibold text-slate-100">{inspection.siteName}</h1>
        <p className="text-sm text-slate-400">
          {KIND_LABEL[inspection.kind]} inspection · started {fmtDateTime(inspection.startedAt)}
          {inspection.completedAt ? ` · completed ${fmtDateTime(inspection.completedAt)}` : ""}
          {inspection.inspectors.length ? ` · ${inspection.inspectors.join(", ")}` : ""}
        </p>
        {inspection.location?.address && <p className="text-sm text-slate-500">{inspection.location.address}</p>}
      </div>
      {(inspection.job || inspection.preInspection) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-300">
          {inspection.job && (
            <span>
              Job{" "}
              {features.jobs ? (
                <Link to={`/jobs/${inspection.job.id}`} className="text-sky-300 hover:underline">
                  {inspection.job.code} {inspection.job.name}
                </Link>
              ) : (
                `${inspection.job.code} ${inspection.job.name}`
              )}
              {inspection.task && (
                <span className="text-slate-500">
                  {" "}
                  · task “{inspection.task.title}” {inspection.task.status}
                </span>
              )}
            </span>
          )}
          {inspection.preInspection && (
            <span>
              Compared with{" "}
              <Link to={`/inspections/${inspection.preInspection.id}`} className="text-sky-300 hover:underline">
                {inspection.preInspection.code}
              </Link>
            </span>
          )}
        </div>
      )}
      {inspection.notes && <p className="whitespace-pre-line text-sm text-slate-300">{inspection.notes}</p>}

      <div className="flex flex-wrap gap-2">
        {inspection.status === "draft" ? (
          <button disabled={busy} onClick={() => void act(() => inspectionsApi.complete(inspection.id))} className={BTN}>
            Complete inspection
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={() => {
              if (
                inspection.status === "signed" &&
                !window.confirm("Reopen this signed inspection? Any change made afterwards shows against its signatures.")
              ) {
                return;
              }
              void act(() => inspectionsApi.reopen(inspection.id));
            }}
            className={BTN_QUIET}
          >
            Reopen
          </button>
        )}
        {inspection.editable && (
          <button onClick={() => setEditing(!editing)} className={BTN_QUIET}>
            {editing ? "Close details" : "Edit details"}
          </button>
        )}
        <a href={inspectionsApi.reportUrl(inspection.id)} target="_blank" rel="noreferrer" className={BTN_QUIET}>
          Report PDF
        </a>
        {canDelete && (
          <button onClick={() => void remove()} className={BTN_DANGER}>
            Delete
          </button>
        )}
      </div>
      {message && <Notice tone="error">{message}</Notice>}
      {editing && inspection.editable && (
        <DetailsForm
          inspection={inspection}
          onSaved={(d) => {
            onChanged(d);
            setEditing(false);
          }}
        />
      )}
    </section>
  );
}

function DetailsForm({ inspection, onSaved }: { inspection: Detail; onSaved: (d: Detail) => void }) {
  const locations = useLocationOptions();
  const [locationId, setLocationId] = useState(inspection.locationId ?? "");
  const [siteName, setSiteName] = useState(inspection.siteName);
  const [inspectors, setInspectors] = useState(inspection.inspectors.join(", "));
  const [notes, setNotes] = useState(inspection.notes ?? "");
  const [preId, setPreId] = useState(inspection.preInspectionId ?? "");
  const [pres, setPres] = useState<InspectionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (inspection.kind !== "post") return;
    inspectionsApi
      .list({ kind: "pre" })
      .then(setPres)
      .catch(() => undefined);
  }, [inspection.kind]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const locationChanged = (locationId || null) !== inspection.locationId;
      onSaved(
        await inspectionsApi.update(inspection.id, {
          ...(locationChanged ? { locationId: locationId || null } : {}),
          // A new location renames the site unless a name was typed as well.
          ...(siteName.trim() !== inspection.siteName || !locationChanged ? { siteName: siteName.trim() || null } : {}),
          inspectors: inspectors
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          notes: notes.trim() || null,
          ...(inspection.kind === "post" ? { preInspectionId: preId || null } : {}),
        }),
      );
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 border-t border-slate-800 pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="d-site">
            Site
          </label>
          <select id="d-site" value={locationId} onChange={(e) => setLocationId(e.target.value)} className={`${SELECT} mt-1 w-full`}>
            <option value="">Not linked</option>
            {locations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="d-name">
            Name on the report
          </label>
          <input id="d-name" value={siteName} onChange={(e) => setSiteName(e.target.value)} maxLength={200} className={`${FIELD} mt-1`} />
        </div>
        <div>
          <label className={LABEL} htmlFor="d-who">
            Inspectors
          </label>
          <input id="d-who" value={inspectors} onChange={(e) => setInspectors(e.target.value)} className={`${FIELD} mt-1`} />
        </div>
        <div>
          <label className={LABEL} htmlFor="d-notes">
            Notes
          </label>
          <input id="d-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} className={`${FIELD} mt-1`} />
        </div>
        {inspection.kind === "post" && (
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="d-pre">
              Compare with
            </label>
            <select id="d-pre" value={preId} onChange={(e) => setPreId(e.target.value)} className={`${SELECT} mt-1 w-full`}>
              <option value="">Nothing</option>
              {pres.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.siteName} · {fmtDateTime(p.completedAt ?? p.startedAt)} ({p.status})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy} className={BTN}>
        {busy ? "Saving…" : "Save details"}
      </button>
    </form>
  );
}

type Editing = { finding?: Finding; photo?: File | null; useAi?: boolean };

function Findings({ inspection, meta, onChanged }: { inspection: Detail; meta: InspectionsMeta; onChanged: () => void }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [defaults, setDefaults] = useState<FindingDefaults>({});
  const [error, setError] = useState<string | null>(null);

  // Findings by room, inside first, rooms in the order they were visited.
  const rooms = useMemo(() => {
    const groups = new Map<string, { area: string; room: string; findings: Finding[] }>();
    for (const f of inspection.findings) {
      const key = `${f.area}:${f.locationId ?? f.room.trim().toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { area: f.area, room: f.room, findings: [] });
      groups.get(key)!.findings.push(f);
    }
    return [...groups.values()].sort((a, b) => (a.area === b.area ? 0 : a.area === "inside" ? -1 : 1));
  }, [inspection.findings]);

  const remove = async (f: Finding) => {
    if (!window.confirm(`Remove finding #${f.number}? Its photos go with it.`)) return;
    setError(null);
    try {
      await inspectionsApi.removeFinding(inspection.id, f.id);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={H2}>
          Findings <span className="text-slate-500">({inspection.findings.length})</span>
        </h2>
        {inspection.editable && (
          <div className="flex flex-wrap gap-2">
            {meta.ai.vision && (
              <label className={`${BTN} inline-flex cursor-pointer items-center gap-1.5`}>
                <CameraIcon className="h-4 w-4" />
                Add damage by AI
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) setEditing({ photo: file, useAi: true });
                  }}
                />
              </label>
            )}
            <button onClick={() => setEditing({})} className={meta.ai.vision ? BTN_QUIET : BTN}>
              Enter manually
            </button>
          </div>
        )}
      </div>
      {!inspection.editable && inspection.status !== "draft" && (
        <Notice>Findings are locked while the inspection is {inspection.status}. Reopen it to change them.</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {inspection.findings.length === 0 && (
        <p className="text-sm text-slate-500">
          No damage recorded. Walk the site room by room; for each mark, dent or crack take one photo with Add damage by AI,
          or Enter manually. An inspection with no findings is a valid result.
        </p>
      )}
      {rooms.map((r) => (
        <div key={`${r.area}:${r.room}`} className="space-y-2">
          <h3 className="rounded-lg bg-slate-800/60 px-3 py-1.5 text-sm font-medium text-slate-200">
            {r.area === "outside" ? "Outside" : "Inside"} · {r.room}
            <span className="ml-2 text-xs text-slate-500">{r.findings.length}</span>
          </h3>
          {r.findings.map((f) => (
            <div key={f.id} className={`${CARD} space-y-2`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-100">
                  #{f.number} {spotLabel(meta, f.spot)}
                  {f.spotDetail ? `, ${f.spotDetail}` : ""}
                </span>
                <SeverityBadge severity={f.severity} />
                {f.preExisting && inspection.kind !== "pre" && <span className="text-xs text-amber-300">already there</span>}
                {f.aiGenerated && <span className="text-xs text-slate-500">drafted by AI</span>}
              </div>
              <p className="text-sm text-slate-300">{f.description}</p>
              {f.photos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {f.photos.map((p) => (
                    <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                      <img src={p.thumbUrl ?? p.url} alt="" className="h-24 w-24 rounded-lg border border-slate-800 object-cover" />
                    </a>
                  ))}
                </div>
              )}
              {inspection.editable && (
                <div className="flex gap-2">
                  <button onClick={() => setEditing({ finding: f })} className={BTN_QUIET}>
                    Edit
                  </button>
                  <button onClick={() => void remove(f)} className={BTN_DANGER}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
      {editing && (
        <FindingEditor
          inspection={inspection}
          meta={meta}
          finding={editing.finding}
          photo={editing.photo}
          useAi={editing.useAi}
          defaults={defaults}
          onClose={() => setEditing(null)}
          onSaved={(f) => {
            // The next finding is usually in the same room.
            setDefaults({ area: f.area, room: f.room, locationId: f.locationId });
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
