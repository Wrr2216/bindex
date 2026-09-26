import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { trackingApi } from "./api";
import { DIRECTION_LABELS, KIND_LABELS, TECH_LABELS } from "./format";
import type { Sighting, TrackingDevice } from "./types";

const POLL_MS = 1000;
const KEEP = 300;

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Sightings as they arrive, across devices or for one. Built for
 * commissioning: walk a tagged pallet through a portal and watch the zone and
 * direction it produces.
 */
export function LiveReads() {
  const { user } = useAuth();
  const terms = useTerms();
  const [params, setParams] = useSearchParams();
  const deviceId = params.get("device") ?? "";
  const [devices, setDevices] = useState<TrackingDevice[]>([]);
  const [rows, setRows] = useState<Sighting[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState({ reads: 0, matched: 0, in: 0, out: 0 });
  const cursor = useRef<number | undefined>(undefined);

  useEffect(() => {
    trackingApi.listDevices().then(setDevices).catch(() => undefined);
  }, []);

  // Start over whenever the filter changes.
  useEffect(() => {
    cursor.current = undefined;
    setRows([]);
    setCounts({ reads: 0, matched: 0, in: 0, out: 0 });
  }, [deviceId]);

  useEffect(() => {
    if (paused) return;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const first = cursor.current === undefined;
        const page = await trackingApi.feed({
          since: cursor.current,
          deviceId: deviceId || undefined,
          limit: first ? 100 : 500,
        });
        if (stopped) return;
        cursor.current = page.cursor;
        setError(null);
        if (!page.sightings.length) return;
        const fresh = [...page.sightings].reverse();
        setRows((prev) => [...fresh, ...prev].slice(0, KEEP));
        // Only reads that arrive while watching count, not the backlog.
        if (!first) {
          setCounts((c) => ({
            reads: c.reads + fresh.length,
            matched: c.matched + fresh.filter((s) => s.itemId).length,
            in: c.in + fresh.filter((s) => s.direction === "in").length,
            out: c.out + fresh.filter((s) => s.direction === "out").length,
          }));
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : "Lost the feed; retrying.");
      } finally {
        busy = false;
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [paused, deviceId]);

  const byId = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Live reads</h1>
          <p className="text-sm text-slate-400">
            What readers, portals and trackers report, as it arrives. Repeats of the same tag within a few
            seconds are stored once.
          </p>
        </div>
        {user?.role === "admin" && (
          <Link
            to="/settings/devices"
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            Readers and devices
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={deviceId}
          onChange={(e) => setParams(e.target.value ? { device: e.target.value } : {})}
          aria-label="Device"
          className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 sm:w-auto"
        >
          <option value="">All devices</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({KIND_LABELS[d.kind]})
            </option>
          ))}
        </select>
        <button
          onClick={() => setPaused((p) => !p)}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          onClick={() => {
            setRows([]);
            setCounts({ reads: 0, matched: 0, in: 0, out: 0 });
          }}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Clear
        </button>
        {!paused && <span className="animate-pulse text-xs text-sky-300">Listening…</span>}
      </div>

      <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
        {[
          { label: "Reads since opened", value: counts.reads, tone: "text-slate-200" },
          { label: `Matched to ${terms.item.plural.toLowerCase()}`, value: counts.matched, tone: "text-emerald-400" },
          { label: "Passed in", value: counts.in, tone: "text-sky-300" },
          { label: "Passed out", value: counts.out, tone: "text-amber-300" },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <p className={`text-2xl font-semibold ${c.tone}`}>{c.value}</p>
            <p className="text-xs text-slate-400">{c.label}</p>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-amber-300">{error}</p>}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
          Nothing yet. Reads appear here within a second of a device posting them.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Device</th>
                <th className="px-3 py-2 font-medium">Tag</th>
                <th className="px-3 py-2 font-medium">{terms.item.singular}</th>
                <th className="px-3 py-2 font-medium">Zone</th>
                <th className="px-3 py-2 font-medium">Way</th>
                <th className="px-3 py-2 font-medium">Ant.</th>
                <th className="px-3 py-2 font-medium">RSSI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-t border-slate-800/70">
                  <td className="whitespace-nowrap px-3 py-1.5 text-slate-400" title={new Date(s.observedAt).toLocaleString()}>
                    {time(s.observedAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-slate-300">
                    {s.deviceName ?? (s.deviceId ? byId.get(s.deviceId)?.name : null) ?? "Unknown"}
                    <span className="ml-1 text-xs text-slate-500">{TECH_LABELS[s.tech]}</span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-400">{s.code ?? "Own position"}</td>
                  <td className="px-3 py-1.5">
                    {s.itemId ? (
                      <Link to={`/items/${s.itemId}`} className="text-sky-400 hover:underline">
                        {s.itemName}
                        {s.unitLabel || s.unitAssetCode ? ` (${s.unitLabel || s.unitAssetCode})` : ""}
                      </Link>
                    ) : (
                      <span className="text-slate-500">Unknown tag</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-slate-300">
                    {s.locationId ? (
                      <Link to={`/locations/${s.locationId}`} className="hover:underline">
                        {s.locationName}
                      </Link>
                    ) : (
                      <span className="text-slate-600">–</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {s.direction ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          s.direction === "in" ? "bg-sky-950 text-sky-300" : "bg-amber-950 text-amber-300"
                        }`}
                      >
                        {DIRECTION_LABELS[s.direction]}
                      </span>
                    ) : (
                      <span className="text-slate-600">–</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-slate-400">{s.antenna ?? "–"}</td>
                  <td className="px-3 py-1.5 text-slate-400">{s.rssi === null ? "–" : Math.round(s.rssi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
