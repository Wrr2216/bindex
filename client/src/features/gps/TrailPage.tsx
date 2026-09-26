import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import L from "leaflet";
import { useTerms } from "../../config/useConfig";
import { BUTTON_QUIET, FIELD } from "../../components/ui";
import { gpsApi } from "./api";
import { dateTime, distance, errorText, fromLocalInput, speed, time, toLocalInput } from "./format";
import { GpsNav } from "./GpsNav";
import { MAP_CLASS, fitTo, text, useLayer, useLeafletMap, useMapConfig } from "./map";
import type { GeofenceEvent, TrailPoint } from "./types";

const HOUR = 60 * 60_000;

/**
 * Where a tracker, or an item, has been: its fixes as a line, with a slider
 * that walks along them in time. Fixes the tracker reported but that were not
 * believed (jumps, invalid) can be shown as red dots, to see why a trail looks
 * the way it does.
 */
export function TrailPage() {
  const { id = "" } = useParams();
  const isItem = useLocation().pathname.startsWith("/gps/items/");
  const terms = useTerms();
  const { config, error: configError } = useMapConfig();
  const { ref, map } = useLeafletMap(config);
  const [from, setFrom] = useState(() => toLocalInput(new Date(Date.now() - (isItem ? 7 * 24 : 24) * HOUR)));
  const [to, setTo] = useState("");
  const [showRejected, setShowRejected] = useState(false);
  const [title, setTitle] = useState<{ name: string; itemId: string | null; itemName: string | null } | null>(null);
  const [points, setPoints] = useState<TrailPoint[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [events, setEvents] = useState<GeofenceEvent[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fitKey = useRef("");

  const load = useCallback(async () => {
    setError(null);
    const range = { from: fromLocalInput(from), to: fromLocalInput(to), rejected: showRejected, limit: 5000 };
    try {
      if (isItem) {
        const trail = await gpsApi.itemTrail(id, range);
        setPoints(trail.points);
        setTruncated(trail.truncated);
        setTitle(null);
        setEvents((await gpsApi.events({ itemId: id, limit: 50 })).events);
      } else {
        const trail = await gpsApi.trackerTrail(id, range);
        setPoints(trail.points);
        setTruncated(trail.truncated);
        setTitle(trail.tracker);
        setEvents((await gpsApi.events({ deviceId: id, limit: 50 })).events);
      }
    } catch (err) {
      setError(errorText(err, "Could not load the trail."));
      setPoints([]);
    }
  }, [id, isItem, from, to, showRejected]);

  useEffect(() => {
    void load();
  }, [load]);

  const good = useMemo(() => (points ?? []).filter((p) => !p.rejected), [points]);
  const rejected = useMemo(() => (points ?? []).filter((p) => p.rejected), [points]);
  const current = good[Math.min(index, good.length - 1)];

  useEffect(() => setIndex(Math.max(0, good.length - 1)), [good]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setIndex((i) => {
        if (i >= good.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 250);
    return () => clearInterval(timer);
  }, [playing, good.length]);

  // The whole trail, dimmed, and the part up to the slider, bright.
  useLayer(
    map,
    (group, m) => {
      const line = good.map((p) => [p.lat, p.lng] as L.LatLngTuple);
      if (line.length > 1) L.polyline(line, { color: "#64748b", weight: 3, opacity: 0.6 }).addTo(group);
      for (const p of rejected) {
        L.circleMarker([p.lat, p.lng], { radius: 4, color: "#ef4444", weight: 1, fillOpacity: 0.7 })
          .bindTooltip(text(`Not believed: ${p.rejected}`, dateTime(p.at)))
          .addTo(group);
      }
      for (const e of events) {
        if (e.lat === null || e.lng === null) continue;
        L.circleMarker([e.lat, e.lng], {
          radius: 5,
          color: e.kind === "entered" ? "#10b981" : "#f59e0b",
          weight: 2,
          fillOpacity: 0.2,
        })
          .bindTooltip(text(`${e.kind === "entered" ? "Entered" : "Left"} ${e.geofenceName}`, dateTime(e.occurredAt)))
          .addTo(group);
      }
      const key = `${id}|${good.length}|${good[0]?.id ?? ""}`;
      if (fitKey.current !== key && line.length) {
        fitKey.current = key;
        fitTo(m, line);
      }
    },
    [good, rejected, events],
  );

  useLayer(
    map,
    (group) => {
      if (!current) return;
      const upto = good.slice(0, index + 1).map((p) => [p.lat, p.lng] as L.LatLngTuple);
      if (upto.length > 1) L.polyline(upto, { color: "#0ea5e9", weight: 4 }).addTo(group);
      if (current.accuracyM) {
        L.circle([current.lat, current.lng], { radius: current.accuracyM, color: "#38bdf8", weight: 1, fillOpacity: 0.08 }).addTo(group);
      }
      L.circleMarker([current.lat, current.lng], { radius: 8, color: "#0f172a", weight: 2, fillColor: "#0ea5e9", fillOpacity: 1 })
        .bindTooltip(text(dateTime(current.at)))
        .addTo(group);
    },
    [good, index],
  );

  const length = useMemo(() => {
    let m = 0;
    for (let i = 1; i < good.length; i++) m += L.latLng(good[i - 1]!.lat, good[i - 1]!.lng).distanceTo([good[i]!.lat, good[i]!.lng]);
    return m;
  }, [good]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">
            {isItem ? `Where this ${terms.item.singular.toLowerCase()} has been` : (title?.name ?? "Tracker")}
          </h1>
          {title?.itemId && (
            <p className="text-sm text-slate-400">
              On{" "}
              <Link to={`/items/${title.itemId}`} className="text-sky-400 hover:underline">
                {title.itemName ?? terms.item.singular}
              </Link>
            </p>
          )}
          {isItem && (
            <Link to={`/items/${id}`} className="text-sm text-sky-400 hover:underline">
              Back to the {terms.item.singular.toLowerCase()}
            </Link>
          )}
        </div>
        <GpsNav />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-300">
          From
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-sm text-slate-300">
          To
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        {!isItem && (
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-300">
            <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />
            Show fixes that were not believed
          </label>
        )}
      </div>

      {(configError || error) && <p className="text-sm text-red-400">{configError ?? error}</p>}
      {truncated && <p className="text-sm text-amber-400">Showing the latest 5,000 fixes. Narrow the time range to see the rest.</p>}

      <div ref={ref} className={MAP_CLASS} role="region" aria-label="Trail map" />

      {points !== null && good.length === 0 && (
        <p className="text-sm text-slate-400">No positions in this time range.</p>
      )}
      {current && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => setPlaying((p) => !p)} className={BUTTON_QUIET}>
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, good.length - 1)}
              value={Math.min(index, good.length - 1)}
              onChange={(e) => {
                setPlaying(false);
                setIndex(Number(e.target.value));
              }}
              aria-label="Time along the trail"
              className="min-w-48 flex-1"
            />
            <span className="text-sm text-slate-300">{dateTime(current.at)}</span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase text-slate-500">Speed</dt>
              <dd className="text-slate-200">{current.speedMps === null ? "Not reported" : speed(current.speedMps)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-500">Accuracy</dt>
              <dd className="text-slate-200">{current.accuracyM === null ? "Not reported" : `± ${Math.round(current.accuracyM)} m`}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-500">Fixes</dt>
              <dd className="text-slate-200">
                {index + 1} of {good.length}
                {rejected.length > 0 && <span className="text-red-400"> · {rejected.length} not believed</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-500">Distance</dt>
              <dd className="text-slate-200">{distance(length)}</dd>
            </div>
          </dl>
          {current.outOfOrder && <p className="mt-2 text-xs text-slate-500">This fix arrived late and is shown in its place in time.</p>}
        </div>
      )}

      {events.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Geofence crossings</h2>
          <ul className="mt-2 divide-y divide-slate-800 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span className={e.kind === "entered" ? "text-emerald-400" : "text-amber-400"}>
                  {e.kind === "entered" ? "Entered" : "Left"} {e.geofenceName}
                </span>
                <span className="text-slate-400">
                  {new Date(e.occurredAt).toLocaleDateString()} {time(e.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
