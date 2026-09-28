import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { BUTTON } from "../../components/ui";
import type { Location } from "../../types";
import { bleApi } from "./api";
import { BleDeviceEditor, type BleDraft } from "./BleDeviceEditor";
import { ago, BLE_KIND_LABELS, FRAME_LABELS, shortIdentity, signalWord } from "./format";
import type { BleDevice, BleKind, HeardAdvert } from "./types";

const SECTIONS: { kind: BleKind; title: string }[] = [
  { kind: "ble_gateway", title: "Gateways" },
  { kind: "ble_tag", title: "Tags" },
  { kind: "ble_beacon", title: "Room beacons" },
  { kind: "mobile", title: "Phones" },
];

/** Where each kind posts, for the token notice. */
const ENDPOINT: Partial<Record<BleKind, string>> = {
  ble_gateway: "/api/device/ble/reads (or /minew, /ingics, /kontakt, /teltonika)",
  mobile: "/api/device/ble/phone",
};

function TokenNotice({ name, kind, token, onDismiss }: { name: string; kind: BleKind; token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-amber-700 bg-amber-950/50 p-4" role="status">
      <p className="text-sm font-medium text-amber-300">Token for “{name}”. Copy it now; it is not shown again.</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="break-all rounded bg-slate-950 px-2 py-1 text-sm text-slate-200">{token}</code>
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(token)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={onDismiss} className="text-sm text-slate-400 hover:text-slate-200">
          Dismiss
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Send it as <code className="text-slate-300">Authorization: Bearer &lt;token&gt;</code> when posting to{" "}
        <code className="text-slate-300">{ENDPOINT[kind] ?? "/api/device/ble/reads"}</code>.
      </p>
    </div>
  );
}

