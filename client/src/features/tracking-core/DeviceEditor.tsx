import { useState, type FormEvent } from "react";
import { useTerms } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET, FIELD, Field, LABEL, Toggle } from "../../components/ui";
import type { Location } from "../../types";
import { trackingApi } from "./api";
import { AssetPicker, type AssetChoice } from "./AssetPicker";
import { ATTACHED_KINDS, DEVICE_KINDS, KIND_HELP, KIND_LABELS, REPORTING_KINDS } from "./format";
import type { DeviceKind, DevicePayload, DeviceSettings, DeviceWithToken, PortalSide, TrackingDevice } from "./types";
import { ZonePicker } from "./ZonePicker";

type AntennaRow = { port: string; side: PortalSide | ""; zone: string | null };

const DEFAULT_PORTAL: AntennaRow[] = [
  { port: "1", side: "outside", zone: null },
  { port: "2", side: "outside", zone: null },
  { port: "3", side: "inside", zone: null },
  { port: "4", side: "inside", zone: null },
];

function antennaRows(device: TrackingDevice | undefined): AntennaRow[] {
  if (!device) return [];
  const sides = device.settings.portal?.sides ?? {};
  const zones = device.settings.antennaZones ?? {};
  const ports = [...new Set([...Object.keys(sides), ...Object.keys(zones)])].sort((a, b) => Number(a) - Number(b));
  return ports.map((port) => ({ port, side: sides[port] ?? "", zone: zones[port] ?? null }));
}

