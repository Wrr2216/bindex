import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { crewApi, type WorkerFilters } from "./api";
import { WorkerForm } from "./forms";
import type { CredentialType, CrewJob, ExpiringCredential, JobOption, Timesheet, WorkerSummary } from "./types";
import {
  Avatar,
  BTN,
  BTN_QUIET,
  CARD,
  FIELD,
  LightChip,
  LightDot,
  Notice,
  SELECT,
  errorText,
  fmtDate,
  fmtHours,
  localDay,
  openDocument,
  useCrewStatus,
} from "./ui";

/**
 * Crew: the jobs to check people in on, the workers and their standing,
 * credentials running out, and timesheets. Tabs live in the query string so a
 * link can open the right one.
 */

type Tab = "checkin" | "workers" | "expiring" | "timesheets";

export function CrewPage() {
  const status = useCrewStatus();
  const [params, setParams] = useSearchParams();
  const jobsOn = status?.jobs ?? true;
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = requested ?? (jobsOn ? "checkin" : "workers");

  const tabs: { id: Tab; label: string }[] = [
    ...(jobsOn ? [{ id: "checkin" as const, label: "Check-in" }] : []),
    { id: "workers", label: "Workers" },
    { id: "expiring", label: "Expiring" },
    ...(jobsOn ? [{ id: "timesheets" as const, label: "Timesheets" }] : []),
  ];

  const go = (id: Tab) => {
    const next = new URLSearchParams();
    next.set("tab", id);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-100">Crew</h1>
        {status?.isAdmin && (
          <Link to="/settings/crew" className={BTN_QUIET}>
            Credential types and rules
          </Link>
        )}
      </div>
      <nav className="flex gap-1 border-b border-slate-800" aria-label="Crew sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => go(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.id ? "border-sky-400 text-sky-300" : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "checkin" && jobsOn && <JobsTab />}
      {tab === "workers" && <WorkersTab />}
      {tab === "expiring" && <ExpiringTab isAdmin={status?.isAdmin ?? false} />}
      {tab === "timesheets" && jobsOn && <TimesheetsTab />}
    </div>
  );
}

function JobsTab() {
  const [jobs, setJobs] = useState<CrewJob[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    crewApi
      .jobs()
      .then(setJobs)
      .catch((err) => setError(errorText(err, "Jobs could not be loaded.")));
  }, []);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (jobs ?? []).filter((j) => !term || `${j.code} ${j.name} ${j.jobTypeName ?? ""}`.toLowerCase().includes(term));
  }, [jobs, q]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-400">Pick the job to check crew in on. Scanning a badge there checks them in and shows their credentials at a glance.</p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a job" aria-label="Find a job" className={`${FIELD} sm:w-72`} />
      {error && <Notice tone="error">{error}</Notice>}
      {jobs && jobs.length === 0 && (
        <p className="text-sm text-slate-500">
          No open jobs. Start one under{" "}
          <Link to="/jobs" className="text-sky-400 hover:underline">
            Jobs
          </Link>
          .
        </p>
      )}
      <ul className="space-y-2">
        {shown.map((j) => (
          <li key={j.id}>
            <Link to={`/crew/jobs/${j.id}`} className={`${CARD} flex flex-wrap items-center gap-3 hover:border-slate-700`}>
              <span className="font-mono text-xs text-slate-400">{j.code}</span>
              <span className="flex-1 font-medium text-slate-100">{j.name}</span>
              {j.jobTypeName && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: j.jobTypeColor ?? "#64748b" }} />
                  {j.jobTypeName}
                </span>
              )}
              <span className={`rounded-full px-2 py-0.5 text-xs ${j.onSite ? "bg-sky-950 text-sky-300" : "bg-slate-800 text-slate-400"}`}>
                {j.onSite} on site
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const EXPIRY_CHOICES = [7, 30, 60, 90];