function HeardNearby({ onRegister }: { onRegister: (draft: BleDraft) => void }) {
  const [heard, setHeard] = useState<HeardAdvert[] | null>(null);
  const [all, setAll] = useState(false);

  const load = useCallback(() => {
    bleApi
      .heard({ all })
      .then(setHeard)
      .catch(() => setHeard([]));
  }, [all]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-100">Heard nearby</h3>
          <p className="text-sm text-slate-400">
            Beacons your gateways hear that are not registered yet, strongest first. Hold a new tag next to a gateway
            and it comes to the top. Kept in memory for ten minutes, never stored.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Include devices that are not beacons
        </label>
      </div>
      {!heard ? null : !heard.length ? (
        <p className="mt-3 text-sm text-slate-500">Nothing unregistered heard in the last ten minutes.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-800">
          {heard.slice(0, 25).map((h) => (
            <li key={`${h.gatewayId}/${h.key}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-mono text-slate-200">{shortIdentity(h.identity ?? h.mac)}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {FRAME_LABELS[h.frame]}
                  {h.name ? ` · ${h.name}` : ""}
                  {h.url ? ` · ${h.url}` : ""} · {signalWord(h.rssi)} ({h.rssi} dBm) · {h.count}×
                </span>
              </span>
              <span className="flex gap-2">
                <button
                  onClick={() =>
                    onRegister({
                      kind: "ble_tag",
                      name: h.name ?? "",
                      identity: h.identity ?? h.mac,
                      bleMac: h.identity && h.mac ? h.mac.replace(/^mac:/, "") : null,
                    })
                  }
                  className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                >
                  Register as tag
                </button>
                <button
                  onClick={() => onRegister({ kind: "ble_beacon", name: h.name ?? "", identity: h.identity ?? h.mac })}
                  className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                >
                  As room beacon
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeviceSummary({ d }: { d: BleDevice }) {
  const terms = useTerms();
  switch (d.kind) {
    case "ble_gateway":
      return d.locationId ? (
        <>
          Covers{" "}
          <Link to={`/locations/${d.locationId}`} className="text-sky-400 hover:underline">
            {d.locationName}
          </Link>
          {d.updatesLocation && <span className="text-slate-500"> · moves what it places</span>}
          {d.ble.rssiOffset ? <span className="text-slate-500"> · offset {d.ble.rssiOffset > 0 ? "+" : ""}{d.ble.rssiOffset} dB</span> : null}
        </>
      ) : (
        <span className="text-slate-500">No room: hears tags but places none</span>
      );
    case "ble_tag":
      return (
        <>
          {d.itemId ? (
            <>
              On{" "}
              <Link to={`/items/${d.itemId}`} className="text-sky-400 hover:underline">
                {d.itemName ?? terms.item.singular}
              </Link>
            </>
          ) : (
            <span className="text-slate-500">Not attached</span>
          )}
          {d.presence?.locationName && (
            <span className="text-slate-400">
              {" "}
              · in {d.presence.locationName}
              {d.presence.missingSince && <span className="text-amber-400"> (missing)</span>}
            </span>
          )}
        </>
      );
    case "ble_beacon":
      return d.locationId ? (
        <>
          In{" "}
          <Link to={`/locations/${d.locationId}`} className="text-sky-400 hover:underline">
            {d.locationName}
          </Link>
        </>
      ) : (
        <span className="text-amber-400">No room set: phones hearing it are placed nowhere</span>
      );
    case "mobile":
      return (
        <>
          {(d.ble.userName ?? d.ble.userOid) ? `${d.ble.userName ?? d.ble.userOid}'s phone` : <span className="text-amber-400">Belongs to nobody</span>}
          {d.room && <span className="text-slate-400"> · in {d.room.locationName}</span>}
        </>
      );
  }
}

/** Register and manage gateways, tags, room beacons and phones. Administrators only. */
export function BleDevicesView() {
  const [devices, setDevices] = useState<BleDevice[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState<{ device?: BleDevice; draft?: BleDraft } | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; kind: BleKind; token: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    bleApi
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

  const rotate = async (d: BleDevice) => {
    if (d.hasToken && !window.confirm(`Issue a new token for “${d.name}”? The current one stops working immediately.`)) return;
    try {
      const r = await bleApi.rotateToken(d.id);
      setRevealed({ name: d.name, kind: d.kind, token: r.token });
      load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not issue a token.");
    }
  };

  const remove = async (d: BleDevice) => {
    if (!window.confirm(`Delete “${d.name}”? Its sightings stay in history.`)) return;
    try {
      await bleApi.deleteDevice(d.id);
      setMessage(`Deleted ${d.name}.`);
      load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not delete the device.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          Gateways listen in rooms; tags follow things; room beacons tell phones where they are. The generic device
          list is in{" "}
          <Link to="/settings/devices" className="text-sky-400 hover:underline">
            Readers and devices
          </Link>
          .
        </p>
        {editing === null && (
          <button onClick={() => setEditing({})} className={BUTTON}>
            Add device
          </button>
        )}
      </div>

      {revealed && <TokenNotice {...revealed} onDismiss={() => setRevealed(null)} />}
      {message && <p className="text-sm text-slate-400">{message}</p>}

      {editing && (
        <BleDeviceEditor
          key={editing.device?.id ?? `new-${editing.draft?.identity ?? ""}`}
          device={editing.device}
          draft={editing.draft}
          locations={locations}
          onSaved={(saved) => {
            setEditing(null);
            if (saved.token) setRevealed({ name: saved.name, kind: saved.kind, token: saved.token });
            setMessage(`Saved ${saved.name}.`);
            load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {devices === null ? (
        <p className="py-6 text-center text-slate-500">Loading…</p>
      ) : (
        SECTIONS.map(({ kind, title }) => {
          const list = devices.filter((d) => d.kind === kind);
          if (!list.length && kind === "mobile") return null;
          return (
            <section key={kind}>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
                {title} <span className="font-normal text-slate-500">({list.length})</span>
              </h3>
              {!list.length ? (
                <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-500">
                  None yet. {BLE_KIND_LABELS[kind]}s are added with Add device{kind === "ble_tag" || kind === "ble_beacon" ? ", or from Heard nearby" : ""}.
                </p>
              ) : (
                <ul className="space-y-2">
                  {list.map((d) => (
                    <li key={d.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-100">
                            {d.name}
                            {d.disabled && (
                              <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">Disabled</span>
                            )}
                          </p>
                          {d.externalId && <p className="font-mono text-xs text-slate-500">{d.kind === "ble_tag" || d.kind === "ble_beacon" ? shortIdentity(d.externalId) : d.externalId}</p>}
                          <p className="mt-1 text-sm text-slate-300">
                            <DeviceSummary d={d} />
                          </p>
                        </div>
                        <div className="text-right text-xs text-slate-500">
                          <p>Last heard {ago(d.lastSeenAt).toLowerCase()}</p>
                          {d.batteryPct !== null && (
                            <p className={d.batteryPct <= 20 ? "text-amber-400" : undefined}>Battery {d.batteryPct}%</p>
                          )}
                          {(kind === "ble_gateway" || kind === "mobile") && (
                            <p>{d.hasToken ? `Token …${d.tokenLast4 ?? ""}` : "No token"}</p>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          onClick={() => setEditing({ device: d })}
                          className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        {(kind === "ble_gateway" || kind === "mobile") && (
                          <button
                            onClick={() => void rotate(d)}
                            className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
                          >
                            {d.hasToken ? "New token" : "Issue token"}
                          </button>
                        )}
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
            </section>
          );
        })
      )}

      <HeardNearby onRegister={(draft) => setEditing({ draft })} />
    </div>
  );
}
