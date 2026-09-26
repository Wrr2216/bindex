import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PortalClient } from "./api";
import type { Progress, StageInfo } from "./types";

/**
 * Small pieces for the portal pages. The public page deliberately does not
 * import the staff screens' helpers: those pull in the scanner overlay and the
 * rest of the signed-in app, which a customer's phone has no need to load.
 */

export const CARD = "rounded-xl border border-slate-800 bg-slate-900 p-4";
export const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-base text-slate-100 placeholder-slate-500 focus:border-slate-400 focus:outline-none sm:text-sm";
export const BTN_QUIET =
  "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
export const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";

export type PortalUi = {
  client: PortalClient;
  accent: string;
  stages: StageInfo[];
  locale: string;
  currency: string;
};

export const PortalUiContext = createContext<PortalUi | null>(null);

export function usePortalUi(): PortalUi {
  const ui = useContext(PortalUiContext);
  if (!ui) throw new Error("usePortalUi outside the portal page");
  return ui;
}

/** A button in the instance's colour. */
export function AccentButton({
  children,
  onClick,
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const { accent } = usePortalUi();
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50 ${className}`}
      style={{ backgroundColor: accent }}
    >
      {children}
    </button>
  );
}

export function ProgressBar({ progress, label }: { progress: Progress; label?: string }) {
  const { accent } = usePortalUi();
  const pct = progress.overall;
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-label={label ?? "Progress"}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: progress.complete ? "#10b981" : accent }}
        />
      </div>
      <span className="w-10 text-right text-xs tabular-nums text-slate-400">{pct}%</span>
    </div>
  );
}

const STEPS: { key: keyof Progress["percent"]; label: string }[] = [
  { key: "packed", label: "Packed" },
  { key: "loaded", label: "Loaded" },
  { key: "delivered", label: "Delivered" },
  { key: "placed", label: "Placed" },
];

/** One bar per step: the scan and placement progress a customer asks about. */
export function StepBars({ progress }: { progress: Progress }) {
  const { accent } = usePortalUi();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {STEPS.map((s) => (
        <div key={s.key}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-slate-300">{s.label}</span>
            <span className="tabular-nums text-slate-400">
              {progress.reached[s.key]}/{progress.total}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full" style={{ width: `${progress.percent[s.key]}%`, backgroundColor: accent }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export const words = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function StageBadge({ stage }: { stage: string }) {
  const { stages } = usePortalUi();
  const info = stages.find((s) => s.name === stage);
  const color = info?.color ?? "#64748b";
  return (
    <span
      className="whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${color}26`, color }}
    >
      {info?.label ?? words(stage)}
    </span>
  );
}

export function Chip({ tone, children }: { tone: "red" | "amber" | "sky" | "slate"; children: ReactNode }) {
  const cls = {
    red: "bg-red-950 text-red-300",
    amber: "bg-amber-950 text-amber-300",
    sky: "bg-sky-950 text-sky-300",
    slate: "bg-slate-800 text-slate-300",
  }[tone];
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
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

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString([], { dateStyle: "medium" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A photo fetched through the portal API. An <img src> cannot carry the link
 * token in a header, so the bytes are fetched and shown from a blob URL.
 */
export function PortalImage({
  id,
  thumb = 320,
  alt,
  className = "",
  onClick,
}: {
  id: string;
  thumb?: number;
  alt: string;
  className?: string;
  onClick?: () => void;
}) {
  const { client } = usePortalUi();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    client
      .file(id, thumb || undefined)
      .then((b) => {
        if (!live) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, id, thumb]);
  if (failed) {
    return <div className={`flex items-center justify-center bg-slate-800 text-xs text-slate-500 ${className}`}>No preview</div>;
  }
  if (!src) return <div className={`animate-pulse bg-slate-800 ${className}`} aria-label={alt} />;
  const img = <img src={src} alt={alt} className={`object-cover ${className}`} />;
  return onClick ? (
    <button type="button" onClick={onClick} className="block w-full overflow-hidden rounded-lg">
      {img}
    </button>
  ) : (
    img
  );
}

/** Open a shared file in a new tab (or save it, for types a browser will not show). */
export async function openPortalFile(client: PortalClient, id: string, filename: string): Promise<void> {
  // Opened before the fetch, so a phone's popup blocker sees a direct tap.
  const tab = window.open("", "_blank");
  const blob = await client.file(id);
  const url = URL.createObjectURL(blob);
  if (tab && (blob.type.startsWith("image/") || blob.type === "application/pdf")) {
    tab.location.href = url;
  } else {
    tab?.close();
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
