import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useConfig, useMoney } from "../config/useConfig";
import type { Breakdown, Stats } from "../types";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-100">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function BreakdownList({
  title,
  rows,
  showValue,
}: {
  title: string;
  rows: Breakdown[];
  showValue?: boolean;
}) {
  const money = useMoney();
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No data.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.name}>
              <div className="flex items-center justify-between text-sm">
                <span className="truncate text-slate-200">{r.name}</span>
                <span className="ml-2 shrink-0 text-slate-400">
                  {r.count}
                  {showValue && r.valueCents > 0 && (
                    <span className="ml-2 text-slate-500">{money(r.valueCents)}</span>
                  )}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-slate-800">
                <div
                  className="h-1.5 rounded-full bg-sky-600"
                  style={{ width: `${Math.round((r.count / max) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Dashboard() {
  const { config } = useConfig();
  const { terms, features } = config;
  const money = useMoney();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.stats().then(setStats).catch(() => setStats(null));
  }, []);

  if (!stats) return <p className="py-10 text-center text-slate-500">Loading…</p>;

  const attention = stats.noLocation + stats.noValue;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Dashboard</h1>
        <a
          href={api.itemsCsvUrl()}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Export CSV
        </a>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={terms.item.plural} value={String(stats.items)} />
        <Stat label="Total value" value={money(stats.valueCents)} />
        <Stat label="Checked out" value={String(stats.checkedOut)} />
        <Stat
          label="Needs attention"
          value={String(attention)}
          hint={`${stats.noLocation} with no ${terms.location.singular.toLowerCase()} · ${stats.noValue} with no value`}
        />
      </div>

      {features.domains && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Digital assets
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Digital items" value={String(stats.digitalItems)} />
            <Stat label="Digital value" value={money(stats.digitalValueCents)} />
          </div>
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {features.groups && (
          <BreakdownList title={`By ${terms.group.singular.toLowerCase()}`} rows={stats.byCompany} showValue />
        )}
        <BreakdownList
          title={`By ${terms.location.singular.toLowerCase()}`}
          rows={stats.byLocation}
          showValue
        />
        {features.holders && (
          <BreakdownList
            title={`Checked out, by ${terms.holder.singular.toLowerCase()}`}
            rows={stats.byEntity}
            showValue
          />
        )}
        <BreakdownList
          title="By status"
          rows={stats.byStatus.map((s) => ({ ...s, valueCents: 0 }))}
        />
        <BreakdownList
          title="Top categories"
          rows={stats.byCategory.map((c) => ({ ...c, valueCents: 0 }))}
        />
        <BreakdownList
          title="Digital categories"
          rows={stats.byDigitalCategory.map((c) => ({ ...c, valueCents: 0 }))}
        />
      </div>

      <p className="text-sm text-slate-500">
        <Link to="/items" className="text-sky-400 hover:underline">
          Browse everything
        </Link>
      </p>
    </div>
  );
}
