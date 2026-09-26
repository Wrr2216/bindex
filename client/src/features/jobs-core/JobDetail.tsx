import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { useFeatures, useTerms } from "../../config/useConfig";
import type { Entity } from "../../types";
import { jobsApi } from "./api";
import { Manifest } from "./Manifest";
import { ScanToStage } from "./ScanToStage";
import type { GroupBy, HistoryEntry, JobDetail as Job, JobType, JobsMeta, LabelledGroup, ProjectDetail } from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  LocationSelect,
  Notice,
  ProgressBar,
  SELECT,
  StageBadge,
  StatusBadge,
  StepBars,
  TypeChip,
  errorText,
  fmtDateTime,
  fromLocalInput,
  openDocument,
  statusText,
  toLocalInput,
  useCaptureOwner,
  useJobsMeta,
  useLocations,
} from "./ui";

/**
 * One job: its header and status, progress by floor, department and
 * shipment, the task list, shipments, the scan-to-stage panel, the manifest,
 * printable documents and recent activity.
 */
export function JobDetail() {
  const { id = "" } = useParams();
  const meta = useJobsMeta();
  const { options: locationOptions } = useLocations();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { owner, claim } = useCaptureOwner<"stage" | "add">();

  const load = useCallback(async () => {
    try {
      setJob(await jobsApi.getJob(id));
      setError(null);
    } catch (err) {
      setError(errorText(err, "This job could not be loaded."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // A scan or a manifest change moves progress, tasks and shipment counts.
  const changed = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void load();
  }, [load]);

  if (error && !job) return <Notice tone="error">{error}</Notice>;
  if (!job) return <p className="text-slate-400">Loading…</p>;

  const editable = job.status === "planned" || job.status === "in_progress";

  return (
    <div className="space-y-5">
      <JobHeader job={job} meta={meta} locationOptions={locationOptions} onSaved={load} />
      <ProgressPanel job={job} />
      <TasksPanel job={job} meta={meta} onChanged={load} />
      <ShipmentsPanel job={job} locationOptions={locationOptions} editable={editable} onChanged={load} />
      {editable ? (
        <ScanToStage
          jobId={job.id}
          meta={meta}
          shipments={job.shipments}
          active={owner === "stage"}
          onActiveChange={(on) => claim("stage", on)}
          onChanged={changed}
        />
      ) : (
        <Notice>
          This job is {statusText(job.status)}. Set it back to in progress to scan or change its manifest.
        </Notice>
      )}
      <Manifest
        jobId={job.id}
        meta={meta}
        shipments={job.shipments}
        locationOptions={locationOptions}
        editable={editable}
        refreshKey={refreshKey}
        captureActive={owner === "add"}
        onCaptureChange={(on) => claim("add", on)}
        onChanged={changed}
      />
      <DocumentsPanel job={job} />
      <HistoryPanel jobId={job.id} meta={meta} refreshKey={refreshKey} />
    </div>
  );
}

function JobHeader({
  job,
  meta,
  locationOptions,
  onSaved,
}: {
  job: Job;
  meta: JobsMeta | null;
  locationOptions: { id: string; label: string }[];
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const setStatus = async (status: string) => {
    setMessage(null);
    try {
      await jobsApi.updateJob(job.id, { status: status as Job["status"] });
      onSaved();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${job.code}? Its manifest, shipments, tasks and stage history go with it.`)) return;
    try {
      await jobsApi.deleteJob(job.id);
      navigate(job.projectId ? `/projects/${job.projectId}` : "/jobs");
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link to="/jobs" className="text-sky-400 hover:underline">
          Jobs
        </Link>
        {job.projectId && (
          <>
            <span className="text-slate-600">/</span>
            <Link to={`/projects/${job.projectId}`} className="text-sky-400 hover:underline">
              {job.projectCode} {job.projectName}
            </Link>
            {job.phaseName && <span className="text-slate-400">· {job.phaseName}</span>}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{job.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-slate-400">{job.code}</span>
            <TypeChip name={job.jobTypeName} color={job.jobTypeColor} />
            <StatusBadge status={job.status} />
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {job.originName ?? "Origin not set"} → {job.destinationName ?? "destination not set"}
            {job.scheduledStart && ` · ${fmtDateTime(job.scheduledStart)}`}
            {job.scheduledEnd && ` to ${fmtDateTime(job.scheduledEnd)}`}
          </p>
          {job.notes && <p className="mt-1 whitespace-pre-line text-sm text-slate-300">{job.notes}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={job.status}
            onChange={(e) => void setStatus(e.target.value)}
            aria-label="Job status"
            className={SELECT}
          >
            {(meta?.jobStatuses ?? [job.status]).map((s) => (
              <option key={s} value={s}>
                {statusText(s)}
              </option>
            ))}
          </select>
          <button onClick={() => setEditing((e) => !e)} className={BTN_QUIET}>
            {editing ? "Close" : "Edit"}
          </button>
          <button onClick={() => void remove()} className={BTN_DANGER}>
            Delete
          </button>
        </div>
      </div>
      {message && <Notice tone="error">{message}</Notice>}
      {editing && (
        <JobForm
          job={job}
          locationOptions={locationOptions}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      )}
    </header>
  );
}

/** Editing a job's details. Also used, without a job, to create one. */
export function JobForm({
  job,
  initial,
  locationOptions,
  onSaved,
}: {
  job?: Job;
  initial?: { projectId?: string; phaseId?: string };
  locationOptions: { id: string; label: string }[];
  onSaved: (id: string) => void;
}) {
  const [types, setTypes] = useState<JobType[]>([]);
  const [projects, setProjects] = useState<{ id: string; code: string; name: string }[]>([]);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [name, setName] = useState(job?.name ?? "");
  const [jobTypeId, setJobTypeId] = useState(job?.jobTypeId ?? "");
  const [projectId, setProjectId] = useState(job?.projectId ?? initial?.projectId ?? "");
  const [phaseId, setPhaseId] = useState(job?.phaseId ?? initial?.phaseId ?? "");
  const [originId, setOriginId] = useState(job?.originLocationId ?? "");
  const [destinationId, setDestinationId] = useState(job?.destinationLocationId ?? "");
  const [start, setStart] = useState(toLocalInput(job?.scheduledStart));
  const [end, setEnd] = useState(toLocalInput(job?.scheduledEnd));
  const [notes, setNotes] = useState(job?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    jobsApi.listJobTypes().then(setTypes).catch(() => undefined);
    jobsApi.listProjects().then(setProjects).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!projectId) {
      setProject(null);
      return;
    }
    jobsApi.getProject(projectId).then(setProject).catch(() => setProject(null));
  }, [projectId]);

  const selectedType = types.find((t) => t.id === jobTypeId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input = {
      name: name.trim(),
      jobTypeId: jobTypeId || null,
      projectId: projectId || null,
      phaseId: phaseId || null,
      originLocationId: originId || null,
      destinationLocationId: destinationId || null,
      scheduledStart: fromLocalInput(start),
      scheduledEnd: fromLocalInput(end),
      notes: notes.trim() || null,
    };
    try {
      const saved = job ? await jobsApi.updateJob(job.id, input) : await jobsApi.createJob(input);
      onSaved(saved.id);
    } catch (err) {
      setError(errorText(err, "The job could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className={`${CARD} grid gap-3 sm:grid-cols-2`}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Job name, such as Floor 3 to Level 5"
        aria-label="Job name"
        required
        className={`${FIELD} sm:col-span-2`}
      />
      <select value={jobTypeId} onChange={(e) => setJobTypeId(e.target.value)} aria-label="Job type" className={SELECT}>
        <option value="">No job type</option>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <div className="text-xs text-slate-400 self-center">
        {!job && selectedType
          ? selectedType.taskTemplate.length
            ? `Starts with ${selectedType.taskTemplate.length} tasks: ${selectedType.taskTemplate.map((s) => s.title).join(", ")}.`
            : "This type has no task list."
          : ""}
      </div>
      <select
        value={projectId}
        onChange={(e) => {
          setProjectId(e.target.value);
          setPhaseId("");
        }}
        aria-label="Project"
        className={SELECT}
      >
        <option value="">No project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.code} · {p.name}
          </option>
        ))}
      </select>
      <select
        value={phaseId}
        onChange={(e) => setPhaseId(e.target.value)}
        aria-label="Phase"
        disabled={!project || project.phases.length === 0}
        className={`${SELECT} disabled:opacity-50`}
      >
        <option value="">No phase</option>
        {project?.phases.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <LocationSelect value={originId} onChange={setOriginId} options={locationOptions} placeholder="Origin: not set" label="Origin" />
      <LocationSelect
        value={destinationId}
        onChange={setDestinationId}
        options={locationOptions}
        placeholder="Destination: not set"
        label="Destination"
      />
      <label className="text-xs text-slate-400">
        Starts
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={`${FIELD} mt-1`} />
      </label>
      <label className="text-xs text-slate-400">
        Ends
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={`${FIELD} mt-1`} />
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes: access, lifts, parking, contacts"
        aria-label="Notes"
        rows={2}
        className={`${FIELD} sm:col-span-2`}
      />
      <div className="flex items-center gap-3 sm:col-span-2">
        <button className={BTN} disabled={busy || !name.trim()}>
          {job ? "Save" : "Create job"}
        </button>
        {error && <span className="text-sm text-red-300">{error}</span>}
      </div>
    </form>
  );
}

function Breakdown({ title, groups }: { title: string; groups: LabelledGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h3>
      <ul className="space-y-1">
        {groups.map((g) => (
          <li key={g.key ?? "none"} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)] items-center gap-2 text-sm">
            <span className="truncate text-slate-300" title={g.label}>
              {g.code ? `${g.code} · ` : ""}
              {g.label}
            </span>
            <span className="text-xs tabular-nums text-slate-500">{g.progress.total}</span>
            <ProgressBar progress={g.progress} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProgressPanel({ job }: { job: Job }) {
  const p = job.progress.overall;
  return (
    <section className={`${CARD} space-y-4`} aria-label="Progress">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={H2}>Progress</h2>
        <span className="text-sm text-slate-400">
          {p.total} line{p.total === 1 ? "" : "s"}
          {p.exceptions > 0 && <span className="ml-2 text-amber-300">{p.exceptions} need attention</span>}
          {p.complete && <span className="ml-2 text-emerald-300">Everything placed</span>}
        </span>
      </div>
      <ProgressBar progress={p} />
      <StepBars progress={p} />
      <div className="grid gap-4 md:grid-cols-3">
        <Breakdown title="By floor" groups={job.progress.byFloor} />
        <Breakdown title="By department" groups={job.progress.byDepartment} />
        <Breakdown title="By shipment" groups={job.progress.byShipment} />
      </div>
    </section>
  );
}

function TasksPanel({ job, meta, onChanged }: { job: Job; meta: JobsMeta | null; onChanged: () => void }) {
  const features = useFeatures();
  const terms = useTerms();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("custom");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (features.holders) api.listEntities().then(setEntities).catch(() => undefined);
  }, [features.holders]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    void run(async () => {
      await jobsApi.addTask(job.id, { title: title.trim(), kind });
      setTitle("");
    });
  };

  const kindLabel = (k: string) => meta?.taskKinds.find((t) => t.kind === k)?.label ?? statusText(k);

  return (
    <section className={`${CARD} space-y-3`} aria-label="Tasks">
      <h2 className={H2}>Tasks</h2>
      {job.tasks.length === 0 && <p className="text-sm text-slate-500">No tasks yet.</p>}
      <ul className="space-y-1">
        {job.tasks.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-800/40">
            <input
              type="checkbox"
              checked={t.status === "done"}
              onChange={(e) => void run(() => jobsApi.updateTask(job.id, t.id, { status: e.target.checked ? "done" : "todo" }))}
              aria-label={`${t.title} done`}
            />
            <span className={`flex-1 text-sm ${t.status === "done" || t.status === "skipped" ? "text-slate-500 line-through" : "text-slate-100"}`}>
              {t.title}
              <span className="ml-2 text-xs text-slate-500 no-underline">{kindLabel(t.kind)}</span>
            </span>
            {t.completedAt && (
              <span className="text-xs text-slate-500">
                {t.completedBy ? `${t.completedBy}, ` : ""}
                {fmtDateTime(t.completedAt)}
              </span>
            )}
            {features.holders && (
              <select
                value={t.assigneeEntityId ?? ""}
                onChange={(e) => void run(() => jobsApi.updateTask(job.id, t.id, { assigneeEntityId: e.target.value || null }))}
                aria-label={`${terms.holder.singular} for ${t.title}`}
                className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
              >
                <option value="">No {terms.holder.singular.toLowerCase()}</option>
                {entities.map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.name}
                  </option>
                ))}
              </select>
            )}
            <select
              value={t.status}
              onChange={(e) => void run(() => jobsApi.updateTask(job.id, t.id, { status: e.target.value as typeof t.status }))}
              aria-label={`Status of ${t.title}`}
              className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
            >
              {(meta?.taskStatuses ?? ["todo", "doing", "done", "skipped"]).map((s) => (
                <option key={s} value={s}>
                  {statusText(s)}
                </option>
              ))}
            </select>
            <button
              onClick={() => window.confirm(`Delete the task "${t.title}"?`) && void run(() => jobsApi.deleteTask(job.id, t.id))}
              className="text-xs text-slate-500 hover:text-red-400"
              aria-label={`Delete ${t.title}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex flex-wrap gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Task kind" className={SELECT}>
          {meta?.taskKinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="Task title" className={`${FIELD} flex-1`} />
        <button className={BTN_QUIET} disabled={!title.trim()}>
          Add
        </button>
      </form>
      <p className="text-xs text-slate-500">Pack, load, unload and place tasks tick themselves off as scans reach those stages.</p>
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function ShipmentsPanel({
  job,
  locationOptions,
  editable,
  onChanged,
}: {
  job: Job;
  locationOptions: { id: string; label: string }[];
  editable: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [carrier, setCarrier] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await jobsApi.createShipment(job.id, { name: name.trim(), vehicleLocationId: vehicle || null, carrier: carrier.trim() || null });
      setName("");
      setVehicle("");
      setCarrier("");
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className={`${CARD} space-y-3`} aria-label="Shipments">
      <h2 className={H2}>Shipments</h2>
      {job.shipments.length === 0 && <p className="text-sm text-slate-500">No shipments yet. Add one per truck or trailer run.</p>}
      <ul className="space-y-2">
        {job.shipments.map((s) => (
          <li key={s.id} className="grid gap-2 rounded-lg border border-slate-800 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/shipments/${s.id}`} className="font-medium text-sky-300 hover:underline">
                {s.code} · {s.name}
              </Link>
              <StatusBadge status={s.status} />
              {s.vehicleName && <span className="text-xs text-slate-400">{s.vehicleName}</span>}
              {s.sealNumbers.length > 0 && <span className="text-xs text-slate-500">Seals {s.sealNumbers.join(", ")}</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs tabular-nums text-slate-500">{s.progress.total} lines</span>
              <ProgressBar progress={s.progress} className="flex-1" />
            </div>
          </li>
        ))}
      </ul>
      {editable && (
        <form onSubmit={(e) => void add(e)} className="grid gap-2 sm:grid-cols-4">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shipment name, such as Truck 1" aria-label="Shipment name" className={FIELD} />
          <LocationSelect value={vehicle} onChange={setVehicle} options={locationOptions} placeholder="Vehicle: none" label="Vehicle" />
          <input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Carrier" aria-label="Carrier" className={FIELD} />
          <button className={BTN_QUIET} disabled={!name.trim()}>
            Add shipment
          </button>
        </form>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function DocumentsPanel({ job }: { job: Job }) {
  const [groupBy, setGroupBy] = useState<GroupBy>("floor");
  const [floor, setFloor] = useState("");
  const [department, setDepartment] = useState("");
  const [shipmentId, setShipmentId] = useState("");
  const floors = job.progress.byFloor.flatMap((g) => (g.key ? [g.key] : []));
  const departments = job.progress.byDepartment.flatMap((g) => (g.key ? [g.key] : []));
  const opts = {
    groupBy,
    floor: floor || undefined,
    department: department || undefined,
    shipmentId: shipmentId || undefined,
  };
  return (
    <section className={`${CARD} space-y-3`} aria-label="Manifests">
      <h2 className={H2}>Manifests</h2>
      <div className="flex flex-wrap gap-2">
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} aria-label="Group by" className={SELECT}>
          <option value="floor">Floor by floor</option>
          <option value="department">Department by department</option>
          <option value="origin">By the room each came from</option>
          <option value="shipment">By shipment</option>
          <option value="none">One list</option>
        </select>
        <select value={floor} onChange={(e) => setFloor(e.target.value)} aria-label="Only floor" className={SELECT}>
          <option value="">Every floor</option>
          {floors.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Only department" className={SELECT}>
          <option value="">Every department</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select value={shipmentId} onChange={(e) => setShipmentId(e.target.value)} aria-label="Only shipment" className={SELECT}>
          <option value="">Every shipment</option>
          <option value="none">Not on a shipment</option>
          {job.shipments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => openDocument(jobsApi.manifestPdfUrl(job.id, opts))} className={BTN}>
          Print manifest (PDF)
        </button>
        <a href={jobsApi.manifestXlsxUrl(job.id, opts)} className={BTN_QUIET}>
          Download spreadsheet
        </a>
        {job.shipments.map((s) => (
          <button key={s.id} onClick={() => openDocument(jobsApi.loadSheetUrl(s.id))} className={BTN_QUIET}>
            Load sheet {s.code}
          </button>
        ))}
      </div>
    </section>
  );
}

function HistoryPanel({ jobId, meta, refreshKey }: { jobId: string; meta: JobsMeta | null; refreshKey: number }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    jobsApi.history(jobId, 25).then(setEntries).catch(() => undefined);
  }, [jobId, refreshKey]);
  if (entries.length === 0) return null;
  return (
    <section className={`${CARD} space-y-2`} aria-label="Recent activity">
      <h2 className={H2}>Recent activity</h2>
      <ul className="space-y-1 text-sm">
        {entries.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2">
            <span className="text-slate-200">{e.itemName}</span>
            {e.fromStage && <StageBadge stage={e.fromStage} meta={meta} />}
            <span className="text-slate-500">→</span>
            <StageBadge stage={e.toStage} meta={meta} />
            <span className="text-xs text-slate-500">
              {e.via}
              {e.deviceId ? ` (${e.deviceId})` : ""}
              {e.shipmentCode ? ` · ${e.shipmentCode}` : ""}
              {e.actor ? ` · ${e.actor}` : ""} · {fmtDateTime(e.createdAt)}
            </span>
            {e.note && <span className="text-xs text-slate-400">“{e.note}”</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
