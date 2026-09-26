import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { documentsApi } from "./api";
import type { DocumentStatus, DocumentsMeta, JobPick } from "./types";

/** Small pieces shared by the documents screens. */

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
/** A card holding a list of rows, each with its own padding. */
export const LIST = "divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900";
export const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";
export const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";

export const errorText = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof Error && err.message ? err.message : fallback;

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
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

const STATUS: Record<DocumentStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-slate-800 text-slate-300" },
  completed: { label: "Completed", cls: "bg-sky-950 text-sky-300" },
  signed: { label: "Signed", cls: "bg-emerald-950 text-emerald-300" },
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  const s = STATUS[status];
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${s.cls}`}>{s.label}</span>;
}

let metaPromise: Promise<DocumentsMeta> | null = null;

/** Field types, table sources and merge fields. Fetched once per page load. */
export function useDocumentsMeta(): DocumentsMeta | null {
  const [meta, setMeta] = useState<DocumentsMeta | null>(null);
  useEffect(() => {
    metaPromise ??= documentsApi.meta().catch((err) => {
      metaPromise = null;
      throw err;
    });
    let live = true;
    metaPromise.then((m) => live && setMeta(m)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return meta;
}

export function useIsAdmin(): boolean {
  return useAuth().user?.role === "admin";
}

/** Search jobs by code or name and pick one. Empty means none. */
export function JobPicker({
  value,
  onChange,
  placeholder = "No job",
  label = "Job",
}: {
  value: string;
  onChange: (id: string, job: JobPick | null) => void;
  placeholder?: string;
  label?: string;
}) {
  const [q, setQ] = useState("");
  const [jobs, setJobs] = useState<JobPick[]>([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      documentsApi
        .jobs(q)
        .then((rows) => live && setJobs(rows))
        .catch(() => live && setJobs([]));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input
        className={`${FIELD} sm:w-48`}
        placeholder="Search jobs"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={`Search for a ${label.toLowerCase()}`}
      />
      <select
        className={`${SELECT} flex-1`}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value, jobs.find((j) => j.id === e.target.value) ?? null)}
      >
        <option value="">{placeholder}</option>
        {value && !jobs.some((j) => j.id === value) && <option value={value}>Selected job</option>}
        {jobs.map((j) => (
          <option key={j.id} value={j.id}>
            {j.code}: {j.name}
            {j.jobTypeName ? ` (${j.jobTypeName})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The links along the top of the documents screens. */
export function DocumentsNav() {
  const admin = useIsAdmin();
  const link = "rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800";
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Documents">
      <Link to="/documents" className={link}>
        All documents
      </Link>
      <Link to="/documents/verify" className={link}>
        Verify a PDF
      </Link>
      {admin && (
        <>
          <Link to="/settings/document-templates" className={link}>
            Templates
          </Link>
          <Link to="/settings/document-packets" className={link}>
            Packets
          </Link>
          <Link to="/settings/document-fields" className={link}>
            Field library
          </Link>
        </>
      )}
    </nav>
  );
}

/** Open a server-rendered PDF in a new tab; the session cookie authenticates it. */
export const openPdf = (url: string) => window.open(url, "_blank", "noopener");

/** A short random id for a new template block. */
export const newBlockId = () => `b${Math.random().toString(36).slice(2, 10)}`;

/** "Customer name" → "customer_name", for a field key suggested from its label. */
export function keyFromLabel(label: string): string {
  const key = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(key) ? key : `f_${key}`.slice(0, 40);
}
