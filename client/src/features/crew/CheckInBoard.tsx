import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { CameraIcon } from "../../components/icons";
import { useScan } from "../../scan/ScanProvider";
import { play, primeAudio } from "../jobs-core/sound";
import { crewApi, type CheckInInput } from "./api";
import type { BlockedDetails, Candidate, CheckInOutcome, ElsewhereDetails, Roster, RosterEntry, WorkerBrief } from "./types";
import {
  Avatar,
  BTN,
  BTN_QUIET,
  CARD,
  CheckList,
  ComplianceCard,
  FIELD,
  H2,
  LightChip,
  LightDot,
  Notice,
  errorText,
  fmtHours,
  fmtMinutes,
  fmtTime,
  fromLocalInput,
  localDay,
  toLocalInput,
  useCrewStatus,
  useNow,
} from "./ui";

/**
 * The door of a job: scan a badge (handheld reader, camera, or a pick from a
 * search) and the worker is checked in, with their credentials shown green,
 * amber or red against what the job's type requires. A red under a blocking
 * policy stops at an override form that asks why; everything else goes
 * straight in. The same scan checks people out at the end of a shift.
 */

type Mode = "in" | "out";

type View =
  | { kind: "in"; outcome: CheckInOutcome }
  | { kind: "out"; worker: WorkerBrief; minutes: number }
  | { kind: "blocked"; details: BlockedDetails; input: CheckInInput }
  | { kind: "elsewhere"; details: ElsewhereDetails; input: CheckInInput }
  | { kind: "unknown"; code: string }
  | { kind: "error"; message: string };

export function CheckInBoard() {
  const { jobId = "" } = useParams();
  const status = useCrewStatus();
  const { armBulkCapture, openCamera } = useScan();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("in");
  const [scanning, setScanning] = useState(true);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRoster(await crewApi.roster(jobId));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, "The roster could not be loaded."));
    }
  }, [jobId]);

  useEffect(() => {
    void load();
    // Other devices check people in too; keep the board current.
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const run = useCallback(
    async (input: CheckInInput, direction: Mode) => {
      setBusy(true);
      try {
        if (direction === "out") {
          const r = await crewApi.checkOutByCode(jobId, { code: input.code, workerId: input.workerId });
          const minutes = Math.max(
            0,
            Math.floor((new Date(r.checkin.checkedOutAt!).getTime() - new Date(r.checkin.checkedInAt).getTime()) / 60_000) -
              r.checkin.breakMinutes,
          );
          setView({ kind: "out", worker: r.worker, minutes });
          play("ok");
        } else {
          const outcome = await crewApi.checkIn(jobId, input);
          setView({ kind: "in", outcome });
          play(outcome.status === "already" ? "already" : outcome.compliance.light === "green" ? "ok" : "already");
        }
        void load();
      } catch (err) {
        play("error");
        if (err instanceof ApiError && err.code === "credentials_blocked") {
          setView({ kind: "blocked", details: err.details as BlockedDetails, input });
        } else if (err instanceof ApiError && err.code === "checked_in_elsewhere") {
          setView({ kind: "elsewhere", details: err.details as ElsewhereDetails, input });
        } else if (err instanceof ApiError && err.code === "unknown_badge") {
          setView({ kind: "unknown", code: (err.details as { code?: string } | undefined)?.code ?? input.code ?? "" });
        } else {
          setView({ kind: "error", message: errorText(err, "That did not work. Try again.") });
        }
      } finally {
        setBusy(false);
      }
    },
    [jobId, load],
  );

  // Scans arrive one after another at a gate; handle them in order.
  const queue = useRef(Promise.resolve());
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!scanning) {
      armBulkCapture(null);
      return;
    }
    armBulkCapture((code) => {
      const direction = modeRef.current;
      queue.current = queue.current.then(() => runRef.current({ code, via: "scan" }, direction));
    });
    return () => armBulkCapture(null);
  }, [scanning, armBulkCapture]);

  if (loadError && !roster) {
    return (
      <div className="space-y-4">
        <Link to="/crew" className="text-sm text-sky-400 hover:underline">
          ← Crew
        </Link>
        <Notice tone="error">{loadError}</Notice>
      </div>
    );
  }
  if (!roster) return <p className="text-slate-400">Loading…</p>;

  const { job, policy, required } = roster;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link to="/crew" className="text-sm text-sky-400 hover:underline">
          ← Crew
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">
              <span className="mr-2 font-mono text-base text-slate-400">{job.code}</span>
              {job.name}
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              {job.jobTypeName ? `${job.jobTypeName} · ` : ""}
              {required.length === 0
                ? "No credentials required"
                : `Requires ${required.map((r) => r.name).join(", ")}`}
              {required.length > 0 &&
                (policy.policy === "block"
                  ? ` · missing or expired blocks check-in${policy.overrideAdminOnly ? " (administrators can override)" : " unless overridden"}`
                  : " · missing or expired only warns")}
            </p>
          </div>
          <Link to={`/jobs/${job.id}`} className={BTN_QUIET}>
            Open job
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="On site" value={String(roster.totals.onSite)} />
        <Stat label="Workers" value={String(roster.totals.workers)} />
        <Stat label="Hours" value={fmtHours(roster.totals.minutes)} />
      </div>

      <section className={`${CARD} space-y-4`} aria-label="Add crew">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={H2}>Add crew</h2>
          <div className="flex rounded-lg border border-slate-700 p-0.5 text-sm" role="radiogroup" aria-label="Scan to">
            {(["in", "out"] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1 ${mode === m ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
              >
                {m === "in" ? "Check in" : "Check out"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              primeAudio();
              setScanning(!scanning);
            }}
            className={scanning ? BTN_QUIET : BTN}
          >
            {scanning ? "Stop scanning" : "Scan badges"}
          </button>
          <button
            onClick={() => {
              primeAudio();
              setScanning(true);
              openCamera();
            }}
            className={`${BTN_QUIET} inline-flex items-center gap-1.5`}
          >
            <CameraIcon className="h-4 w-4" /> Camera
          </button>
          <span className="text-sm text-slate-400" aria-live="polite">
            {scanning
              ? `Listening: every badge scanned ${mode === "in" ? "checks in" : "checks out"}${busy ? "…" : "."}`
              : "Not listening for scans."}
          </span>
        </div>
        <WorkerSearch
          jobId={jobId}
          mode={mode}
          onPick={(w) => {
            primeAudio();
            void run({ workerId: w.id, via: "search" }, mode);
          }}
        />
        {view && (
          <Result
            view={view}
            isAdmin={status?.isAdmin ?? false}
            onDismiss={() => setView(null)}
            onRetry={(input) => void run(input, "in")}
          />
        )}
      </section>

      <OnSite roster={roster} onChanged={load} />
      <Shifts roster={roster} isAdmin={status?.isAdmin ?? false} onChanged={load} />
      <Hours roster={roster} />
      <Export jobId={job.id} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={CARD}>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-100">{value}</p>
    </div>
  );
}

