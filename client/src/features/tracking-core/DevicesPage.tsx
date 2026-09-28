import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { ArrowLeftIcon } from "../../components/icons";
import { BUTTON } from "../../components/ui";
import type { Location } from "../../types";
import { trackingApi } from "./api";
import { DeviceEditor } from "./DeviceEditor";
import { ago, ATTACHED_KINDS, channelOf, KIND_LABELS } from "./format";
import { TokenReveal } from "./TokenReveal";
import type { DeviceWithToken, TrackingDevice } from "./types";

/** Settings, Readers and devices: the device registry, for administrators. */
export function DevicesPage() {
  const { user } = useAuth();
  const terms = useTerms();
  const [devices, setDevices] = useState<TrackingDevice[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState<TrackingDevice | "new" | null>(null);
  const [revealed, setRevealed] = useState<{ device: TrackingDevice; token: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    trackingApi
      .listDevices()
      .then(setDevices)
      .catch((err) => {
        setDevices([]);
        setMessage(err instanceof Error ? err.message : "Could not load devices.");
      });
  }, []);

  useEffect(() => {
    load();
    api.listLocations().then(setLocations).catch(() => undefined);
  }, [load]);

  if (user?.role !== "admin") {
    return (
      <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
        Only an administrator can manage readers and devices.
      </p>
    );
  }

  const saved = (result: DeviceWithToken) => {
    setEditing(null);
    if (result.token) setRevealed({ device: result.device, token: result.token });
    setMessage(`Saved ${result.device.name}.`);
    load();
  };

  const rotate = async (d: TrackingDevice) => {
    if (
      d.hasToken &&
      !window.confirm(`Issue a new token for “${d.name}”? The current one stops working immediately.`)
    ) {
      return;
    }
    try {
      const r = await trackingApi.rotateToken(d.id);
      setRevealed(r);
      load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not issue a token.");
    }
  };

  const remove = async (d: TrackingDevice) => {
    if (!window.confirm(`Delete “${d.name}”? Its sightings stay in history.`)) return;
    try {
      await trackingApi.deleteDevice(d.id);
      setMessage(`Deleted ${d.name}.`);
      load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not delete the device.");
    }
  };

  return (
    <div className="space-y-5">
      <Link to="/settings" className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:underline">
        <ArrowLeftIcon className="h-3.5 w-3.5" />
        Settings
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Readers and devices</h1>
          <p className="text-sm text-slate-400">
            Fixed readers and portals report what passes them; tags and trackers follow{" "}
            {terms.item.plural.toLowerCase()} around. Each reporting device gets its own ingest token.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/tracking"
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            Live reads
          </Link>
          {editing === null && (
            <button onClick={() => setEditing("new")} className={BUTTON}>
              Add device
            </button>
          )}
        </div>
      </div>

      {revealed && (
        <TokenReveal
          name={revealed.device.name}
          kind={revealed.device.kind}
          token={revealed.token}
          onDismiss={() => setRevealed(null)}
        />
      )}
      {message && <p className="text-sm text-slate-400">{message}</p>}

      {editing !== null && (
        <DeviceEditor
          key={editing === "new" ? "new" : editing.id}
          device={editing === "new" ? undefined : editing}
          locations={locations}
          onSaved={saved}
          onCancel={() => setEditing(null)}
        />
      )}

      {devices === null ? (
        <p className="py-6 text-center text-slate-500">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
          No devices yet. A reader bridge using INGEST_TOKEN registers itself the first time it posts; anything
          else, add here.
        </p>
      ) : (
        <ul className="space-y-2">
          {devices.map((d) => (
            <li key={d.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-100">
                    {d.name}
                    {d.disabled && (
                      <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">Disabled</span>
                    )}
                  </p>
                  <p className="text-sm text-slate-400">
                    {KIND_LABELS[d.kind]}
                    {d.externalId && <span className="ml-2 font-mono text-xs text-slate-500">{d.externalId}</span>}
                  </p>
                  <p className="mt-1 text-sm text-slate-300">
                    {ATTACHED_KINDS.includes(d.kind) ? (
                      d.itemId ? (
                        <>
                          On{" "}
                          <Link to={`/items/${d.itemId}`} className="text-sky-400 hover:underline">
                            {d.itemName ?? terms.item.singular}
                          </Link>
                          {d.unitLabel || d.unitAssetCode ? ` (${d.unitLabel || d.unitAssetCode})` : ""}
                        </>
                      ) : (
                        <span className="text-slate-500">Not attached to anything</span>
                      )
                    ) : d.locationId ? (
                      <>
                        Covers{" "}
                        <Link to={`/locations/${d.locationId}`} className="text-sky-400 hover:underline">
                          {d.locationName ?? terms.location.singular}
                        </Link>
                        {d.updatesLocation && <span className="text-slate-500"> · moves what it reads</span>}
                      </>
                    ) : (
                      <span className="text-slate-500">No zone: records sightings only</span>
                    )}
                  </p>
                </div>
                <div className="text-right text-xs text-slate-500">
                  <p title={d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : undefined}>
                    Last heard {ago(d.lastSeenAt).toLowerCase()}
                  </p>
                  {d.batteryPct !== null && (
                    <p className={d.batteryPct <= 20 ? "text-amber-400" : undefined}>Battery {d.batteryPct}%</p>
                  )}
                  <p>{d.hasToken ? `Token …${d.tokenLast4 ?? ""}` : "No token"}</p>
                  <p className="font-mono">Channel {channelOf(d)}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => setEditing(d)}
                  className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
                >
                  Edit
                </button>
                <button
                  onClick={() => void rotate(d)}
                  className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
                >
                  {d.hasToken ? "New token" : "Issue token"}
                </button>
                <Link
                  to={`/tracking?device=${d.id}`}
                  className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
                >
                  Live reads
                </Link>
                <button
                  onClick={() => void remove(d)}
                  className="rounded-lg border border-red-900 px-3 py-1 text-xs text-red-300 hover:bg-red-950"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
