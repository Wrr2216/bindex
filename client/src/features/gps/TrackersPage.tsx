import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET, FIELD, Field, Toggle } from "../../components/ui";
import type { Location } from "../../types";
import { ago } from "../tracking-core/format";
import { ZonePicker } from "../tracking-core/ZonePicker";
import { gpsApi } from "./api";
import { SPEED_UNIT_LABELS, STATUS_LABELS, errorText } from "./format";
import { GpsNav } from "./GpsNav";
import { STATUS_COLORS, useMapConfig } from "./map";
import type { Geofence, OpenShipment, SpeedUnit, Tracker, TrackerSettings, TrackerStatus } from "./types";

const ORDER: TrackerStatus[] = ["assigned", "awaiting_return", "available", "disposed"];

const SMALL = "rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50";
const SMALL_DANGER = "rounded-lg border border-red-900 px-3 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-50";

/**
 * GPS trackers as a fleet: which shipment or vehicle each is on, which
 * single-use ones are waiting to come back, which are running flat, and each
 * one's GPS options.
 */
export function TrackersPage() {
  const terms = useTerms();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { config } = useMapConfig();
  const [trackers, setTrackers] = useState<Tracker[] | null>(null);
  const [shipments, setShipments] = useState<OpenShipment[]>([]);
  const [fences, setFences] = useState<Geofence[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTrackers(await gpsApi.trackers());
    } catch (err) {
      setError(errorText(err, "Could not load trackers."));
      setTrackers([]);
    }
  }, []);

  useEffect(() => {
    void load();
    gpsApi.geofences().then(setFences).catch(() => undefined);
    api.listLocations().then(setLocations).catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (config?.jobs) gpsApi.openShipments().then(setShipments).catch(() => undefined);
  }, [config?.jobs]);

  const sorted = useMemo(
    () => [...(trackers ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name)),
    [trackers],
  );

  const run = async (what: () => Promise<unknown>, done: string): Promise<boolean> => {
    setError(null);
    try {
      await what();
      setMessage(done);
      await load();
      return true;
    } catch (err) {
      setError(errorText(err, "That did not work."));
      return false;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Trackers</h1>
        <GpsNav />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {message && <p className="text-sm text-slate-400">{message}</p>}

      {trackers === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
          No GPS trackers yet. Add one in{" "}
          <Link to="/settings/devices" className="text-sky-400 hover:underline">
            Readers and devices
          </Link>{" "}
          with the kind GPS tracker, attach it to the {terms.item.singular.toLowerCase()} it follows, and copy its token.
        </p>
      ) : (
        <ul className="space-y-3">
          {sorted.map((t) => (
            <TrackerCard
              key={t.id}
              tracker={t}
              isAdmin={isAdmin}
              jobs={Boolean(config?.jobs)}
              shipments={shipments}
              fences={fences}
              locations={locations}
              run={run}
            />
          ))}
        </ul>
      )}

      {config && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
          <h2 className="font-semibold text-slate-100">Connecting a tracker</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>
              <strong>Traccar Client or OsmAnd on a phone:</strong> server URL{" "}
              <code className="break-all text-slate-200">{config.endpoints.osmand}?token=&lt;device token&gt;</code>
            </li>
            <li>
              <strong>A Traccar server</strong> (for any hardware tracker it supports): forward positions as JSON to{" "}
              <code className="break-all text-slate-200">{config.endpoints.traccar}</code> with a relay tracker's token, and
              give each tracker's IMEI or unique id as its serial here.
            </li>
            <li>
              <strong>Scripts and gateways:</strong> post batches to{" "}
              <code className="break-all text-slate-200">{config.endpoints.batch}</code>.
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}

function TrackerCard({
  tracker: t,
  isAdmin,
  jobs,
  shipments,
  fences,
  locations,
  run,
}: {
  tracker: Tracker;
  isAdmin: boolean;
  jobs: boolean;
  shipments: OpenShipment[];
  fences: Geofence[];
  locations: Location[];
  run: (what: () => Promise<unknown>, done: string) => Promise<boolean>;
}) {
  const terms = useTerms();
  const [mode, setMode] = useState<"shipment" | "vehicle" | "settings" | null>(null);
  const [shipmentId, setShipmentId] = useState("");
  const [originId, setOriginId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const active = t.links.filter((l) => !l.endedAt);

  const assign = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "shipment" && shipmentId) {
      void run(
        () =>
          gpsApi.createLink({
            deviceId: t.id,
            shipmentId,
            originGeofenceId: originId || null,
            destinationGeofenceId: destinationId || null,
          }),
        `${t.name} is on the shipment.`,
      ).then((ok) => ok && setMode(null));
    }
    if (mode === "vehicle" && vehicleId) {
      void run(() => gpsApi.createLink({ deviceId: t.id, vehicleLocationId: vehicleId }), `${t.name} is fitted.`).then((ok) =>
        ok && setMode(null),
      );
    }
  };

  const dispose = () => {
    if (!window.confirm(`Dispose of ${t.name}? It comes off anything it is on.`)) return;
    void run(() => gpsApi.setTrackerStatus(t.id, "disposed"), `${t.name} marked disposed of.`);
  };

  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-medium text-slate-100">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLORS[t.status] }} aria-hidden />
            {t.name}
            {t.gps.relay && <span className="rounded-full bg-slate-800 px-2 text-xs text-slate-400">Relay</span>}
            {t.gps.singleUse && <span className="rounded-full bg-slate-800 px-2 text-xs text-slate-400">Single use</span>}
            {t.disabled && <span className="rounded-full bg-slate-800 px-2 text-xs text-slate-400">Disabled</span>}
          </p>
          <p className="text-sm text-slate-400">
            {STATUS_LABELS[t.status]}
            {t.externalId && <span className="ml-2 font-mono text-xs text-slate-500">{t.externalId}</span>}
          </p>
          {t.itemId && (
            <p className="text-sm text-slate-300">
              On{" "}
              <Link to={`/items/${t.itemId}`} className="text-sky-400 hover:underline">
                {t.itemName ?? terms.item.singular}
              </Link>
            </p>
          )}
          {active.map((l) => (
            <p key={l.id} className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-300">
              {l.shipmentId ? (
                <>
                  Travelling with{" "}
                  {jobs ? (
                    <Link to={`/gps/shipments/${l.shipmentId}`} className="text-sky-400 hover:underline">
                      {l.shipmentCode} {l.shipmentName}
                    </Link>
                  ) : (
                    `${l.shipmentCode} ${l.shipmentName ?? ""}`
                  )}
                </>
              ) : (
                <>Fitted to {l.vehicleName ?? terms.location.singular.toLowerCase()}</>
              )}
              <button
                type="button"
                onClick={() => void run(() => gpsApi.endLink(l.id), `${t.name} taken off.`)}
                className={SMALL}
              >
                Take off
              </button>
            </p>
          ))}
        </div>
        <div className="text-right text-xs text-slate-500">
          <p className={t.stale ? "text-amber-400" : undefined}>Heard {ago(t.lastSeenAt).toLowerCase()}</p>
          <p>Last fix {ago(t.lastFixAt).toLowerCase()}</p>
          {t.batteryPct !== null && <p className={t.batteryLow ? "text-amber-400" : undefined}>Battery {t.batteryPct}%</p>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={`/gps/trackers/${t.id}`} className={SMALL}>
          Trail
        </Link>
        {t.status === "available" && !t.gps.relay && (
          <>
            {jobs && (
              <button type="button" onClick={() => setMode(mode === "shipment" ? null : "shipment")} className={SMALL}>
                Put on a shipment
              </button>
            )}
            <button type="button" onClick={() => setMode(mode === "vehicle" ? null : "vehicle")} className={SMALL}>
              Fit to a vehicle
            </button>
          </>
        )}
        {t.status === "awaiting_return" && (
          <button
            type="button"
            onClick={() => void run(() => gpsApi.setTrackerStatus(t.id, "available"), `${t.name} is back in service.`)}
            className={SMALL}
          >
            Mark returned
          </button>
        )}
        {t.status === "disposed" ? (
          <button
            type="button"
            onClick={() => void run(() => gpsApi.setTrackerStatus(t.id, "available"), `${t.name} is back in service.`)}
            className={SMALL}
          >
            Put back in service
          </button>
        ) : (
          <button type="button" onClick={dispose} className={SMALL_DANGER}>
            Dispose of
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setMode(mode === "settings" ? null : "settings")} className={SMALL}>
            GPS settings
          </button>
        )}
      </div>

      {(mode === "shipment" || mode === "vehicle") && (
        <form onSubmit={assign} className="mt-3 grid gap-3 rounded-lg bg-slate-800/40 p-3 sm:grid-cols-2">
          {mode === "shipment" ? (
            <>
              <Field label="Shipment">
                <select value={shipmentId} onChange={(e) => setShipmentId(e.target.value)} className={FIELD}>
                  <option value="">Pick a shipment</option>
                  {shipments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} {s.name} ({s.jobCode})
                    </option>
                  ))}
                </select>
              </Field>
              <div />
              <Field label="Origin geofence" hint="Leave empty to use the fence around the job's origin.">
                <FenceSelect fences={fences} value={originId} onChange={setOriginId} />
              </Field>
              <Field label="Destination geofence" hint="Leave empty to use the fence around the job's destination.">
                <FenceSelect fences={fences} value={destinationId} onChange={setDestinationId} />
              </Field>
            </>
          ) : (
            <Field label="Vehicle" hint={`The truck or trailer, as a ${terms.location.singular.toLowerCase()}. Shipments on it are followed.`}>
              <ZonePicker locations={locations} value={vehicleId} onChange={setVehicleId} label="Vehicle" emptyLabel="Pick a vehicle" />
            </Field>
          )}
          <div className="flex items-end gap-2 sm:col-span-2">
            <button type="submit" className={BUTTON} disabled={mode === "shipment" ? !shipmentId : !vehicleId}>
              Save
            </button>
            <button type="button" onClick={() => setMode(null)} className={BUTTON_QUIET}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === "settings" && (
        <SettingsForm tracker={t} onSaved={(s) => void run(() => gpsApi.updateTrackerSettings(t.id, s), "Saved.").then((ok) => ok && setMode(null))} />
      )}
    </li>
  );
}