function WorkerSearch({ jobId, mode, onPick }: { jobId: string; mode: Mode; onPick: (w: WorkerBrief) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Candidate[] | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      crewApi
        .candidates(jobId, term)
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, jobId]);

  return (
    <div className="space-y-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Or search by name, company or badge"
        aria-label="Search workers"
        className={FIELD}
      />
      {results && results.length === 0 && <p className="text-sm text-slate-500">Nobody matches. Add them under Crew → Workers.</p>}
      {results && results.length > 0 && (
        <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
          {results.map((c) => (
            <li key={c.worker.id} className="flex items-center gap-3 px-3 py-2">
              <Avatar worker={c.worker} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm text-slate-100">
                  <LightDot light={c.compliance.light} />
                  <span className="truncate">{c.worker.name}</span>
                  {!c.worker.active && <span className="text-xs text-slate-500">inactive</span>}
                  {c.onJob && (
                    <span className="rounded-full bg-sky-950 px-2 text-xs text-sky-300">
                      {c.onJob.jobId === jobId ? "on site" : `on ${c.onJob.jobCode}`}
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-slate-400">
                  {[c.worker.company, c.compliance.summary].filter(Boolean).join(" · ")}
                </p>
              </div>
              <button
                onClick={() => {
                  onPick(c.worker);
                  setQ("");
                }}
                className={BTN_QUIET}
              >
                {mode === "in" ? "Check in" : "Check out"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Result({
  view,
  isAdmin,
  onDismiss,
  onRetry,
}: {
  view: View;
  isAdmin: boolean;
  onDismiss: () => void;
  onRetry: (input: CheckInInput) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [view]);
  const dismiss = (
    <button onClick={onDismiss} className="text-xs text-slate-400 hover:text-slate-200">
      Dismiss
    </button>
  );

  if (view.kind === "in") {
    const o = view.outcome;
    const title =
      o.status === "already"
        ? "Already checked in"
        : o.overridden
          ? "Checked in on an override"
          : o.compliance.light === "green"
            ? "Checked in"
            : "Checked in with a warning";
    return (
      <ComplianceCard worker={o.worker} compliance={o.compliance} title={title}>
        {o.movedFrom && <p className="text-sm text-slate-400">Checked out of {o.movedFrom.jobCode} first.</p>}
        {o.verifier && !o.verifier.ok && <p className="text-sm text-amber-300">The verifier could not be reached: {o.verifier.error} Judged on what is on file.</p>}
        {dismiss}
      </ComplianceCard>
    );
  }
  if (view.kind === "out") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/50 p-4" role="status">
        <Avatar worker={view.worker} />
        <p className="flex-1 text-sm text-slate-200">
          <span className="font-semibold">{view.worker.name}</span> checked out after {fmtMinutes(view.minutes)}.
        </p>
        {dismiss}
      </div>
    );
  }
  if (view.kind === "blocked") {
    const d = view.details;
    const adminOnly = d.reason === "override_admin_only" || (d.policy.overrideAdminOnly && !isAdmin);
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (reason.trim()) onRetry({ ...view.input, overrideReason: reason.trim() });
    };
    return (
      <ComplianceCard worker={d.worker} compliance={d.compliance} title="Not checked in: credentials">
        {d.verifier && !d.verifier.ok && <p className="text-sm text-amber-300">The verifier could not be reached: {d.verifier.error}</p>}
        {adminOnly && !isAdmin ? (
          <p className="text-sm text-slate-300">Only an administrator can let them in on this job. Renew the credential first.</p>
        ) : (
          <form onSubmit={submit} className="space-y-2">
            <label className="block text-sm text-slate-300">
              Let them in anyway? Say why; this is kept with the check-in and in the audit log.
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className={`${FIELD} mt-1`}
                placeholder="e.g. Renewal booked for Monday; not operating the forklift today"
              />
            </label>
            <div className="flex items-center gap-3">
              <button type="submit" disabled={!reason.trim()} className={BTN}>
                Override and check in
              </button>
              {dismiss}
            </div>
          </form>
        )}
      </ComplianceCard>
    );
  }
  if (view.kind === "elsewhere") {
    const d = view.details;
    return (
      <div className="space-y-3 rounded-xl border border-sky-800 bg-sky-950/30 p-4" role="status">
        <div className="flex items-center gap-3">
          <Avatar worker={d.worker} />
          <p className="flex-1 text-sm text-slate-200">
            <span className="font-semibold">{d.worker.name}</span> is still checked in on{" "}
            <Link to={`/crew/jobs/${d.jobId}`} className="text-sky-400 hover:underline">
              {d.jobCode} {d.jobName}
            </Link>{" "}
            since {fmtTime(d.since)}.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => onRetry({ ...view.input, switchJob: true })} className={BTN}>
            Check out there and in here
          </button>
          {dismiss}
        </div>
      </div>
    );
  }
  if (view.kind === "unknown") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-fuchsia-800 bg-fuchsia-950/30 p-4" role="status">
        <p className="flex-1 text-sm text-fuchsia-200">
          No worker has badge <span className="font-mono">{view.code}</span>.
        </p>
        <Link to={`/crew?tab=workers&new=1&badge=${encodeURIComponent(view.code)}`} className={BTN_QUIET}>
          Add a worker with this badge
        </Link>
        {dismiss}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <Notice tone="error">{view.message}</Notice>
      </div>
      {dismiss}
    </div>
  );
}

function OnSite({ roster, onChanged }: { roster: Roster; onChanged: () => Promise<void> }) {
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const [breaks, setBreaks] = useState<Record<string, string>>({});

  const checkOut = async (e: RosterEntry) => {
    setError(null);
    try {
      const minutes = Number(breaks[e.id] || 0);
      await crewApi.checkOut(e.id, { breakMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : undefined });
      await onChanged();
    } catch (err) {
      setError(errorText(err, "Could not check them out."));
    }
  };

  const everyone = async () => {
    if (!window.confirm(`Check out all ${roster.onSite.length} people on site now?`)) return;
    setError(null);
    try {
      await crewApi.checkOutAll(roster.job.id);
      await onChanged();
    } catch (err) {
      setError(errorText(err, "Could not check everyone out."));
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className={H2}>On site now ({roster.onSite.length})</h2>
        {roster.onSite.length > 1 && (
          <button onClick={() => void everyone()} className={BTN_QUIET}>
            Check out everyone
          </button>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {roster.onSite.length === 0 ? (
        <p className="text-sm text-slate-500">Nobody is checked in. Scan a badge above to start.</p>
      ) : (
        <ul className="space-y-2">
          {roster.onSite.map((e) => {
            const minutes = Math.max(0, Math.floor((now - new Date(e.checkedInAt).getTime()) / 60_000));
            const long = minutes > 14 * 60;
            return (
              <li key={e.id} className={`${CARD} flex flex-wrap items-center gap-3`}>
                <Avatar worker={e.worker} />
                <div className="min-w-[12rem] flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <Link to={`/crew/workers/${e.worker.id}`} className="font-medium text-slate-100 hover:underline">
                      {e.worker.name}
                    </Link>
                    <LightChip light={e.current.light}>{e.current.light === "green" ? "OK" : e.current.summary}</LightChip>
                    {e.overrideReason && (
                      <span className="rounded-full bg-red-950 px-2 py-0.5 text-xs text-red-300" title={e.overrideReason}>
                        overridden by {e.overriddenByName}
                      </span>
                    )}
                  </p>
                  <p className={`text-xs ${long ? "text-amber-300" : "text-slate-400"}`}>
                    {e.worker.company ? `${e.worker.company} · ` : ""}since {fmtTime(e.checkedInAt)} · {fmtMinutes(minutes)}
                    {long ? " · still checked in?" : ""}
                  </p>
                </div>
                <div className="ml-auto flex items-center gap-3">
                  <label className="flex items-center gap-1 text-xs text-slate-400">
                    Break
                    <input
                      value={breaks[e.id] ?? ""}
                      onChange={(ev) => setBreaks((b) => ({ ...b, [e.id]: ev.target.value.replace(/\D/g, "") }))}
                      inputMode="numeric"
                      placeholder="0"
                      aria-label={`Break minutes for ${e.worker.name}`}
                      className="w-14 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-right text-slate-100"
                    />
                    min
                  </label>
                  <button onClick={() => void checkOut(e)} className={BTN_QUIET}>
                    Check out
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** How the door treated a shift, in a word. */
function doorLabel(e: RosterEntry): string {
  if (e.overrideReason) return "overridden";
  if (e.compliance === "red") return "let in with a warning";
  if (e.compliance === "amber") return "expiring soon";
  return "OK";
}

function Shifts({ roster, isAdmin, onChanged }: { roster: Roster; isAdmin: boolean; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ in: "", out: "", breakMinutes: "0" });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const start = (e: RosterEntry) => {
    setEditing(e.id);
    setDraft({ in: toLocalInput(e.checkedInAt), out: toLocalInput(e.checkedOutAt), breakMinutes: String(e.breakMinutes) });
  };

  const save = async (e: RosterEntry) => {
    setError(null);
    try {
      await crewApi.updateCheckin(e.id, {
        checkedInAt: fromLocalInput(draft.in) ?? undefined,
        checkedOutAt: fromLocalInput(draft.out),
        breakMinutes: Math.max(0, Math.round(Number(draft.breakMinutes) || 0)),
      });
      setEditing(null);
      await onChanged();
    } catch (err) {
      setError(errorText(err, "The shift could not be saved."));
    }
  };

  const remove = async (e: RosterEntry) => {
    if (!window.confirm(`Delete ${e.worker.name}'s shift from ${fmtTime(e.checkedInAt)}? Its hours go with it.`)) return;
    try {
      await crewApi.deleteCheckin(e.id);
      await onChanged();
    } catch (err) {
      setError(errorText(err, "The shift could not be deleted."));
    }
  };

  if (roster.shifts.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className={H2}>Shifts</h2>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Worker</th>
              <th className="px-3 py-2">In</th>
              <th className="px-3 py-2">Out</th>
              <th className="px-3 py-2 text-right">Break</th>
              <th className="px-3 py-2 text-right">Hours</th>
              <th className="px-3 py-2">At the door</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {roster.shifts.map((e) =>
              editing === e.id ? (
                <tr key={e.id} className="bg-slate-900/60">
                  <td className="px-3 py-2 text-slate-200">{e.worker.name}</td>
                  <td className="px-3 py-2">
                    <input type="datetime-local" value={draft.in} onChange={(ev) => setDraft({ ...draft, in: ev.target.value })} aria-label="Checked in at" className={FIELD} />
                  </td>
                  <td className="px-3 py-2">
                    <input type="datetime-local" value={draft.out} onChange={(ev) => setDraft({ ...draft, out: ev.target.value })} aria-label="Checked out at" className={FIELD} />
                  </td>
                  <td className="px-3 py-2">
                    <input value={draft.breakMinutes} onChange={(ev) => setDraft({ ...draft, breakMinutes: ev.target.value.replace(/\D/g, "") })} aria-label="Break minutes" className={`${FIELD} w-16 text-right`} />
                  </td>
                  <td colSpan={3} className="px-3 py-2">
                    <div className="flex gap-2">
                      <button onClick={() => void save(e)} className={BTN}>
                        Save
                      </button>
                      <button onClick={() => setEditing(null)} className={BTN_QUIET}>
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={e.id} className="align-top">
                  <td className="px-3 py-2">
                    <Link to={`/crew/workers/${e.worker.id}`} className="text-slate-100 hover:underline">
                      {e.worker.name}
                    </Link>
                    {e.worker.company && <p className="text-xs text-slate-500">{e.worker.company}</p>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-300">{fmtTime(e.checkedInAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-300">{e.checkedOutAt ? fmtTime(e.checkedOutAt) : <span className="text-sky-300">on site</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">{e.breakMinutes ? `${e.breakMinutes} min` : ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-200">{fmtHours(e.minutes)}</td>
                  <td className="px-3 py-2">
                    <button onClick={() => setOpen(open === e.id ? null : e.id)} className="flex items-center gap-2 text-left" aria-expanded={open === e.id}>
                      <LightDot light={e.compliance} />
                      <span className="text-xs text-slate-400">{doorLabel(e)}</span>
                    </button>
                    {open === e.id && (
                      <div className="mt-2 space-y-1">
                        <CheckList checks={e.complianceDetail} />
                        {e.overrideReason && (
                          <p className="text-xs text-red-300">
                            {e.overriddenByName}: “{e.overrideReason}”
                          </p>
                        )}
                        <p className="text-xs text-slate-500">
                          In by {e.checkedInByName ?? "unknown"} via {e.via}
                          {e.checkedOutByName ? ` · out by ${e.checkedOutByName}` : ""}
                        </p>
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button onClick={() => start(e)} className="text-xs text-sky-400 hover:underline">
                      Edit
                    </button>
                    {isAdmin && (
                      <button onClick={() => void remove(e)} className="ml-3 text-xs text-red-400 hover:underline">
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Hours({ roster }: { roster: Roster }) {
  if (roster.workers.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className={H2}>Hours by worker</h2>
      <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
        {roster.workers.map((w) => (
          <li key={w.worker.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Avatar worker={w.worker} size="sm" />
            <span className="flex-1 text-slate-200">
              {w.worker.name}
              {w.onSite && <span className="ml-2 rounded-full bg-sky-950 px-2 text-xs text-sky-300">on site</span>}
            </span>
            <span className="text-slate-400">
              {w.shifts} shift{w.shifts === 1 ? "" : "s"}
            </span>
            <span className="w-20 text-right tabular-nums text-slate-100">{fmtHours(w.minutes)} h</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Export({ jobId }: { jobId: string }) {
  const [from, setFrom] = useState(localDay(-6));
  const [to, setTo] = useState(localDay());
  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className={H2}>Roster and timesheet</h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-400">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-slate-400">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <a href={crewApi.timesheetUrl({ jobId, from: from || undefined, to: to || undefined })} className={BTN}>
          Download XLSX
        </a>
        <a href={crewApi.timesheetUrl({ jobId })} className={BTN_QUIET}>
          Whole job
        </a>
      </div>
      <p className="text-xs text-slate-500">A roster sheet, every shift, and hours per worker per day. Times are in your time zone.</p>
    </section>
  );
}
