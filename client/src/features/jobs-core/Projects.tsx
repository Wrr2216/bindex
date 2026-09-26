import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { useFeatures, useTerms } from "../../config/useConfig";
import type { Company, Entity } from "../../types";
import { jobsApi, type ProjectInput } from "./api";
import type { JobSummary, Phase, Project, ProjectDetail as Detail, ProjectStatus } from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  Notice,
  ProgressBar,
  SELECT,
  StatusBadge,
  TypeChip,
  errorText,
  fmtDate,
  statusText,
  useJobsMeta,
} from "./ui";

/**
 * Projects: a client engagement run as several jobs, often phase by phase.
 * The list shows how far each has got; the detail page holds its phases and
 * jobs.
 */

function useClients() {
  const features = useFeatures();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  useEffect(() => {
    if (features.groups) api.listCompanies().then(setCompanies).catch(() => undefined);
    if (features.holders) api.listEntities().then(setEntities).catch(() => undefined);
  }, [features.groups, features.holders]);
  return { companies, entities, features };
}

function ProjectForm({ project, onSaved }: { project?: Project; onSaved: (p: Project) => void }) {
  const terms = useTerms();
  const meta = useJobsMeta();
  const { companies, entities, features } = useClients();
  const [name, setName] = useState(project?.name ?? "");
  const [companyId, setCompanyId] = useState(project?.companyId ?? "");
  const [entityId, setEntityId] = useState(project?.entityId ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "planned");
  const [startsOn, setStartsOn] = useState(project?.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(project?.endsOn ?? "");
  const [notes, setNotes] = useState(project?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input: ProjectInput = {
      name: name.trim(),
      companyId: companyId || null,
      entityId: entityId || null,
      status,
      startsOn: startsOn || null,
      endsOn: endsOn || null,
      notes: notes.trim() || null,
    };
    try {
      onSaved(project ? await jobsApi.updateProject(project.id, input) : await jobsApi.createProject(input));
    } catch (err) {
      setError(errorText(err, "The project could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className={`${CARD} grid gap-3 sm:grid-cols-2`}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Project name, such as HQ consolidation"
        aria-label="Project name"
        required
        className={`${FIELD} sm:col-span-2`}
      />
      {features.groups && (
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label={`Client ${terms.group.singular}`} className={SELECT}>
          <option value="">Client {terms.group.singular.toLowerCase()}: none</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      {features.holders && (
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} aria-label={`Client contact`} className={SELECT}>
          <option value="">Client contact: none</option>
          {entities.map((en) => (
            <option key={en.id} value={en.id}>
              {en.name}
            </option>
          ))}
        </select>
      )}
      <label className="text-xs text-slate-400">
        Starts
        <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={`${FIELD} mt-1`} />
      </label>
      <label className="text-xs text-slate-400">
        Ends
        <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} className={`${FIELD} mt-1`} />
      </label>
      {project && (
        <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)} aria-label="Project status" className={SELECT}>
          {(meta?.projectStatuses ?? [status]).map((s) => (
            <option key={s} value={s}>
              {statusText(s)}
            </option>
          ))}
        </select>
      )}
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes"
        aria-label="Notes"
        rows={2}
        className={`${FIELD} sm:col-span-2`}
      />
      <div className="flex items-center gap-3 sm:col-span-2">
        <button className={BTN} disabled={busy || !name.trim()}>
          {project ? "Save" : "Create project"}
        </button>
        {error && <span className="text-sm text-red-300">{error}</span>}
      </div>
    </form>
  );
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    jobsApi
      .listProjects()
      .then(setProjects)
      .catch((err) => setError(errorText(err, "Projects could not be loaded.")));
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-100">Projects</h1>
        <div className="flex gap-2">
          <Link to="/jobs" className={BTN_QUIET}>
            Jobs
          </Link>
          <button onClick={() => setCreating((c) => !c)} className={BTN}>
            {creating ? "Cancel" : "New project"}
          </button>
        </div>
      </div>
      {creating && <ProjectForm onSaved={(p) => navigate(`/projects/${p.id}`)} />}
      {error && <Notice tone="error">{error}</Notice>}
      {projects && projects.length === 0 && (
        <p className="text-sm text-slate-500">
          No projects yet. A project groups the jobs of one engagement, such as a move staged floor by floor over several weekends.
        </p>
      )}
      <ul className="space-y-2">
        {projects?.map((p) => (
          <li key={p.id}>
            <Link to={`/projects/${p.id}`} className={`${CARD} block space-y-2 hover:border-slate-700`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-slate-400">{p.code}</span>
                <span className="font-medium text-slate-100">{p.name}</span>
                <StatusBadge status={p.status} />
              </div>
              <div className="flex flex-wrap gap-x-3 text-xs text-slate-400">
                {(p.companyName || p.entityName) && <span>{[p.companyName, p.entityName].filter(Boolean).join(" · ")}</span>}
                {(p.startsOn || p.endsOn) && (
                  <span>
                    {fmtDate(p.startsOn)} to {fmtDate(p.endsOn)}
                  </span>
                )}
                <span>
                  {p.jobCount ?? 0} job{p.jobCount === 1 ? "" : "s"} · {p.phaseCount ?? 0} phase{p.phaseCount === 1 ? "" : "s"}
                </span>
              </div>
              <ProgressBar progress={p.progress} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProjectDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Detail | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProject(await jobsApi.getProject(id));
      setError(null);
    } catch (err) {
      setError(errorText(err, "This project could not be loaded."));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !project) return <Notice tone="error">{error}</Notice>;
  if (!project) return <p className="text-slate-400">Loading…</p>;

  const remove = async () => {
    if (!window.confirm(`Delete ${project.code}?`)) return;
    try {
      await jobsApi.deleteProject(project.id);
      navigate("/projects");
    } catch (err) {
      setError(errorText(err));
    }
  };

  const byPhase = new Map<string | null, JobSummary[]>();
  for (const j of project.jobs) byPhase.set(j.phaseId, [...(byPhase.get(j.phaseId) ?? []), j]);

  return (
    <div className="space-y-5">
      <Link to="/projects" className="text-sm text-sky-400 hover:underline">
        Projects
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{project.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <span className="font-mono">{project.code}</span>
            <StatusBadge status={project.status} />
            {[project.companyName, project.entityName].filter(Boolean).join(" · ")}
            {(project.startsOn || project.endsOn) && (
              <span>
                {fmtDate(project.startsOn)} to {fmtDate(project.endsOn)}
              </span>
            )}
          </div>
          {project.notes && <p className="mt-1 whitespace-pre-line text-sm text-slate-300">{project.notes}</p>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditing((e) => !e)} className={BTN_QUIET}>
            {editing ? "Close" : "Edit"}
          </button>
          <button onClick={() => void remove()} className={BTN_DANGER}>
            Delete
          </button>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {editing && (
        <ProjectForm
          project={project}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}

      <section className={`${CARD} space-y-2`} aria-label="Progress">
        <h2 className={H2}>Progress across every job</h2>
        <ProgressBar progress={project.progress} />
      </section>

      <Phases project={project} onChanged={load} />

      <section className={`${CARD} space-y-3`} aria-label="Jobs">
        <div className="flex items-center justify-between">
          <h2 className={H2}>Jobs</h2>
          <Link to={`/jobs?new=1&projectId=${project.id}`} className={BTN_QUIET}>
            New job
          </Link>
        </div>
        {project.jobs.length === 0 && <p className="text-sm text-slate-500">No jobs in this project yet.</p>}
        {[...project.phases.map((p) => ({ id: p.id as string | null, name: p.name })), { id: null, name: "No phase" }]
          .filter((p) => byPhase.has(p.id))
          .map((phase) => (
            <div key={phase.id ?? "none"} className="space-y-1">
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">{phase.name}</h3>
              <ul className="space-y-1">
                {byPhase.get(phase.id)!.map((j) => (
                  <li key={j.id}>
                    <Link
                      to={`/jobs/${j.id}`}
                      className="grid gap-2 rounded-lg border border-slate-800 px-3 py-2 hover:border-slate-700 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-slate-400">{j.code}</span>
                        <span className="text-slate-100">{j.name}</span>
                        <TypeChip name={j.jobTypeName} color={j.jobTypeColor} />
                        <StatusBadge status={j.status} />
                      </span>
                      <ProgressBar progress={j.progress} />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </section>
    </div>
  );
}

function Phases({ project, onChanged }: { project: Detail; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    void run(async () => {
      await jobsApi.addPhase(project.id, { name: name.trim(), startsOn: startsOn || null, endsOn: endsOn || null });
      setName("");
      setStartsOn("");
      setEndsOn("");
    });
  };

  // Swap sequence numbers with the neighbour, so the order survives reloads.
  const move = (index: number, by: -1 | 1) => {
    const a = project.phases[index];
    const b = project.phases[index + by];
    if (!a || !b) return;
    void run(async () => {
      const [sa, sb] = a.sequence === b.sequence ? [index + 1 + by, index + 1] : [b.sequence, a.sequence];
      await jobsApi.updatePhase(project.id, a.id, { sequence: sa });
      await jobsApi.updatePhase(project.id, b.id, { sequence: sb });
    });
  };

  return (
    <section className={`${CARD} space-y-3`} aria-label="Phases">
      <h2 className={H2}>Phases</h2>
      {project.phases.length === 0 && <p className="text-sm text-slate-500">No phases. Add one per stage of the move.</p>}
      <ol className="space-y-1">
        {project.phases.map((p, i) => (
          <PhaseRow
            key={p.id}
            phase={p}
            first={i === 0}
            last={i === project.phases.length - 1}
            onMove={(by) => move(i, by)}
            onSave={(patch) => run(() => jobsApi.updatePhase(project.id, p.id, patch))}
            onDelete={() =>
              window.confirm(`Delete the phase "${p.name}"? Its jobs stay on the project.`) &&
              void run(() => jobsApi.deletePhase(project.id, p.id))
            }
          />
        ))}
      </ol>
      <form onSubmit={add} className="grid gap-2 sm:grid-cols-4">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Phase name, such as Floor 3" aria-label="Phase name" className={FIELD} />
        <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} aria-label="Phase starts" className={FIELD} />
        <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} aria-label="Phase ends" className={FIELD} />
        <button className={BTN_QUIET} disabled={!name.trim()}>
          Add phase
        </button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function PhaseRow({
  phase,
  first,
  last,
  onMove,
  onSave,
  onDelete,
}: {
  phase: Phase;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  onSave: (patch: { name?: string; startsOn?: string | null; endsOn?: string | null }) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(phase.name);
  const [startsOn, setStartsOn] = useState(phase.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(phase.endsOn ?? "");

  if (editing) {
    return (
      <li className="grid gap-2 sm:grid-cols-4">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Phase name" className={FIELD} />
        <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} aria-label="Phase starts" className={FIELD} />
        <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} aria-label="Phase ends" className={FIELD} />
        <div className="flex gap-2">
          <button
            onClick={() =>
              void onSave({ name: name.trim(), startsOn: startsOn || null, endsOn: endsOn || null }).then(() => setEditing(false))
            }
            className={BTN_QUIET}
          >
            Save
          </button>
          <button onClick={() => setEditing(false)} className="text-sm text-slate-400">
            Cancel
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-800/40">
      <span className="flex-1 text-sm text-slate-100">
        {phase.name}
        <span className="ml-2 text-xs text-slate-500">
          {phase.startsOn || phase.endsOn ? `${fmtDate(phase.startsOn)} to ${fmtDate(phase.endsOn)} · ` : ""}
          {phase.jobCount} job{phase.jobCount === 1 ? "" : "s"}
        </span>
      </span>
      <button onClick={() => onMove(-1)} disabled={first} className="text-xs text-slate-400 disabled:opacity-30" aria-label={`Move ${phase.name} up`}>
        ↑
      </button>
      <button onClick={() => onMove(1)} disabled={last} className="text-xs text-slate-400 disabled:opacity-30" aria-label={`Move ${phase.name} down`}>
        ↓
      </button>
      <Link to={`/jobs?new=1&projectId=${phase.projectId}&phaseId=${phase.id}`} className="text-xs text-sky-400 hover:underline">
        New job
      </Link>
      <button onClick={() => setEditing(true)} className="text-xs text-slate-400 hover:text-slate-200">
        Edit
      </button>
      <button onClick={onDelete} className="text-xs text-slate-500 hover:text-red-400" aria-label={`Delete ${phase.name}`}>
        ×
      </button>
    </li>
  );
}
