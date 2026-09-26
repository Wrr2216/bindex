import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { useFeatures, useTerms } from "../../config/useConfig";
import { inspectionsApi, type JobOption } from "./api";
import type { InspectionKind, InspectionStatus, InspectionSummary } from "./types";
import {
  BTN,
  BTN_QUIET,
  CARD,
  FIELD,
  KIND_LABEL,
  KindBadge,
  LABEL,
  Notice,
  SELECT,
  StatusBadge,
  errorText,
  fmtDateTime,
  useLocationOptions,
} from "./ui";

/** Every inspection, newest first, with the form to start one. */
export function InspectionsPage() {
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<InspectionSummary[] | null>(null);
  const [kind, setKind] = useState<InspectionKind | "">("");
  const [status, setStatus] = useState<InspectionStatus | "">("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const creating = params.get("new") === "1";
  const jobFilter = params.get("jobId") ?? undefined;

  useEffect(() => {
    const t = setTimeout(() => {
      inspectionsApi
        .list({ kind: kind || undefined, status: status || undefined, q: q.trim() || undefined, jobId: jobFilter })
        .then((rows) => {
          setList(rows);
          setError(null);
        })
        .catch((err) => setError(errorText(err, "Inspections could not be loaded.")));
    }, 200);
    return () => clearTimeout(t);
  }, [kind, status, q, jobFilter]);

  const setCreating = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set("new", "1");
    else next.delete("new");
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-100">Site inspections</h1>
        <button onClick={() => setCreating(!creating)} className={BTN}>
          {creating ? "Cancel" : "New inspection"}
        </button>
      </div>

      {creating && (
        <NewInspectionForm
          initialKind={(params.get("kind") as InspectionKind | null) ?? "pre"}
          initialJobId={params.get("jobId") ?? ""}
          existing={list ?? []}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by site, code or job"
          aria-label="Search inspections"
          className={`${FIELD} sm:w-64`}
        />
        <select value={kind} onChange={(e) => setKind(e.target.value as InspectionKind | "")} aria-label="Kind" className={SELECT}>
          <option value="">Any kind</option>
          {(Object.keys(KIND_LABEL) as InspectionKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as InspectionStatus | "")} aria-label="Status" className={SELECT}>
          <option value="">Any status</option>
          <option value="draft">Draft</option>
          <option value="completed">Completed</option>
          <option value="signed">Signed</option>
        </select>
        {jobFilter && (
          <button
            className={BTN_QUIET}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete("jobId");
              setParams(next, { replace: true });
            }}
          >
            Showing one job · show all
          </button>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {list && list.length === 0 && (
        <p className="text-sm text-slate-500">
          No inspections yet. Survey a site before the move starts, again when it is done, and compare the two: start with
          New inspection.
        </p>
      )}
      <ul className="space-y-2">
        {list?.map((i) => (
          <li key={i.id}>
            <Link to={`/inspections/${i.id}`} className={`${CARD} block space-y-1 hover:border-slate-700`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-slate-400">{i.code}</span>
                <span className="font-medium text-slate-100">{i.siteName}</span>
                <KindBadge kind={i.kind} />
                <StatusBadge status={i.status} />
              </div>
              <div className="flex flex-wrap gap-x-3 text-xs text-slate-400">
                {i.jobCode && (
                  <span>
                    {i.jobCode} {i.jobName}
                  </span>
                )}
                {i.preCode && <span>compared with {i.preCode}</span>}
                <span>
                  {i.findingCount} finding{i.findingCount === 1 ? "" : "s"}
                </span>
                <span>{fmtDateTime(i.completedAt ?? i.startedAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewInspectionForm({
  initialKind,
  initialJobId,
  existing,
}: {
  initialKind: InspectionKind;
  initialJobId: string;
  existing: InspectionSummary[];
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const features = useFeatures();
  const terms = useTerms();
  const locations = useLocationOptions();
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [kind, setKind] = useState<InspectionKind>(["pre", "post", "adhoc"].includes(initialKind) ? initialKind : "pre");
  const [jobId, setJobId] = useState(initialJobId);
  const [locationId, setLocationId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [preId, setPreId] = useState("");
  const [inspectors, setInspectors] = useState(user?.name ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pres, setPres] = useState<InspectionSummary[]>(existing.filter((i) => i.kind === "pre"));

  useEffect(() => {
    if (!features.jobs) return;
    inspectionsApi
      .jobs()
      .then((all) => setJobs(all.filter((j) => j.status === "planned" || j.status === "in_progress" || j.id === initialJobId)))
      .catch(() => undefined);
  }, [features.jobs, initialJobId]);

  useEffect(() => {
    if (kind !== "post") return;
    inspectionsApi
      .list({ kind: "pre" })
      .then(setPres)
      .catch(() => undefined);
  }, [kind]);

  const job = jobs.find((j) => j.id === jobId) ?? null;

  // A job suggests its own sites: origin before the move, destination after.
  useEffect(() => {
    if (!job || locationId || siteName) return;
    const suggested = kind === "post" ? job.destinationLocationId ?? job.originLocationId : job.originLocationId ?? job.destinationLocationId;
    if (suggested) setLocationId(suggested);
    // Only when the job changes; after that the person's choice stands.
  }, [jobId, jobs.length]);

  const preOptions = useMemo(() => {
    const sameSite = (p: InspectionSummary) => (locationId ? p.locationId === locationId : siteName ? p.siteName === siteName : true);
    return pres.filter((p) => sameSite(p) || (jobId && p.jobId === jobId));
  }, [pres, locationId, siteName, jobId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await inspectionsApi.create({
        kind,
        jobId: jobId || null,
        locationId: locationId || null,
        siteName: siteName.trim() || null,
        ...(kind === "post" && preId ? { preInspectionId: preId === "none" ? null : preId } : {}),
        inspectors: inspectors
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        notes: notes.trim() || null,
      });
      navigate(`/inspections/${created.id}`);
    } catch (err) {
      setError(errorText(err, "The inspection could not be started."));
      setBusy(false);
    }
  };

  const location = terms.location.singular.toLowerCase();

  return (
    <form onSubmit={submit} className={`${CARD} space-y-4`}>
      <div>
        <span className={LABEL}>Kind</span>
        <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Kind">
          {(
            [
              ["pre", "Pre-move", "Before the move starts"],
              ["post", "Post-move", "Once it is done, compared with the pre-move"],
              ["adhoc", "Site", "A survey on its own"],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => setKind(value)}
              className={`rounded-lg border px-3 py-2 text-left text-sm ${
                kind === value ? "border-sky-500 bg-sky-950/40 text-sky-200" : "border-slate-700 text-slate-300 hover:bg-slate-800"
              }`}
            >
              <span className="block font-medium">{label}</span>
              <span className="block text-xs text-slate-400">{hint}</span>
            </button>
          ))}
        </div>
      </div>

      {features.jobs && (
        <div>
          <label className={LABEL} htmlFor="insp-job">
            Job
          </label>
          <select id="insp-job" value={jobId} onChange={(e) => setJobId(e.target.value)} className={`${SELECT} mt-1 w-full`}>
            <option value="">No job</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.code} {j.name}
              </option>
            ))}
          </select>
          {job && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {job.originLocationId && (
                <button type="button" className={BTN_QUIET} onClick={() => (setLocationId(job.originLocationId!), setSiteName(""))}>
                  Origin: {job.originName}
                </button>
              )}
              {job.destinationLocationId && (
                <button
                  type="button"
                  className={BTN_QUIET}
                  onClick={() => (setLocationId(job.destinationLocationId!), setSiteName(""))}
                >
                  Destination: {job.destinationName}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="insp-site">
            Site
          </label>
          <select id="insp-site" value={locationId} onChange={(e) => setLocationId(e.target.value)} className={`${SELECT} mt-1 w-full`}>
            <option value="">Pick a {location}</option>
            {locations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="insp-site-name">
            {locationId ? "Name on the report (optional)" : `Or type the site's name`}
          </label>
          <input
            id="insp-site-name"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder={locationId ? "The full path is used" : "e.g. 200 Main St, Suite 400"}
            maxLength={200}
            className={`${FIELD} mt-1`}
          />
        </div>
      </div>

      {kind === "post" && (
        <div>
          <label className={LABEL} htmlFor="insp-pre">
            Compare with
          </label>
          <select id="insp-pre" value={preId} onChange={(e) => setPreId(e.target.value)} className={`${SELECT} mt-1 w-full`}>
            <option value="">The latest pre-move inspection of this site</option>
            {preOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.siteName} · {fmtDateTime(p.completedAt ?? p.startedAt)} ({p.status})
              </option>
            ))}
            <option value="none">Nothing for now</option>
          </select>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="insp-who">
            Inspectors
          </label>
          <input
            id="insp-who"
            value={inspectors}
            onChange={(e) => setInspectors(e.target.value)}
            placeholder="Names, separated by commas"
            className={`${FIELD} mt-1`}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="insp-notes">
            Notes
          </label>
          <input id="insp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} className={`${FIELD} mt-1`} />
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy || (!locationId && !siteName.trim() && !jobId)} className={BTN}>
        {busy ? "Starting…" : "Start inspection"}
      </button>
    </form>
  );
}
