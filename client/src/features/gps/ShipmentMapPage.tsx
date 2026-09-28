import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import L from "leaflet";
import { ApiError } from "../../api/client";
import { BUTTON, BUTTON_QUIET, FIELD } from "../../components/ui";
import { jobsApi } from "../jobs-core/api";
import type { ShipmentStatus } from "../jobs-core/types";
import { ago } from "../tracking-core/format";
import { gpsApi } from "./api";
import { dateTime, distance, errorText, speed } from "./format";
import { GpsNav } from "./GpsNav";
import { MAP_CLASS, fenceBounds, fenceLayer, fitTo, text, useLayer, useLeafletMap, useMapConfig } from "./map";
import type { ShipmentMap, Tracker } from "./types";

const TRAIL_COLORS = ["#0ea5e9", "#a855f7", "#f97316", "#10b981"];
const REFRESH_MS = 30_000;

/**
 * One shipment on the map: its origin and destination fences, where its
 * trackers have taken it, how far it has come and has to go, and the status
 * change the trackers suggest (in transit on leaving, delivered on arrival).
 */
export function ShipmentMapPage() {
  const { id = "" } = useParams();
  const { config, error: configError } = useMapConfig();
  const { ref, map } = useLeafletMap(config);
  const [data, setData] = useState<ShipmentMap | null>(null);
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsReason, setNeedsReason] = useState<{ status: ShipmentStatus; message: string } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const fitted = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await gpsApi.shipment(id));
      setError(null);
    } catch (err) {
      setError(errorText(err, "This shipment could not be loaded."));
    }
  }, [id]);

  useEffect(() => {
    void load();
    gpsApi.trackers().then(setTrackers).catch(() => undefined);
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useLayer(
    map,
    (group, m) => {
      if (!data) return;
      const bounds: (L.LatLngBounds | L.LatLngExpression)[] = [];
      for (const [fence, label] of [
        [data.origin, "Origin"],
        [data.destination, "Destination"],
      ] as const) {
        if (!fence) continue;
        fenceLayer(fence, { color: label === "Origin" ? "#64748b" : "#10b981" })
          .bindTooltip(text(`${label}: ${fence.name}`))
          .addTo(group);
        bounds.push(fenceBounds(fence));
      }
      data.trails.forEach((trail, i) => {
        const line = trail.points.map((p) => [p.lat, p.lng] as L.LatLngTuple);
        if (line.length > 1) {
          L.polyline(line, { color: TRAIL_COLORS[i % TRAIL_COLORS.length], weight: 4 })
            .bindTooltip(text(trail.deviceName ?? "Tracker"))
            .addTo(group);
        }
        const last = trail.points[trail.points.length - 1];
        if (last) {
          L.circleMarker([last.lat, last.lng], {
            radius: 8,
            color: "#0f172a",
            weight: 2,
            fillColor: TRAIL_COLORS[i % TRAIL_COLORS.length],
            fillOpacity: 1,
          })
            .bindTooltip(text(trail.deviceName ?? "Tracker", dateTime(last.at)))
            .addTo(group);
        }
        bounds.push(...line);
      });
      for (const e of data.events) {
        if (e.lat === null || e.lng === null) continue;
        L.circleMarker([e.lat, e.lng], { radius: 5, color: e.kind === "entered" ? "#10b981" : "#f59e0b", weight: 2, fillOpacity: 0.3 })
          .bindTooltip(text(`${e.kind === "entered" ? "Entered" : "Left"} ${e.geofenceName}`, dateTime(e.occurredAt)))
          .addTo(group);
      }
      if (!fitted.current && bounds.length) {
        fitted.current = true;
        fitTo(m, bounds, 15);
      }
    },
    [data],
  );

  const setStatus = async (status: ShipmentStatus, force = false) => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      await jobsApi.setShipmentStatus(data.shipment.id, status, force, force ? reason : undefined);
      setNeedsReason(null);
      setReason("");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !force) setNeedsReason({ status, message: err.message });
      else setError(errorText(err, "Could not change the status."));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    if (!data) return;
    try {
      await gpsApi.dismissPrompt(data.shipment.id);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not dismiss that."));
    }
  };

  const assign = async () => {
    if (!data || !pick) return;
    try {
      await gpsApi.createLink({ deviceId: pick, shipmentId: data.shipment.id });
      setPick("");
      fitted.current = false;
      await load();
      setTrackers(await gpsApi.trackers());
    } catch (err) {
      setError(errorText(err, "Could not put the tracker on."));
    }
  };

  const takeOff = async (linkId: string) => {
    try {
      await gpsApi.endLink(linkId);
      await load();
      setTrackers(await gpsApi.trackers());
    } catch (err) {
      setError(errorText(err, "Could not take the tracker off."));
    }
  };

  const s = data?.shipment;
  const gps = data?.gps;
  const open = s && s.status !== "delivered" && s.status !== "closed";
  const available = trackers.filter((t) => t.status === "available" && !t.gps.relay && !t.disabled);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">
            {s ? `${s.code} ${s.name}` : "Shipment"}
            {s && <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-sm text-slate-300">{s.status.replace(/_/g, " ")}</span>}
          </h1>
          {s && (
            <p className="text-sm text-slate-400">
              <Link to={`/shipments/${s.id}`} className="text-sky-400 hover:underline">
                Shipment page
              </Link>{" "}
              ·{" "}
              <Link to={`/jobs/${s.jobId}`} className="text-sky-400 hover:underline">
                {s.jobCode} {s.jobName}
              </Link>
              {s.vehicleName && <> · on {s.vehicleName}</>}
            </p>
          )}
        </div>
        <GpsNav />
      </div>

      {(configError || error) && <p className="text-sm text-red-400">{configError ?? error}</p>}

      {gps?.prompt && open && (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/40 p-4 text-sm" role="status">
          {gps.prompt.status === "delivered" ? (
            <p className="text-emerald-200">
              A tracker entered {gps.destinationName ?? "the destination"} at {dateTime(gps.prompt.at)}. Confirm the
              delivery once it is unloaded.
            </p>
          ) : (
            <p className="text-amber-200">
              A tracker left {gps.originName ?? "the origin"} at {dateTime(gps.prompt.at)}, but the shipment could not be
              put in transit: {gps.prompt.reason}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void setStatus(gps.prompt!.status as ShipmentStatus)}
              className={BUTTON}
            >
              {gps.prompt.status === "delivered" ? "Mark delivered" : "Mark in transit"}
            </button>
            <button type="button" onClick={() => void dismiss()} className={BUTTON_QUIET}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {needsReason && (
        <div className="rounded-xl border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-200">
          <p>{needsReason.message}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why" className={`${FIELD} max-w-sm`} />
            <button type="button" disabled={!reason.trim() || busy} onClick={() => void setStatus(needsReason.status, true)} className={BUTTON}>
              Force it
            </button>
            <button type="button" onClick={() => setNeedsReason(null)} className={BUTTON_QUIET}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {gps && (
        <dl className="grid grid-cols-2 gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase text-slate-500">Travelled</dt>
            <dd className="text-slate-100">{gps.departedAt ? distance(gps.travelledM) : "Not left yet"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Still to go</dt>
            <dd className="text-slate-100">
              {gps.remainingM === null ? "No destination fence" : `${distance(gps.remainingM)} in a straight line`}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Estimated arrival</dt>
            <dd className="text-slate-100">
              {gps.arrivedAt ? `Arrived ${dateTime(gps.arrivedAt)}` : gps.eta ? dateTime(gps.eta) : gps.speedMps !== null ? "Stopped" : "Unknown"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Last fix</dt>
            <dd className="text-slate-100">
              {gps.lastFix ? ago(gps.lastFix.at) : "None yet"}
              {gps.speedMps !== null && <span className="text-slate-400"> · {speed(gps.speedMps)}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Origin</dt>
            <dd className="text-slate-100">{data?.origin?.name ?? "No fence"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Departed</dt>
            <dd className="text-slate-100">{dateTime(gps.departedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Destination</dt>
            <dd className="text-slate-100">{data?.destination?.name ?? "No fence"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Waypoints</dt>
            <dd className="text-slate-100">{gps.waypoints.length ? gps.waypoints.map((w) => w.name).join(", ") : "None"}</dd>
          </div>
        </dl>
      )}
      {data && !data.origin && !data.destination && (
        <p className="text-sm text-slate-400">
          Neither end of this job has a geofence. Draw one around the origin and destination{" "}
          <Link to="/gps/geofences" className="text-sky-400 hover:underline">
            locations
          </Link>{" "}
          for departures and arrivals to be recognised.
        </p>
      )}

      <div ref={ref} className={MAP_CLASS} role="region" aria-label="Shipment map" />

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Trackers</h2>
          {data?.links.length ? (
            <ul className="mt-2 space-y-1.5 text-sm">
              {data.links.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-slate-200">
                    <Link to={`/gps/trackers/${l.deviceId}`} className="text-sky-400 hover:underline">
                      {l.deviceName ?? "Tracker"}
                    </Link>
                    <span className="text-slate-500">
                      {l.vehicleLocationId ? ` · fitted to ${l.vehicleName ?? "the vehicle"}` : ""}
                      {l.endedAt ? ` · off since ${dateTime(l.endedAt)} (${l.endReason ?? "ended"})` : ""}
                    </span>
                  </span>
                  {!l.endedAt && l.shipmentId && (
                    <button type="button" onClick={() => void takeOff(l.id)} className="text-xs text-slate-400 hover:text-red-300">
                      Take off
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-400">No tracker has been on this shipment.</p>
          )}
          {open && (
            <div className="mt-3 flex flex-wrap gap-2">
              <select value={pick} onChange={(e) => setPick(e.target.value)} className={`${FIELD} max-w-xs`} aria-label="Tracker to put on">
                <option value="">{available.length ? "Put a tracker on…" : "No trackers available"}</option>
                {available.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void assign()} disabled={!pick} className={BUTTON_QUIET}>
                Put on
              </button>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Timeline</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {[
              ...(data?.history ?? []).map((h) => ({
                at: h.at,
                text: `Status ${h.toStatus.replace(/_/g, " ")}${h.actor ? ` by ${h.actor}` : ""}${h.reason ? `: ${h.reason}` : ""}`,
                tone: "text-slate-200",
              })),
              ...(data?.events ?? []).map((e) => ({
                at: e.occurredAt,
                text: `${e.deviceName ?? "Tracker"} ${e.kind === "entered" ? "entered" : "left"} ${e.geofenceName}`,
                tone: e.kind === "entered" ? "text-emerald-300" : "text-amber-300",
              })),
            ]
              .sort((a, b) => a.at.localeCompare(b.at))
              .map((row, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className={row.tone}>{row.text}</span>
                  <span className="shrink-0 text-slate-500">{dateTime(row.at)}</span>
                </li>
              ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
