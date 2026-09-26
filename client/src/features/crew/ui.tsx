import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import { crewApi } from "./api";
import type { Compliance, CredentialCheck, CrewStatus, Light, WorkerBrief } from "./types";

/** Small pieces shared by the crew screens. */

export const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
export const SELECT =
  "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none";
export const BTN = "rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
export const BTN_QUIET =
  "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
export const BTN_DANGER =
  "rounded-lg border border-red-900 px-3 py-2 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-50";
export const CARD = "rounded-xl border border-slate-800 bg-slate-900 p-4";
export const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";
export const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";

let statusPromise: Promise<CrewStatus> | null = null;

/** Whether the verifier is set up, and whether jobs are on. Fetched once per page load. */
export function useCrewStatus(): CrewStatus | null {
  const [status, setStatus] = useState<CrewStatus | null>(null);
  useEffect(() => {
    statusPromise ??= crewApi.status().catch((err) => {
      statusPromise = null;
      throw err;
    });
    let live = true;
    statusPromise.then((s) => live && setStatus(s)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return status;
}

const LIGHT: Record<Light, { dot: string; chip: string; word: string }> = {
  green: { dot: "bg-emerald-500", chip: "bg-emerald-950 text-emerald-300", word: "Compliant" },
  amber: { dot: "bg-amber-400", chip: "bg-amber-950 text-amber-300", word: "Expiring soon" },
  red: { dot: "bg-red-500", chip: "bg-red-950 text-red-300", word: "Not compliant" },
};

export const lightWord = (light: Light) => LIGHT[light].word;

export function LightDot({ light, title }: { light: Light | null; title?: string }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${light ? LIGHT[light].dot : "bg-slate-600"}`}
      title={title ?? (light ? LIGHT[light].word : "Nothing on file")}
      aria-label={title ?? (light ? LIGHT[light].word : "Nothing on file")}
    />
  );
}

export function LightChip({ light, children }: { light: Light | null; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${
        light ? LIGHT[light].chip : "bg-slate-800 text-slate-400"
      }`}
    >
      <LightDot light={light} />
      {children ?? (light ? LIGHT[light].word : "Nothing on file")}
    </span>
  );
}

/** One line per credential: a dot, its name and where it stands. */
export function CheckList({ checks, empty = "No credentials required." }: { checks: CredentialCheck[]; empty?: string }) {
  if (checks.length === 0) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <ul className="space-y-1">
      {checks.map((c) => (
        <li key={c.typeKey} className="flex items-center gap-2 text-sm">
          <LightDot light={c.light} />
          <span className="text-slate-200">{c.typeName}</span>
          <span className={c.light === "red" ? "text-red-300" : c.light === "amber" ? "text-amber-300" : "text-slate-400"}>
            {c.label}
          </span>
          {c.source === "verifier" && <span className="rounded bg-slate-800 px-1.5 text-[10px] uppercase text-slate-400">verified</span>}
        </li>
      ))}
    </ul>
  );
}

/** The at-a-glance card: the worker, a big light, and each required credential. */
export function ComplianceCard({
  worker,
  compliance,
  title,
  children,
}: {
  worker: WorkerBrief;
  compliance: Compliance;
  title: string;
  children?: ReactNode;
}) {
  const border = { green: "border-emerald-700", amber: "border-amber-600", red: "border-red-700" }[compliance.light];
  const band = { green: "bg-emerald-600", amber: "bg-amber-500", red: "bg-red-600" }[compliance.light];
  return (
    <div className={`overflow-hidden rounded-xl border-2 ${border} bg-slate-900`} role="status">
      <div className={`${band} px-4 py-2 text-sm font-semibold text-white`}>{title}</div>
      <div className="flex gap-4 p-4">
        <Avatar worker={worker} size="lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="text-lg font-semibold text-slate-100">{worker.name}</p>
            <p className="text-sm text-slate-400">
              {[worker.company, worker.role].filter(Boolean).join(" · ") || "No company on file"}
              <span className="ml-2 font-mono text-xs text-slate-500">{worker.badgeCode}</span>
            </p>
          </div>
          <CheckList checks={compliance.checks} />
          {children}
        </div>
      </div>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export function Avatar({ worker, size = "md" }: { worker: Pick<WorkerBrief, "name" | "photoUrl">; size?: "sm" | "md" | "lg" }) {
  const [broken, setBroken] = useState(false);
  const cls = { sm: "h-8 w-8 text-xs", md: "h-10 w-10 text-sm", lg: "h-16 w-16 text-lg" }[size];
  if (worker.photoUrl && !broken) {
    return <img src={worker.photoUrl} alt="" className={`${cls} shrink-0 rounded-lg object-cover`} onError={() => setBroken(true)} />;
  }
  return (
    <span className={`${cls} flex shrink-0 items-center justify-center rounded-lg bg-slate-700 font-semibold text-slate-200`}>
      {initials(worker.name) || "?"}
    </span>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error" | "warn"; children: ReactNode }) {
  const cls = {
    info: "bg-slate-800/60 text-slate-300",
    ok: "bg-emerald-950/50 text-emerald-300",
    error: "bg-red-950/50 text-red-300",
    warn: "bg-amber-950/50 text-amber-300",
  }[tone];
  return <p className={`rounded-lg px-3 py-2 text-sm ${cls}`}>{children}</p>;
}

export const errorText = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof Error && err.message ? err.message : fallback;

export const errorCode = (err: unknown): string | null => (err instanceof ApiError ? err.code : null);

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function fmtTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : fmtDateTime(value);
}

/** "7 h 30 min", or "45 min". */
export function fmtMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const fmtHours = (minutes: number) => (minutes / 60).toFixed(2);

/** An ISO timestamp as a datetime-local input value, in the viewer's zone. */
export function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fromLocalInput = (value: string): string | null => (value ? new Date(value).toISOString() : null);

/** Today, or a number of days from it, as YYYY-MM-DD in the viewer's zone. */
export function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Issue date plus months, ending on the last day of a short month, as the server does. */
export function addMonths(date: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return "";
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month + 1)}-${pad(Math.min(Number(m[3]), last))}`;
}

/** A shift still open reads as "since 7:02 AM · 3 h 10 min", ticking once a minute. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function openDocument(url: string) {
  window.open(url, "_blank", "noopener");
}
