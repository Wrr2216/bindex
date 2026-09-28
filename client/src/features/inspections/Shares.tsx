import { useCallback, useEffect, useState } from "react";
import { inspectionsApi, viewerTz } from "./api";
import type { InspectionsMeta, ShareLink } from "./types";
import { BTN_DANGER, BTN_QUIET, CARD, H2, Notice, SELECT, errorText, fmtDateTime } from "./ui";

/**
 * Read-only links to the report for people without an account. Each link is
 * signed and runs out on its own; revoking one stops it at once.
 */

const DURATIONS = [1, 7, 14, 30, 90];

export function SharesPanel({ inspectionId, meta }: { inspectionId: string; meta: InspectionsMeta }) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [days, setDays] = useState(meta.share.defaultDays);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLinks(await inspectionsApi.shares(inspectionId));
    } catch (err) {
      setError(errorText(err, "Links could not be loaded."));
    }
  }, [inspectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await inspectionsApi.createShare(inspectionId, days);
      await load();
      if (link.path) await copy(link);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // The page has no script to read the reader's clock, so the link carries the
  // sender's time zone for the times it prints.
  const href = (l: ShareLink) => `${window.location.origin}${l.path}?tz=${encodeURIComponent(viewerTz())}`;

  const copy = async (l: ShareLink) => {
    try {
      await navigator.clipboard.writeText(href(l));
      setCopied(l.id);
      setTimeout(() => setCopied((c) => (c === l.id ? null : c)), 2000);
    } catch {
      // Clipboard access can be refused; the link is on screen to copy by hand.
    }
  };

  const revoke = async (l: ShareLink) => {
    if (!window.confirm("Withdraw this link? Anyone who has it will no longer be able to open the report.")) return;
    try {
      await inspectionsApi.revokeShare(inspectionId, l.id);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const active = links?.filter((l) => l.active) ?? [];
  const spent = links?.filter((l) => !l.active) ?? [];

  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className={H2}>Share the report</h2>
      <p className="text-sm text-slate-400">
        A read-only link to this report and its PDF, for someone without an account: a facility manager, a landlord, an
        insurer. It stops working when it runs out or when you withdraw it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Link lasts" className={SELECT}>
          {DURATIONS.filter((d) => d <= meta.share.maxDays).map((d) => (
            <option key={d} value={d}>
              Lasts {d} day{d === 1 ? "" : "s"}
            </option>
          ))}
        </select>
        <button onClick={create} disabled={busy} className={BTN_QUIET}>
          {busy ? "Creating…" : "Create link"}
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {active.map((l) => (
        <div key={l.id} className="space-y-1 rounded-lg border border-slate-800 p-2">
          <input readOnly value={href(l)} onFocus={(e) => e.target.select()} aria-label="Share link" className="w-full rounded bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200" />
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>Until {fmtDateTime(l.expiresAt)}</span>
            <span>
              Opened {l.openCount} time{l.openCount === 1 ? "" : "s"}
              {l.lastOpenedAt ? `, last ${fmtDateTime(l.lastOpenedAt)}` : ""}
            </span>
            <button onClick={() => void copy(l)} className={BTN_QUIET}>
              {copied === l.id ? "Copied" : "Copy"}
            </button>
            <a href={href(l)} target="_blank" rel="noreferrer" className={BTN_QUIET}>
              Open
            </a>
            <button onClick={() => void revoke(l)} className={BTN_DANGER}>
              Withdraw
            </button>
          </div>
        </div>
      ))}
      {spent.length > 0 && (
        <p className="text-xs text-slate-500">
          {spent.length} earlier link{spent.length === 1 ? " has" : "s have"} expired or been withdrawn.
        </p>
      )}
    </section>
  );
}
