import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import L from "leaflet";
import { useTerms } from "../../config/useConfig";
import { ago } from "../tracking-core/format";
import { gpsApi } from "./api";
import { STATUS_LABELS, errorText } from "./format";
import { GpsNav } from "./GpsNav";
import {
  MAP_CLASS,
  STATUS_COLORS,
  fenceBounds,
  fenceLayer,
  fitTo,
  text,
  useLayer,
  useLeafletMap,
  useMapConfig,
} from "./map";
import type { Geofence, Tracker } from "./types";

/** How often the live map asks for new positions. */
const REFRESH_MS = 15_000;

const position = (t: Tracker): [number, number] | null => {
  const lat = t.lastFixLat ?? t.lastLat;
  const lng = t.lastFixLng ?? t.lastLng;
  return lat !== null && lng !== null ? [lat, lng] : null;
};

/** Every tracker where it last reported, with the geofences, refreshed every few seconds. */
export function GpsMapPage() {
  const terms = useTerms();
  const { config, error: configError } = useMapConfig();
  const { ref, map } = useLeafletMap(config);
  const [trackers, setTrackers] = useState<Tracker[] | null>(null);
  const [fences, setFences] = useState<Geofence[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fitted = useRef(false);

  const load = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([gpsApi.trackers(), gpsApi.geofences()]);
      setTrackers(t);
      setFences(f);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load trackers."));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => (trackers ?? []).filter((t) => t.status !== "disposed" && !t.gps.relay), [trackers]);

  useLayer(
    map,
    (group) => {
      for (const f of fences) {
        fenceLayer(f).bindTooltip(text(f.name, f.locationName)).addTo(group);
      }
    },
    [fences],
  );

  useLayer(
    map,
    (group, m) => {
      const drawn: L.LatLng[] = [];
      for (const t of visible) {
        const at = position(t);
        if (!at) continue;
        const marker = L.circleMarker(at, {
          radius: t.id === selected ? 10 : 7,
          color: "#0f172a",
          weight: 2,
          fillColor: t.stale ? "#94a3b8" : STATUS_COLORS[t.status],
          fillOpacity: 0.95,
        })
          .bindTooltip(text(t.name, t.itemName, `Last fix ${ago(t.lastFixAt ?? t.lastSeenAt).toLowerCase()}`))
          .on("click", () => setSelected(t.id))
          .addTo(group);
        if (t.lastAccuracyM && t.id === selected) {
          L.circle(at, { radius: t.lastAccuracyM, color: "#38bdf8", weight: 1, fillOpacity: 0.08 }).addTo(group);
        }
        drawn.push(marker.getLatLng());
      }
      if (!fitted.current && trackers !== null) {
        fitted.current = true;
        fitTo(m, drawn.length ? drawn : fences.map(fenceBounds), 14);
      }
    },
    [visible, selected, trackers !== null],
  );

  useEffect(() => {
    const t = visible.find((v) => v.id === selected);
    const at = t && position(t);
    if (map && at) map.panTo(at);
  }, [map, selected, visible]);

  const lowBattery = visible.filter((t) => t.batteryLow);
  const awaiting = visible.filter((t) => t.status === "awaiting_return");
  const silent = visible.filter((t) => t.stale);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Map</h1>
        <GpsNav />
      </div>

      {(configError || error) && <p className="text-sm text-red-400">{configError ?? error}</p>}
      {(lowBattery.length > 0 || awaiting.length > 0 || silent.length > 0) && (
        <div className="flex flex-wrap gap-2 text-sm">
          {lowBattery.length > 0 && (
            <span className="rounded-full bg-amber-950 px-3 py-1 text-amber-300">
              {lowBattery.length} with a low battery
            </span>
          )}
          {awaiting.length > 0 && (
            <Link to="/gps/trackers" className="rounded-full bg-amber-950 px-3 py-1 text-amber-300 hover:underline">
              {awaiting.length} waiting to be returned
            </Link>
          )}
          {silent.length > 0 && (
            <span className="rounded-full bg-slate-800 px-3 py-1 text-slate-300">
              {silent.length} silent for over an hour
            </span>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div ref={ref} className={MAP_CLASS} role="region" aria-label="Map of trackers" />
        <div className="space-y-2">
          {trackers === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
              No GPS trackers yet. Add one in <Link to="/settings/devices" className="text-sky-400 hover:underline">Readers and devices</Link>{" "}
              as a GPS tracker, then point it at this server (see <Link to="/gps/trackers" className="text-sky-400 hover:underline">Trackers</Link>).
            </p>
          ) : (
            <ul className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
              {visible.map((t) => {
                const shipment = t.links.find((l) => l.shipmentId);
                const vehicle = t.links.find((l) => l.vehicleLocationId);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(t.id)}
                      className={`w-full rounded-xl border p-3 text-left ${
                        t.id === selected ? "border-sky-700 bg-slate-800" : "border-slate-800 bg-slate-900 hover:bg-slate-800/60"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: t.stale ? "#94a3b8" : STATUS_COLORS[t.status] }}
                          aria-hidden
                        />
                        <span className="truncate font-medium text-slate-100">{t.name}</span>
                      </span>
                      {t.itemName && <span className="mt-0.5 block truncate text-xs text-slate-400">{t.itemName}</span>}
                      <span className="mt-1 block text-xs text-slate-500">
                        {position(t) ? `Fix ${ago(t.lastFixAt ?? t.lastSeenAt).toLowerCase()}` : "No position yet"}
                        {t.batteryPct !== null && (
                          <span className={t.batteryLow ? "text-amber-400" : undefined}> · {t.batteryPct}%</span>
                        )}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {shipment
                          ? `${shipment.shipmentCode} ${shipment.shipmentName ?? ""}`
                          : vehicle
                            ? `In ${vehicle.vehicleName ?? terms.location.singular.toLowerCase()}`
                            : STATUS_LABELS[t.status]}
                      </span>
                    </button>
                    {t.id === selected && (
                      <div className="mt-1 flex flex-wrap gap-2 px-1 text-xs">
                        <Link to={`/gps/trackers/${t.id}`} className="text-sky-400 hover:underline">
                          Trail
                        </Link>
                        {t.itemId && (
                          <Link to={`/items/${t.itemId}`} className="text-sky-400 hover:underline">
                            {terms.item.singular}
                          </Link>
                        )}
                        {config?.jobs && shipment?.shipmentId && (
                          <Link to={`/gps/shipments/${shipment.shipmentId}`} className="text-sky-400 hover:underline">
                            Shipment map
                          </Link>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