const numberOrNull = (v: string): number | null => {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Add or edit one device. Settings keys this form does not know about (BLE or
 * GPS options added by other features) are carried through untouched.
 */
export function DeviceEditor({
  device,
  locations,
  onSaved,
  onCancel,
}: {
  device?: TrackingDevice;
  locations: Location[];
  onSaved: (result: DeviceWithToken) => void;
  onCancel: () => void;
}) {
  const terms = useTerms();
  const [kind, setKind] = useState<DeviceKind>(device?.kind ?? "rfid_reader");
  const [name, setName] = useState(device?.name ?? "");
  const [externalId, setExternalId] = useState(device?.externalId ?? "");
  const [locationId, setLocationId] = useState<string | null>(device?.locationId ?? null);
  const [asset, setAsset] = useState<AssetChoice>({
    itemId: device?.itemId ?? null,
    itemName: device?.itemName ?? null,
    unitId: device?.unitId ?? null,
  });
  const [updatesLocation, setUpdatesLocation] = useState(device?.updatesLocation ?? false);
  const [disabled, setDisabled] = useState(device?.disabled ?? false);
  const [rssiFloor, setRssiFloor] = useState(device?.settings.rssiFloor?.toString() ?? "");
  const [dedup, setDedup] = useState(device?.settings.dedupSeconds?.toString() ?? "");
  const [windowSeconds, setWindowSeconds] = useState(device?.settings.portal?.windowSeconds?.toString() ?? "");
  const [outLocationId, setOutLocationId] = useState<string | null>(device?.settings.portal?.outLocationId ?? null);
  const [inLocationId, setInLocationId] = useState<string | null>(device?.settings.portal?.inLocationId ?? null);
  const [antennas, setAntennas] = useState<AntennaRow[]>(() => antennaRows(device));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPortal = kind === "rfid_portal";
  const isAttached = ATTACHED_KINDS.includes(kind);
  const reports = REPORTING_KINDS.includes(kind);
  const locationWord = terms.location.singular.toLowerCase();
  const itemWord = terms.item.plural.toLowerCase();

  const changeKind = (next: DeviceKind) => {
    setKind(next);
    // A new portal starts with the common two-sided layout.
    if (next === "rfid_portal" && !antennas.some((a) => a.side)) setAntennas(DEFAULT_PORTAL);
  };

  const setRow = (i: number, patch: Partial<AntennaRow>) =>
    setAntennas((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the device a name.");
      return;
    }
    const ports = antennas.map((a) => a.port.trim());
    if (ports.some((p) => !/^\d{1,3}$/.test(p))) {
      setError("Antenna ports are numbers, such as 1 or 4.");
      return;
    }
    if (new Set(ports).size !== ports.length) {
      setError("Each antenna port can only be listed once.");
      return;
    }

    // Start from what is stored so other features' settings survive.
    const settings: DeviceSettings = { ...(device?.settings ?? {}) };
    settings.rssiFloor = numberOrNull(rssiFloor);
    settings.dedupSeconds = numberOrNull(dedup);
    const zones: Record<string, string> = {};
    for (const a of antennas) if (a.zone && !isPortal) zones[a.port.trim()] = a.zone;
    settings.antennaZones = zones;
    if (isPortal) {
      const sides: Record<string, PortalSide> = {};
      for (const a of antennas) if (a.side) sides[a.port.trim()] = a.side;
      const window = numberOrNull(windowSeconds);
      settings.portal = {
        sides,
        ...(window ? { windowSeconds: window } : {}),
        inLocationId,
        outLocationId,
      };
    } else {
      delete settings.portal;
    }

    const payload: DevicePayload = {
      kind,
      name: name.trim(),
      externalId: externalId.trim() || null,
      locationId: isAttached ? null : locationId,
      itemId: isAttached ? asset.itemId : null,
      unitId: isAttached ? asset.unitId : null,
      updatesLocation,
      disabled,
      settings,
    };

    setBusy(true);
    setError(null);
    try {
      if (device) {
        onSaved({ device: await trackingApi.updateDevice(device.id, payload), token: null });
      } else {
        onSaved(await trackingApi.createDevice(payload));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the device.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-5">
      <h2 className="font-semibold text-slate-100">{device ? `Edit ${device.name}` : "Add a device"}</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind" hint={KIND_HELP[kind]}>
          <select value={kind} onChange={(e) => changeKind(e.target.value as DeviceKind)} className={FIELD}>
            {DEVICE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dock door 1" className={FIELD} />
        </Field>
        <Field
          label="Serial, MAC or reader id"
          hint="What the device calls itself: its serial, MAC, IMEI, host name, or a bridge's READER_ID. Optional."
        >
          <input
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            placeholder="FX9600F0A1B2"
            className={FIELD}
          />
        </Field>
        {isAttached ? (
          // Not a <label>: the picker holds several controls of its own.
          <div>
            <span className={LABEL}>Attached to</span>
            <div className="mt-1">
              <AssetPicker value={asset} onChange={setAsset} />
            </div>
            <span className="mt-1 block text-xs text-slate-500">
              The {terms.item.singular.toLowerCase()} this tag or tracker follows.
            </span>
          </div>
        ) : (
          <Field
            label={isPortal ? "Inside zone" : "Zone"}
            hint={
              isPortal
                ? `The ${locationWord} a tag is in after passing through the door inwards.`
                : `The ${locationWord} this device covers. Leave empty for a handheld.`
            }
          >
            <ZonePicker locations={locations} value={locationId} onChange={setLocationId} label="Zone" />
          </Field>
        )}
      </div>

      {reports && (
        <div className="flex items-start justify-between gap-4 rounded-lg bg-slate-800/40 p-3">
          <div>
            <p className="text-sm font-medium text-slate-200">Move {itemWord} when read</p>
            <p className="text-sm text-slate-500">
              When on, reads here change where {itemWord} are on file. When off, they only update where{" "}
              {itemWord} were last seen.
            </p>
          </div>
          <Toggle label="Move when read" checked={updatesLocation} onChange={setUpdatesLocation} />
        </div>
      )}

      {isPortal && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Outside zone" hint={`Where a tag is after passing out. Leave empty if outside is not a ${locationWord}.`}>
            <ZonePicker
              locations={locations}
              value={outLocationId}
              onChange={setOutLocationId}
              label="Outside zone"
              emptyLabel="Nowhere in particular"
            />
          </Field>
          <Field label="Override inside zone" hint="Only if the inside is not the zone above.">
            <ZonePicker
              locations={locations}
              value={inLocationId}
              onChange={setInLocationId}
              label="Inside zone override"
              emptyLabel="Use the zone above"
            />
          </Field>
          <Field label="Pass window (seconds)" hint="Longest gap between reads that still counts as one pass. Default 3.">
            <input
              value={windowSeconds}
              onChange={(e) => setWindowSeconds(e.target.value)}
              inputMode="decimal"
              placeholder="3"
              className={FIELD}
            />
          </Field>
        </div>
      )}

      {(reports || isPortal) && !isAttached && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            {isPortal ? "Antenna map" : "Antennas in other zones"}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {isPortal
              ? "Which side of the door each antenna faces. A tag first read outside and last read inside went in."
              : `Only for a reader whose antennas cover different ${terms.location.plural.toLowerCase()}. Others use the zone above.`}
          </p>
          <div className="mt-2 space-y-2">
            {antennas.map((a, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  value={a.port}
                  onChange={(e) => setRow(i, { port: e.target.value })}
                  aria-label="Antenna port"
                  inputMode="numeric"
                  className="w-20 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
                />
                {isPortal ? (
                  <select
                    value={a.side}
                    onChange={(e) => setRow(i, { side: e.target.value as PortalSide | "" })}
                    aria-label={`Side for antenna ${a.port}`}
                    className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
                  >
                    <option value="">Ignore</option>
                    <option value="outside">Faces outside</option>
                    <option value="inside">Faces inside</option>
                  </select>
                ) : (
                  <div className="min-w-48 flex-1">
                    <ZonePicker
                      locations={locations}
                      value={a.zone}
                      onChange={(zone) => setRow(i, { zone })}
                      label={`Zone for antenna ${a.port}`}
                      emptyLabel="Same as the device"
                    />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setAntennas((rows) => rows.filter((_, j) => j !== i))}
                  className="text-xs text-slate-400 hover:text-red-300"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setAntennas((rows) => [
                  ...rows,
                  { port: String(rows.reduce((m, r) => Math.max(m, Number(r.port) || 0), 0) + 1), side: "", zone: null },
                ])
              }
              className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
            >
              Add antenna
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Ignore reads weaker than (dBm)" hint="Stops a reader picking up tags in the next aisle. Optional, such as -70.">
          <input
            value={rssiFloor}
            onChange={(e) => setRssiFloor(e.target.value)}
            inputMode="numeric"
            placeholder="-70"
            className={FIELD}
          />
        </Field>
        <Field label="Store a repeat read at most every (seconds)" hint="Default comes from TRACKING_DEDUP_SECONDS, normally 5.">
          <input
            value={dedup}
            onChange={(e) => setDedup(e.target.value)}
            inputMode="decimal"
            placeholder="5"
            className={FIELD}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
        Disabled: ignore everything this device sends
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={BUTTON}>
          {busy ? "Saving…" : device ? "Save" : "Add device"}
        </button>
        <button type="button" onClick={onCancel} className={BUTTON_QUIET}>
          Cancel
        </button>
      </div>
    </form>
  );
}
