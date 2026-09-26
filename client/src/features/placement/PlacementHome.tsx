import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CARD, Notice, StatusBadge, errorText } from "../jobs-core/ui";
import { placementApi } from "./api";
import type { PlacementJobSummary } from "./types";
import { PlacementBar, pathText } from "./ui";

/** Open jobs, each with how much of it is in its room. Pick one to guide its delivery. */
export function PlacementHome() {
  const [jobs, setJobs] = useState<PlacementJobSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    placementApi
      .jobs()
      .then(setJobs)
      .catch((err) => setError(errorText(err, "Could not load jobs.")));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Placement</h1>
        <p className="text-sm text-slate-400">
          Where each thing on a delivery goes, and whether it got there. Pick a job to scan labels at the truck, sweep
          rooms, or run a kiosk at a floor entrance.
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {jobs === null && !error && <p className="text-slate-400">Loading…</p>}
      {jobs?.length === 0 && (
        <Notice>
          No open jobs. Create one under <Link to="/jobs" className="text-sky-400 hover:underline">Jobs</Link>, add what it
          moves, and it appears here.
        </Notice>
      )}
      <ul className="space-y-3">
        {jobs?.map((j) => (
          <li key={j.id}>
            <Link to={`/placement/jobs/${j.id}`} className={`${CARD} block space-y-2 hover:border-slate-600`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-slate-400">{j.code}</span>
                <span className="font-medium text-slate-100">{j.name}</span>
                <StatusBadge status={j.status} />
                {j.destination && <span className="text-sm text-slate-400">to {pathText(j.destination)}</span>}
              </div>
              <PlacementBar tally={j.tally} label="In their rooms" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
