import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import type { DeliveryStatus } from "./types";

/** Small pieces shared by the audit log and webhook screens. */

export const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

export const formatTime = (iso: string) => new Date(iso).toLocaleString();

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Both screens change how the instance behaves, so they are administrators only. */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== "admin") {
    return (
      <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
        Only an administrator can see this page.
      </p>
    );
  }
  return <>{children}</>;
}

export function PageHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div>
      <Link to="/settings" className="text-sm text-slate-400 hover:text-slate-200">
        ← Settings
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-slate-100">{title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-400">{description}</p>
    </div>
  );
}

const STATUS_TONE: Record<DeliveryStatus, string> = {
  succeeded: "bg-emerald-950 text-emerald-400",
  pending: "bg-slate-800 text-slate-300",
  failed: "bg-amber-950 text-amber-300",
  dead: "bg-red-950 text-red-300",
};

const STATUS_LABEL: Record<DeliveryStatus, string> = {
  succeeded: "Delivered",
  pending: "Queued",
  failed: "Failed",
  dead: "Gave up",
};

export function DeliveryPill({ status }: { status: DeliveryStatus }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

/** Shows a value once with a copy button, for secrets that are not shown again. */
export function RevealOnce({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="rounded-lg border border-amber-700 bg-amber-950/50 p-4">
      <p className="text-sm font-medium text-amber-300">{label}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="break-all rounded bg-slate-950 px-2 py-1 text-sm text-slate-200">{value}</code>
        <button
          onClick={copy}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={onDismiss} className="text-sm text-slate-400 hover:text-slate-200">
          Dismiss
        </button>
      </div>
      {failed && <p className="mt-2 text-xs text-slate-400">Could not copy. Select it and copy it by hand.</p>}
    </div>
  );
}
