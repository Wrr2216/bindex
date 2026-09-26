import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { Toggle } from "../../components/ui";
import { jobsApi } from "./api";
import type { JobType, JobsMeta, TemplateStep } from "./types";
import { BTN, BTN_DANGER, BTN_QUIET, CARD, FIELD, Notice, SELECT, errorText, useJobsMeta } from "./ui";

/**
 * Settings → Job types: the kinds of work this organisation does, each with
 * the task list a new job of that type starts with. Administrators only.
 */
export function JobTypesPage() {
  const { user } = useAuth();
  const meta = useJobsMeta();
  const [types, setTypes] = useState<JobType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    jobsApi
      .listJobTypes(true)
      .then(setTypes)
      .catch((err) => setError(errorText(err, "Job types could not be loaded.")));
  }, []);
  useEffect(load, [load]);

  const isAdmin = user?.role === "admin";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link to="/settings" className="text-sky-400 hover:underline">
          Settings
        </Link>
        <span className="text-slate-600">/</span>
        <Link to="/jobs" className="text-sky-400 hover:underline">
          Jobs
        </Link>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-100">Job types</h1>
        {isAdmin && (
          <button onClick={() => setAdding((a) => !a)} className={BTN}>
            {adding ? "Cancel" : "New job type"}
          </button>
        )}
      </div>
      <p className="text-sm text-slate-400">
        A job type names a kind of work (IT relocation, library move, decommission) and carries the task list each new job of
        that type starts with.
      </p>
      {!isAdmin && <Notice>Only an administrator can change job types.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {adding && isAdmin && (
        <TypeEditor
          meta={meta}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
      <ul className="space-y-3">
        {types?.map((t) => (
          <li key={t.id}>
            {isAdmin ? (
              <TypeEditor type={t} meta={meta} onSaved={load} />
            ) : (
              <div className={CARD}>
                <p className="font-medium text-slate-100">{t.name}</p>
                <p className="text-sm text-slate-400">{t.taskTemplate.map((s) => s.title).join(" → ")}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TypeEditor({ type, meta, onSaved }: { type?: JobType; meta: JobsMeta | null; onSaved: () => void }) {
  const [name, setName] = useState(type?.name ?? "");
  const [color, setColor] = useState(type?.color ?? "#0284c7");
  const [description, setDescription] = useState(type?.description ?? "");
  const [active, setActive] = useState(type?.active ?? true);
  const [steps, setSteps] = useState<TemplateStep[]>(type?.taskTemplate ?? [{ kind: "pack", title: "Pack" }]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const dirty =
    !type ||
    name !== type.name ||
    color !== type.color ||
    (description || null) !== type.description ||
    active !== type.active ||
    JSON.stringify(steps) !== JSON.stringify(type.taskTemplate);

  const setStep = (i: number, patch: Partial<TemplateStep>) =>
    setSteps((s) => s.map((step, j) => (j === i ? { ...step, ...patch } : step)));
  const moveStep = (i: number, by: -1 | 1) =>
    setSteps((s) => {
      const next = [...s];
      const [step] = next.splice(i, 1);
      next.splice(i + by, 0, step!);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const input = {
      name: name.trim(),
      color,
      description: description.trim() || null,
      active,
      taskTemplate: steps.filter((s) => s.title.trim()).map((s) => ({ kind: s.kind, title: s.title.trim() })),
    };
    try {
      if (type) await jobsApi.updateJobType(type.id, input);
      else await jobsApi.createJobType(input);
      setMessage({ tone: "ok", text: "Saved." });
      onSaved();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err, "Could not save.") });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!type || !window.confirm(`Delete the job type "${type.name}"? Jobs of this type keep their tasks.`)) return;
    try {
      await jobsApi.deleteJobType(type.id);
      onSaved();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  };

  return (
    <div className={`${CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          aria-label="Colour"
          className="h-9 w-10 cursor-pointer rounded border border-slate-700 bg-slate-800"
        />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, such as IT relocation" aria-label="Job type name" className={`${FIELD} flex-1`} />
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <Toggle checked={active} onChange={setActive} label="Offered for new jobs" />
          Offered for new jobs
        </label>
      </div>
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" aria-label="Description" className={FIELD} />
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Tasks a new job starts with</p>
        {steps.map((s, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="w-5 text-right text-xs text-slate-500">{i + 1}</span>
            <select value={s.kind} onChange={(e) => setStep(i, { kind: e.target.value })} aria-label={`Step ${i + 1} kind`} className={SELECT}>
              {(meta?.taskKinds ?? [{ kind: s.kind, label: s.kind }]).map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <input value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} aria-label={`Step ${i + 1} title`} className={`${FIELD} flex-1`} />
            <button onClick={() => moveStep(i, -1)} disabled={i === 0} className="text-xs text-slate-400 disabled:opacity-30" aria-label={`Move step ${i + 1} up`}>
              ↑
            </button>
            <button onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} className="text-xs text-slate-400 disabled:opacity-30" aria-label={`Move step ${i + 1} down`}>
              ↓
            </button>
            <button onClick={() => setSteps((st) => st.filter((_, j) => j !== i))} className="text-xs text-slate-500 hover:text-red-400" aria-label={`Remove step ${i + 1}`}>
              ×
            </button>
          </div>
        ))}
        <button
          onClick={() => {
            const kind = meta?.taskKinds.find((k) => k.kind === "custom")?.kind ?? "custom";
            setSteps((st) => [...st, { kind, title: "" }]);
          }}
          className="text-sm text-sky-400 hover:underline"
        >
          Add a step
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void save()} disabled={busy || !name.trim() || !dirty} className={type ? BTN_QUIET : BTN}>
          {type ? "Save changes" : "Create job type"}
        </button>
        {type && (
          <button onClick={() => void remove()} className={BTN_DANGER}>
            Delete
          </button>
        )}
        {message && <span className={`text-sm ${message.tone === "ok" ? "text-emerald-300" : "text-red-300"}`}>{message.text}</span>}
      </div>
    </div>
  );
}
