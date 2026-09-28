import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { jobsApi } from "./api";
import { JobForm } from "./JobDetail";
import type { JobStatus, JobSummary } from "./types";
import {
  BTN,
  BTN_QUIET,
  CARD,
  FIELD,
  Notice,
  ProgressBar,
  SELECT,
  StatusBadge,
  TypeChip,
  errorText,
  fmtDateTime,
  statusText,
  useJobsMeta,
  useLocations,
} from "./ui";

/** Every job, newest first, with a form to start a new one. */
export function JobsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const meta = useJobsMeta();
  const { options: locationOptions } = useLocations();
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [status, setStatus] = useState<JobStatus | "">("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const creating = params.get("new") === "1";

  useEffect(() => {
    const t = setTimeout(() => {
      jobsApi
        .listJobs({ status: status || undefined, q: q.trim() || undefined })
        .then((j) => {
          setJobs(j);
          setError(null);
        })
        .catch((err) => setError(errorText(err, "Jobs could not be loaded.")));
    }, 200);
    return () => clearTimeout(t);
  }, [status, q]);

  const setCreating = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set("new", "1");
    else {
      next.delete("new");
      next.delete("projectId");
      next.delete("phaseId");
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-100">Jobs</h1>
        <div className="flex flex-wrap gap-2">
          <Link to="/projects" className={BTN_QUIET}>
            Projects
          </Link>
          {user?.role === "admin" && (
            <Link to="/settings/job-types" className={BTN_QUIET}>
              Job types
            </Link>
          )}
          <button onClick={() => setCreating(!creating)} className={BTN}>
            {creating ? "Cancel" : "New job"}
          </button>
        </div>
      </div>

      {creating && (
        <JobForm
          initial={{ projectId: params.get("projectId") ?? undefined, phaseId: params.get("phaseId") ?? undefined }}
          locationOptions={locationOptions}
          onSaved={(id) => navigate(`/jobs/${id}`)}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or code" aria-label="Search jobs" className={`${FIELD} sm:w-64`} />
        <select value={status} onChange={(e) => setStatus(e.target.value as JobStatus | "")} aria-label="Status" className={SELECT}>
          <option value="">Any status</option>
          {meta?.jobStatuses.map((s) => (
            <option key={s} value={s}>
              {statusText(s)}
            </option>
          ))}
        </select>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {jobs && jobs.length === 0 && (
        <p className="text-sm text-slate-500">
          No jobs yet. A job moves a set of things from where they are to where they are going: start one with New job.
        </p>
      )}
      <ul className="space-y-2">
        {jobs?.map((j) => (
          <li key={j.id}>
            <Link to={`/jobs/${j.id}`} className={`${CARD} block space-y-2 hover:border-slate-700`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-slate-400">{j.code}</span>
                <span className="font-medium text-slate-100">{j.name}</span>
                <TypeChip name={j.jobTypeName} color={j.jobTypeColor} />
                <StatusBadge status={j.status} />
              </div>
              <div className="flex flex-wrap gap-x-3 text-xs text-slate-400">
                {j.projectCode && (
                  <span>
                    {j.projectCode} {j.projectName}
                    {j.phaseName ? ` · ${j.phaseName}` : ""}
                  </span>
                )}
                {(j.originName || j.destinationName) && (
                  <span>
                    {j.originName ?? "?"} → {j.destinationName ?? "?"}
                  </span>
                )}
                {j.scheduledStart && <span>{fmtDateTime(j.scheduledStart)}</span>}
                <span>
                  {j.progress.total} line{j.progress.total === 1 ? "" : "s"}
                  {j.progress.exceptions ? ` · ${j.progress.exceptions} flagged` : ""}
                </span>
              </div>
              <ProgressBar progress={j.progress} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
