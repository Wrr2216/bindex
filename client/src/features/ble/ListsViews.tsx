import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { bleApi } from "./api";
import { ago, ALERT_LABELS, BLE_KIND_LABELS, shortIdentity } from "./format";
import type { BatteryRow, BleAlert, QuietTag } from "./types";

const HOUR_CHOICES = [1, 4, 24, 72, 168];

const TABLE = "w-full text-left text-sm";
const TH = "px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-400";
const TD = "px-3 py-2 align-top text-slate-300";

function Failed({ message }: { message: string }) {
  return <p className="text-sm text-red-400">{message}</p>;
}

/** Tagged equipment no gateway has heard for a while, longest silent first. */
export function NotSeenView() {
  const terms = useTerms();
  const [hours, setHours] = useState(24);
  const [tags, setTags] = useState<QuietTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTags(null);
    bleApi
      .notSeen(hours)
      .then(setTags)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load."));
  }, [hours]);

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-slate-300">
        Not heard for
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
        >
          {HOUR_CHOICES.map((h) => (
            <option key={h} value={h}>
              {h < 24 ? `${h} hour${h === 1 ? "" : "s"}` : `${h / 24} day${h === 24 ? "" : "s"}`}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <Failed message={error} />
      ) : !tags ? (
        <p className="py-6 text-center text-slate-500">Loading…</p>
      ) : !tags.length ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
          Every tag has been heard in that time.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
          <table className={TABLE}>
            <thead className="border-b border-slate-800">
              <tr>
                <th className={TH}>{terms.item.singular}</th>
                <th className={TH}>Last heard</th>
                <th className={TH}>Last {terms.location.singular.toLowerCase()}</th>
                <th className={TH}>Battery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {tags.map((t) => (
                <tr key={t.tagKey}>
                  <td className={TD}>
                    {t.itemId ? (
                      <Link to={`/items/${t.itemId}`} className="text-sky-300 hover:underline">
                        {t.itemName ?? terms.item.singular}
                      </Link>
                    ) : (
                      <span>{t.tagName ?? shortIdentity(t.identity)}</span>
                    )}
                    {t.missingSince && (
                      <span className="ml-2 rounded-full bg-amber-950 px-2 py-0.5 text-xs text-amber-300">Missing</span>
                    )}
                  </td>
                  <td className={TD} title={t.lastHeardAt ? new Date(t.lastHeardAt).toLocaleString() : undefined}>
                    {t.lastHeardAt ? ago(t.lastHeardAt) : "Never"}
                  </td>
                  <td className={TD}>
                    {t.locationId ? (
                      <Link to={`/locations/${t.locationId}`} className="hover:underline">
                        {t.locationName}
                      </Link>
                    ) : (
                      <span className="text-slate-500">Unknown</span>
                    )}
                  </td>
                  <td className={TD}>{t.batteryPct !== null ? `${t.batteryPct}%` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Tags, beacons and gateways whose batteries need replacing. */
export function BatteryView() {
  const terms = useTerms();
  const [data, setData] = useState<{ below: number; devices: BatteryRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bleApi
      .battery()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load."));
  }, []);

  if (error) return <Failed message={error} />;
  if (!data) return <p className="py-6 text-center text-slate-500">Loading…</p>;
  if (!data.devices.length) {
    return (
      <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
        No battery is at or below {data.below}%.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
      <table className={TABLE}>
        <thead className="border-b border-slate-800">
          <tr>
            <th className={TH}>Device</th>
            <th className={TH}>Battery</th>
            <th className={TH}>On or in</th>
            <th className={TH}>Last heard</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {data.devices.map((d) => (
            <tr key={d.id}>
              <td className={TD}>
                <span className="text-slate-100">{d.name}</span>
                <span className="block text-xs text-slate-500">{BLE_KIND_LABELS[d.kind]}</span>
              </td>
              <td className={`${TD} ${d.batteryPct <= 10 ? "text-red-400" : "text-amber-400"}`}>
                {d.batteryPct}%{d.batteryMv ? <span className="block text-xs text-slate-500">{d.batteryMv} mV</span> : null}
              </td>
              <td className={TD}>
                {d.itemId ? (
                  <Link to={`/items/${d.itemId}`} className="text-sky-300 hover:underline">
                    {d.itemName ?? terms.item.singular}
                  </Link>
                ) : d.locationId ? (
                  <Link to={`/locations/${d.locationId}`} className="hover:underline">
                    {d.locationName}
                  </Link>
                ) : null}
              </td>
              <td className={TD}>{ago(d.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function describe(a: BleAlert): string {
  const d = a.detail;
  const what = str(d.itemName) ?? str(d.tagName) ?? str(d.name) ?? (shortIdentity(str(d.identity)) || "A tag");
  switch (a.kind) {
    case "missing":
      return `${what} not heard for ${Math.round(Number(d.minutes) || 0)} min${str(d.locationName) ? `, last in ${d.locationName}` : ""}`;
    case "after_hours_move":
      return `${what} moved ${str(d.fromName) ? `from ${d.fromName} ` : ""}to ${str(d.toName) ?? "another room"}`;
    case "battery_low":
      return `${what}: battery at ${Number(d.batteryPct)}%`;
  }
}

/** Open alerts and recent history. */
export function AlertsView() {
  const [openOnly, setOpenOnly] = useState(true);
  const [alerts, setAlerts] = useState<BleAlert[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (before?: number) =>
      bleApi
        .alerts({ open: openOnly, before })
        .then((r) => {
          setAlerts((prev) => (before && prev ? [...prev, ...r.alerts] : r.alerts));
          setNext(r.next);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Could not load alerts.")),
    [openOnly],
  );

  useEffect(() => {
    setAlerts(null);
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
        Only what still needs attention
      </label>
      {error ? (
        <Failed message={error} />
      ) : !alerts ? (
        <p className="py-6 text-center text-slate-500">Loading…</p>
      ) : !alerts.length ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
          {openOnly ? "Nothing needs attention." : "No alerts yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {alerts.map((a) => (
            <li key={a.id} className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-slate-100">
                  <span
                    className={`mr-2 rounded-full px-2 py-0.5 text-xs ${
                      a.resolvedAt ? "bg-slate-800 text-slate-400" : "bg-amber-950 text-amber-300"
                    }`}
                  >
                    {ALERT_LABELS[a.kind]}
                    {a.resolvedAt ? ", resolved" : ""}
                  </span>
                  {a.itemId ? (
                    <Link to={`/items/${a.itemId}`} className="hover:underline">
                      {describe(a)}
                    </Link>
                  ) : (
                    describe(a)
                  )}
                </span>
                <span className="text-xs text-slate-500" title={new Date(a.createdAt).toLocaleString()}>
                  {ago(a.createdAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button
          onClick={() => void load(next)}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          Older alerts
        </button>
      )}
    </div>
  );
}