function WorkersTab() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<WorkerFilters>({ active: "true" });
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ workers: WorkerSummary[]; companies: string[] } | null>(null);
  const [types, setTypes] = useState<CredentialType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const adding = params.get("new") === "1";
  const presetBadge = params.get("badge") ?? undefined;

  useEffect(() => {
    crewApi.credentialTypes(true).then(setTypes).catch(() => undefined);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      crewApi
        .workers({ ...filters, q: q.trim() || undefined })
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((err) => setError(errorText(err, "Workers could not be loaded.")));
    }, 200);
    return () => clearTimeout(t);
  }, [filters, q]);

  const setAdding = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set("new", "1");
    else {
      next.delete("new");
      next.delete("badge");
    }
    setParams(next, { replace: true });
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const set = <K extends keyof WorkerFilters>(k: K, v: WorkerFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const workers = data?.workers ?? [];
  const allSelected = workers.length > 0 && workers.every((w) => selected.has(w.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setAdding(!adding)} className={adding ? BTN_QUIET : BTN}>
          {adding ? "Cancel" : "Add worker"}
        </button>
        {selected.size > 0 && (
          <>
            <button onClick={() => openDocument(crewApi.badgesPdfUrl([...selected], "sheet"))} className={BTN_QUIET}>
              Print {selected.size} badge{selected.size === 1 ? "" : "s"} on sheets
            </button>
            <button onClick={() => openDocument(crewApi.badgesPdfUrl([...selected], "card"))} className={BTN_QUIET}>
              For a card printer
            </button>
          </>
        )}
      </div>
      {adding && (
        <div className={CARD}>
          <WorkerForm
            initial={presetBadge ? { badgeCode: presetBadge } : undefined}
            onSaved={(w) => navigate(`/crew/workers/${w.id}`)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name, badge, company, phone"
          aria-label="Search workers"
          className={`${FIELD} sm:w-64`}
        />
        <select value={filters.company ?? ""} onChange={(e) => set("company", e.target.value || undefined)} aria-label="Company" className={SELECT}>
          <option value="">Any company</option>
          {data?.companies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={filters.light ?? ""}
          onChange={(e) => set("light", (e.target.value || undefined) as WorkerFilters["light"])}
          aria-label="Standing"
          className={SELECT}
        >
          <option value="">Any standing</option>
          <option value="green">Compliant</option>
          <option value="amber">Expiring soon</option>
          <option value="red">Not compliant</option>
          <option value="none">Nothing on file</option>
        </select>
        <select value={filters.credentialType ?? ""} onChange={(e) => set("credentialType", e.target.value || undefined)} aria-label="Holds" className={SELECT}>
          <option value="">Holding anything</option>
          {types.map((t) => (
            <option key={t.key} value={t.key}>
              Holds {t.name}
            </option>
          ))}
        </select>
        <select
          value={filters.expiring ?? ""}
          onChange={(e) => set("expiring", e.target.value ? Number(e.target.value) : undefined)}
          aria-label="Expiring"
          className={SELECT}
        >
          <option value="">Any expiry</option>
          {EXPIRY_CHOICES.map((d) => (
            <option key={d} value={d}>
              Expired or expiring in {d} days
            </option>
          ))}
        </select>
        <select value={filters.active ?? "true"} onChange={(e) => set("active", e.target.value as WorkerFilters["active"])} aria-label="Active" className={SELECT}>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
          <option value="all">Everyone</option>
        </select>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {data && workers.length === 0 && <p className="text-sm text-slate-500">No workers match. Add one, or loosen the filters.</p>}
      {workers.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-xs uppercase text-slate-500">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(workers.map((w) => w.id)))}
                    aria-label="Select all"
                  />
                </th>
                <th className="px-3 py-2">Worker</th>
                <th className="px-3 py-2">Badge</th>
                <th className="px-3 py-2">Standing</th>
                <th className="px-3 py-2">Next expiry</th>
                <th className="px-3 py-2">Now</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {workers.map((w) => (
                <tr key={w.id} className={w.active ? "" : "opacity-60"}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} aria-label={`Select ${w.name}`} />
                  </td>
                  <td className="px-3 py-2">
                    <Link to={`/crew/workers/${w.id}`} className="flex items-center gap-3">
                      <Avatar worker={w} size="sm" />
                      <span>
                        <span className="block text-slate-100 hover:underline">{w.name}</span>
                        <span className="block text-xs text-slate-500">{[w.company, w.role].filter(Boolean).join(" · ")}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{w.badgeCode}</td>
                  <td className="px-3 py-2">
                    <span title={w.checks.map((c) => `${c.typeName}: ${c.label}`).join("\n")}>
                      <LightChip light={w.light} />
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">
                    {w.nextExpiry ? (
                      <span className={w.nextExpiry.daysLeft < 0 ? "text-red-300" : w.nextExpiry.daysLeft <= 30 ? "text-amber-300" : ""}>
                        {w.nextExpiry.typeName} {fmtDate(w.nextExpiry.expiresOn)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {w.onJob ? (
                      <Link to={`/crew/jobs/${w.onJob.jobId}`} className="rounded-full bg-sky-950 px-2 py-0.5 text-sky-300 hover:underline">
                        on {w.onJob.jobCode}
                      </Link>
                    ) : (
                      <span className="text-slate-600">off site</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExpiringTab({ isAdmin }: { isAdmin: boolean }) {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<ExpiringCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    crewApi
      .expiring(days)
      .then(setRows)
      .catch((err) => setError(errorText(err, "Could not load expiring credentials.")));
  }, [days]);

  const send = async () => {
    setMessage(null);
    try {
      const r = await crewApi.sendDigest();
      setMessage(
        r.skipped
          ? `Not sent: ${r.skipped}.`
          : r.delivered
            ? `Sent: ${r.count} credential${r.count === 1 ? "" : "s"}.`
            : `${r.count} credential${r.count === 1 ? "" : "s"} published as an event; no Pushover or Wazuh destination is configured.`,
      );
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-slate-400">
          Expired, or expiring within{" "}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={SELECT} aria-label="Days">
            {EXPIRY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        {isAdmin && (
          <button onClick={() => void send()} className={BTN_QUIET}>
            Send the digest now
          </button>
        )}
      </div>
      {message && <Notice>{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {rows && rows.length === 0 && <p className="text-sm text-slate-500">Nothing needs renewing in that window.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
          {rows.map((r) => (
            <li key={`${r.workerId}:${r.typeKey}`} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <LightDot light={r.daysLeft < 0 ? "red" : "amber"} />
              <Link to={`/crew/workers/${r.workerId}`} className="text-slate-100 hover:underline">
                {r.workerName}
              </Link>
              <span className="text-slate-500">{r.company}</span>
              <span className="flex-1 text-slate-300">{r.typeName}</span>
              <span className={r.daysLeft < 0 ? "text-red-300" : "text-amber-300"}>
                {r.daysLeft < 0
                  ? `expired ${-r.daysLeft} day${r.daysLeft === -1 ? "" : "s"} ago`
                  : r.daysLeft === 0
                    ? "expires today"
                    : `in ${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"}`}
              </span>
              <span className="w-24 text-right text-xs text-slate-500">{fmtDate(r.expiresOn)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TimesheetsTab() {
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [jobId, setJobId] = useState("");
  const [from, setFrom] = useState(localDay(-6));
  const [to, setTo] = useState(localDay());
  const [sheet, setSheet] = useState<Timesheet | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    crewApi.allJobs().then(setJobs).catch(() => undefined);
  }, []);

  useEffect(() => {
    crewApi
      .timesheet({ jobId: jobId || undefined, from: from || undefined, to: to || undefined })
      .then((s) => {
        setSheet(s);
        setError(null);
      })
      .catch((err) => setError(errorText(err, "The timesheet could not be loaded.")));
  }, [jobId, from, to]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-400">
          Job
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} className={`${SELECT} mt-1 block`}>
            <option value="">All jobs</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.code} {j.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-slate-400">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <a href={crewApi.timesheetUrl({ jobId: jobId || undefined, from: from || undefined, to: to || undefined })} className={BTN}>
          Download XLSX
        </a>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {sheet && (
        <>
          <p className="text-sm text-slate-400">
            {sheet.totals.workers} worker{sheet.totals.workers === 1 ? "" : "s"} · {sheet.totals.shifts} shift
            {sheet.totals.shifts === 1 ? "" : "s"} · {fmtHours(sheet.totals.minutes)} hours
          </p>
          {sheet.roster.length === 0 ? (
            <p className="text-sm text-slate-500">No shifts in this range.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-900 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Job</th>
                    <th className="px-3 py-2">Worker</th>
                    <th className="px-3 py-2 text-right">Shifts</th>
                    <th className="px-3 py-2 text-right">Hours</th>
                    <th className="px-3 py-2">At the door</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {sheet.roster.map((r) => (
                    <tr key={`${r.jobId}:${r.workerId}`}>
                      <td className="px-3 py-2">
                        <Link to={`/crew/jobs/${r.jobId}`} className="font-mono text-xs text-sky-400 hover:underline">
                          {r.jobCode}
                        </Link>
                        <span className="ml-2 text-slate-400">{r.jobName}</span>
                      </td>
                      <td className="px-3 py-2">
                        <Link to={`/crew/workers/${r.workerId}`} className="text-slate-100 hover:underline">
                          {r.workerName}
                        </Link>
                        {r.company && <span className="ml-2 text-xs text-slate-500">{r.company}</span>}
                        {r.onSite && <span className="ml-2 rounded-full bg-sky-950 px-2 text-xs text-sky-300">on site</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-300">{r.shifts}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-100">{fmtHours(r.minutes)}</td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2 text-xs text-slate-400">
                          <LightDot light={r.compliance} />
                          {r.overrides ? `${r.overrides} override${r.overrides === 1 ? "" : "s"}` : ""}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