function FenceSelect({ fences, value, onChange }: { fences: Geofence[]; value: string; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={FIELD}>
      <option value="">From the job</option>
      {fences.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  );
}

function SettingsForm({ tracker, onSaved }: { tracker: Tracker; onSaved: (s: Partial<TrackerSettings>) => void }) {
  const [singleUse, setSingleUse] = useState(tracker.gps.singleUse);
  const [relay, setRelay] = useState(tracker.gps.relay);
  const [maxKmh, setMaxKmh] = useState(tracker.gps.maxSpeedMps ? String(Math.round(tracker.gps.maxSpeedMps * 3.6)) : "");
  const [unit, setUnit] = useState<SpeedUnit | "">(tracker.gps.speedUnit ?? "");
  const [battery, setBattery] = useState(tracker.gps.batteryLowPct?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const kmh = maxKmh.trim() ? Number(maxKmh) : null;
    const pct = battery.trim() ? Number(battery) : null;
    if (kmh !== null && !(kmh > 0 && kmh <= 1440)) return setError("The top speed is in km/h, more than 0.");
    if (pct !== null && !(Number.isInteger(pct) && pct >= 0 && pct <= 100)) return setError("The battery warning is a percentage.");
    onSaved({
      singleUse,
      relay,
      maxSpeedMps: kmh === null ? null : Math.round((kmh / 3.6) * 10) / 10,
      speedUnit: unit || null,
      batteryLowPct: pct,
    });
  };

  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 rounded-lg bg-slate-800/40 p-3 sm:grid-cols-2">
      <div className="flex items-start justify-between gap-3 sm:col-span-2">
        <div>
          <p className="text-sm text-slate-200">Single use</p>
          <p className="text-xs text-slate-500">After its shipment is delivered it waits to be returned or disposed of.</p>
        </div>
        <Toggle label="Single use" checked={singleUse} onChange={setSingleUse} />
      </div>
      <div className="flex items-start justify-between gap-3 sm:col-span-2">
        <div>
          <p className="text-sm text-slate-200">Relays other trackers</p>
          <p className="text-xs text-slate-500">For a Traccar server forwarding positions: trackers it names are registered and updated.</p>
        </div>
        <Toggle label="Relays other trackers" checked={relay} onChange={setRelay} />
      </div>
      <Field label="Fastest believable speed (km/h)" hint="Faster than this from the last fix is a glitch. Blank uses the server default.">
        <input value={maxKmh} onChange={(e) => setMaxKmh(e.target.value)} inputMode="numeric" className={FIELD} />
      </Field>
      <Field label="Battery warning (%)" hint="Blank uses the server default.">
        <input value={battery} onChange={(e) => setBattery(e.target.value)} inputMode="numeric" className={FIELD} />
      </Field>
      <Field label="Speed arrives in" hint="Only if the tracker's app sends a different unit than its protocol says.">
        <select value={unit} onChange={(e) => setUnit(e.target.value as SpeedUnit | "")} className={FIELD}>
          <option value="">As the protocol defines</option>
          {(Object.keys(SPEED_UNIT_LABELS) as SpeedUnit[]).map((u) => (
            <option key={u} value={u}>
              {SPEED_UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </Field>
      {error && <p className="text-sm text-red-400 sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2">
        <button type="submit" className={BUTTON}>
          Save settings
        </button>
      </div>
    </form>
  );
}
