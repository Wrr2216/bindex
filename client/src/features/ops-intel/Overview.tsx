import { useCallback, useEffect, useState } from "react";
import { AnomalyQueue } from "./AnomalyQueue";
import { opsApi } from "./api";
import { TrendChart } from "./TrendChart";
import type { OpsMeta, OpsSummary, RuleId } from "./types";
import { BTN, CARD, H2, Notice, SeverityIcon, StatTile, ago, errorText, fmtDateTime } from "./ui";

/** Counts, the trend, what the rules are finding, and the queue to work through. */
export function Overview({ meta }: { meta: OpsMeta | null }) {
  const [summary, setSummary] = useState<OpsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [queueKey, setQueueKey] = useState(0);

  const load = useCallback(
    () =>
      opsApi
        .summary(30)
        .then((s) => {
          setSummary(s);
          setError(null);
        })
        .catch((err) => setError(errorText(err, "The summary could not be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const r = await opsApi.run();
      const failed = Object.entries(r.byRule).filter(([, s]) => s?.error);
      setMessage(
        `Checked: ${r.opened} new, ${r.cleared} cleared.` +
          (failed.length ? ` Rules that could not run: ${failed.map(([k]) => title(k)).join(", ")}.` : ""),
      );
      await load();
      setQueueKey((k) => k + 1);
    } catch (err) {
      setMessage(errorText(err, "The rules could not run."));
    } finally {
      setRunning(false);
    }
  };

  const title = (rule: string) => meta?.rules.find((r) => r.rule === rule)?.title ?? rule;
  const byRule = Object.entries(summary?.open.byRule ?? {})
    .map(([rule, n]) => ({ rule: rule as RuleId, n: n ?? 0 }))
    .sort((a, b) => b.n - a.n);
  const maxRule = Math.max(1, ...byRule.map((r) => r.n));
  const last = summary?.lastRun;

  return (
    <div className="space-y-5">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Open"
          value={summary ? summary.open.total.toLocaleString() : "…"}
          hint={summary?.oldestOpenAt ? `oldest ${ago(summary.oldestOpenAt)}` : "nothing waiting"}
        />
        <StatTile label="High" icon={<SeverityIcon severity="high" />} value={summary ? String(summary.open.bySeverity.high) : "…"} />
        <StatTile label="Medium" icon={<SeverityIcon severity="medium" />} value={summary ? String(summary.open.bySeverity.medium) : "…"} />
        <StatTile label="Low" icon={<SeverityIcon severity="low" />} value={summary ? String(summary.open.bySeverity.low) : "…"} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={run} disabled={running} className={BTN}>
          {running ? "Checking…" : "Run now"}
        </button>
        <span className="text-xs text-slate-500">
          {last
            ? `Last run ${ago(last.startedAt)} (${last.trigger === "manual" ? "by hand" : "scheduled"}, ${fmtDateTime(last.startedAt)}): ${last.opened} opened, ${last.cleared} cleared${last.error ? `. ${last.error}` : ""}`
            : "The rules have not run yet."}
        </span>
      </div>
      {message && <Notice tone="info">{message}</Notice>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className={`${CARD} min-w-0 lg:col-span-2`}>
          {summary ? <TrendChart data={summary.trend} title="Anomalies, last 30 days" /> : <p className="text-sm text-slate-500">Loading…</p>}
        </div>
        <section className={`${CARD} min-w-0 space-y-2`}>
          <h2 className={H2}>Open, by rule</h2>
          {byRule.length === 0 && <p className="text-sm text-slate-500">None open.</p>}
          <ul className="space-y-2">
            {byRule.map((r) => (
              <li key={r.rule}>
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate text-slate-200">{title(r.rule)}</span>
                  <span className="ml-2 shrink-0 tabular-nums text-slate-400">{r.n}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-800">
                  <div className="h-1.5 rounded-full bg-sky-600" style={{ width: `${Math.round((r.n / maxRule) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <AnomalyQueue key={queueKey} meta={meta} onChanged={() => void load()} />
    </div>
  );
}
