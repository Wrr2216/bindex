import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useFeatures } from "../../config/useConfig";
import { ageOf, useOfflineStatus } from "./status";
import { applyUpdate, watchServiceWorker } from "./sw-client";
import { startSyncTriggers } from "./sync";
import { installOfflineTransport } from "./transport";

// Installed as this module loads, which is before the app first renders: the
// session and configuration providers fetch on mount, and those are the
// requests that must still work with no connection.
installOfflineTransport();

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Badge({ tone, to, children }: { tone: "offline" | "warn" | "info"; to: string | null; children: ReactNode }) {
  const cls = `pointer-events-auto flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg ${
    tone === "offline"
      ? "border-amber-600 bg-amber-950 text-amber-200"
      : tone === "warn"
        ? "border-amber-700 bg-slate-900 text-amber-300"
        : "border-slate-700 bg-slate-900 text-slate-200"
  }`;
  return to ? (
    <Link to={to} className={cls}>
      {children}
    </Link>
  ) : (
    <div className={cls} role="status">
      {children}
    </div>
  );
}

/**
 * The OFFLINE badge and its companions, shown over every screen: whether this
 * device is working from its offline copy and how old that copy is, how many
 * changes are waiting or need a decision, and when a new version is ready.
 */
export function OfflineStatus() {
  const s = useOfflineStatus();
  const features = useFeatures();
  const [, tick] = useState(0);

  useEffect(() => {
    startSyncTriggers();
    watchServiceWorker();
    // Keep "copy from 5 min ago" honest while the screen sits open.
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const link = features.offline ? "/offline" : null;
  const copyHere = features.offline && s.deviceEnabled;
  const badges: ReactNode[] = [];

  // With the feature off only what must not be lost shows: changes still
  // waiting from before it was switched off, and a new version.
  if (!s.online && features.offline) {
    badges.push(
      <Badge key="offline" tone="offline" to={link}>
        <span className="font-bold tracking-wider">OFFLINE</span>
        <span className="text-amber-300/80">
          {copyHere
            ? s.cacheAt
              ? `copy from ${ageOf(s.cacheAt)}`
              : "nothing taken offline yet"
            : "no offline copy on this device"}
          {s.pending > 0 && ` · ${plural(s.pending, "change", "changes")} waiting`}
        </span>
      </Badge>,
    );
  } else if (s.attention > 0) {
    badges.push(
      <Badge key="attention" tone="warn" to={link}>
        {plural(s.attention, "change needs", "changes need")} attention
      </Badge>,
    );
  } else if (s.pending > 0) {
    badges.push(
      <Badge key="pending" tone="info" to={link}>
        {s.syncing ? "Sending " : ""}
        {plural(s.pending, "change", "changes")}
        {s.syncing ? "…" : " waiting to sync"}
      </Badge>,
    );
  }

  if (s.updateAvailable) {
    badges.push(
      <button
        key="update"
        onClick={applyUpdate}
        className="pointer-events-auto rounded-full border border-sky-700 bg-sky-950 px-3 py-1.5 text-xs font-medium text-sky-200 shadow-lg hover:bg-sky-900"
      >
        A new version is ready · Reload
      </button>,
    );
  }

  if (!badges.length) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex flex-col items-center gap-2 px-4 print:hidden"
      aria-live="polite"
    >
      {badges}
    </div>
  );
}
