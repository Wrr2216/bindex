import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET, FIELD, Field, LABEL, Toggle } from "../../components/ui";
import type { Account, Location } from "../../types";
import { AssetPicker, type AssetChoice } from "../tracking-core/AssetPicker";
import { ZonePicker } from "../tracking-core/ZonePicker";
import { bleApi } from "./api";
import { BLE_KIND_HELP, BLE_KIND_LABELS, EMPTY_PARTS, joinIdentity, splitIdentity, type IdentityParts, type IdentityScheme } from "./format";
import type { BleDevice, BleDevicePayload, BleKind } from "./types";

const KINDS: BleKind[] = ["ble_gateway", "ble_tag", "ble_beacon", "mobile"];

const numberOrNull = (v: string): number | null => {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** What a new device starts as, for example from an advert heard nearby. */
export type BleDraft = { kind: BleKind; name?: string; identity?: string | null; bleMac?: string | null };

function IdentityFields({ value, onChange }: { value: IdentityParts; onChange: (next: IdentityParts) => void }) {
  const set = (patch: Partial<IdentityParts>) => onChange({ ...value, ...patch });
  const input = (key: keyof IdentityParts, label: string, placeholder: string, width = "") => (
    <input
      value={value[key]}
      onChange={(e) => set({ [key]: e.target.value })}
      aria-label={label}
      placeholder={placeholder}
      className={`${FIELD} ${width} font-mono text-sm`}
    />
  );
  return (
    <div className="space-y-2">
      <select
        value={value.scheme}
        onChange={(e) => set({ scheme: e.target.value as IdentityScheme })}
        aria-label="Beacon format"
        className={FIELD}
      >
        <option value="ibeacon">iBeacon: UUID, major, minor</option>
        <option value="eddystone">Eddystone-UID: namespace, instance</option>
        <option value="altbeacon">AltBeacon: id1, id2, id3</option>
        <option value="mac">Bluetooth address (MAC) only</option>
        <option value="other">Other id (such as kontakt:AbC1)</option>
      </select>
      {(value.scheme === "ibeacon" || value.scheme === "altbeacon") && (
        <div className="grid grid-cols-[1fr_5rem_5rem] gap-2">
          {input("uuid", "UUID", "E2C56DB5-DFFB-48D2-B060-D0F5A71096E0")}
          {input("major", "Major", "1")}
          {input("minor", "Minor", "2")}
        </div>
      )}
      {value.scheme === "eddystone" && (
        <div className="grid grid-cols-[1fr_10rem] gap-2">
          {input("namespace", "Namespace", "EDD1EBEAC04E5DEFA017")}
          {input("instance", "Instance", "0BDB87539B67")}
        </div>
      )}
      {value.scheme === "mac" && input("mac", "MAC address", "AC:23:3F:A1:B2:C3")}
      {value.scheme === "other" && input("other", "Id", "kontakt:AbC1")}
    </div>
  );
}

/**
 * Add or edit a gateway, tag, room beacon or phone. Writes through the BLE
 * routes, which keep the tracking core's own settings (RSSI floor, antenna
 * zones) and other features' keys as they are.
 */
export function BleDeviceEditor({
  device,
  draft,
  locations,
  onSaved,
  onCancel,
}: {
  device?: BleDevice;
  draft?: BleDraft;
  locations: Location[];
  onSaved: (saved: { id: string; name: string; kind: BleKind; token: string | null }) => void;
  onCancel: () => void;
}) {
  const terms = useTerms();
  const { user } = useAuth();
  const [kind, setKind] = useState<BleKind>(device?.kind ?? draft?.kind ?? "ble_gateway");
  const [name, setName] = useState(device?.name ?? draft?.name ?? "");
  const [externalId, setExternalId] = useState(device?.kind === "ble_gateway" || device?.kind === "mobile" ? (device.externalId ?? "") : "");
  const [identity, setIdentity] = useState<IdentityParts>(() =>
    device && (device.kind === "ble_tag" || device.kind === "ble_beacon")
      ? splitIdentity(device.externalId)
      : draft?.identity
        ? splitIdentity(draft.identity)
        : { ...EMPTY_PARTS },
  );
  const [locationId, setLocationId] = useState<string | null>(device?.locationId ?? null);
  const [asset, setAsset] = useState<AssetChoice>({
    itemId: device?.itemId ?? null,
    itemName: device?.itemName ?? null,
    unitId: device?.unitId ?? null,
  });
  const [updatesLocation, setUpdatesLocation] = useState(device?.updatesLocation ?? false);
  const [disabled, setDisabled] = useState(device?.disabled ?? false);
  const [rssiOffset, setRssiOffset] = useState(str(device?.ble.rssiOffset || null));
  const [txPower, setTxPower] = useState(str(device?.ble.txPower));
  const [bleMac, setBleMac] = useState(device?.ble.bleMac ?? draft?.bleMac ?? "");
  const [missingMinutes, setMissingMinutes] = useState(str(device?.ble.missingMinutes));
  const [afterHours, setAfterHours] = useState(device?.ble.afterHoursAlert ?? true);
  const [fullMv, setFullMv] = useState(str(device?.ble.batteryFullMv));
  const [emptyMv, setEmptyMv] = useState(str(device?.ble.batteryEmptyMv));
  const [owner, setOwner] = useState<{ oid: string; name: string } | null>(
    device?.ble.userOid ? { oid: device.ble.userOid, name: device.ble.userName ?? device.ble.userOid } : null,
  );
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "mobile") return;
    api.listAccounts().then(setAccounts).catch(() => setAccounts([]));
  }, [kind]);

  const isTag = kind === "ble_tag";
  const identified = kind === "ble_tag" || kind === "ble_beacon";
  const zoned = kind === "ble_gateway" || kind === "ble_beacon";
  const locationWord = terms.location.singular.toLowerCase();
  const itemWord = terms.item.singular.toLowerCase();

  const owners = [
    ...(user ? [{ oid: user.oid, name: `${user.name || user.email} (me)` }] : []),
    ...accounts.filter((a) => a.oid !== user?.oid && !a.disabled).map((a) => ({ oid: a.oid, name: a.name || a.email })),
  ];
  if (owner && !owners.some((o) => o.oid === owner.oid)) owners.push(owner);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the device a name.");
      return;
    }
    const payload: BleDevicePayload = {
      kind,
      name: name.trim(),
      externalId: identified ? joinIdentity(identity) : externalId.trim() || null,
      locationId: zoned ? locationId : null,
      itemId: isTag ? asset.itemId : null,
      unitId: isTag ? asset.unitId : null,
      updatesLocation: kind === "ble_gateway" ? updatesLocation : false,
      disabled,
      ble: {
        rssiOffset: zoned ? numberOrNull(rssiOffset) : null,
        txPower: identified ? numberOrNull(txPower) : null,
        bleMac: isTag ? bleMac.trim() || null : null,
        missingMinutes: isTag ? numberOrNull(missingMinutes) : null,
        afterHoursAlert: isTag ? (afterHours ? null : false) : null,
        batteryFullMv: isTag ? numberOrNull(fullMv) : null,
        batteryEmptyMv: isTag ? numberOrNull(emptyMv) : null,
        userOid: kind === "mobile" ? (owner?.oid ?? null) : null,
        userName: kind === "mobile" ? (owner?.name.replace(/ \(me\)$/, "") ?? null) : null,
      },
    };
    setBusy(true);
    setError(null);
    try {
      if (device) {
        const saved = await bleApi.updateDevice(device.id, payload);
        onSaved({ id: saved.id, name: saved.name, kind, token: null });
      } else {
        const created = await bleApi.createDevice(payload);
        onSaved({ id: created.device.id, name: created.device.name, kind, token: created.token });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the device.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-5">
      <h2 className="font-semibold text-slate-100">{device ? `Edit ${device.name}` : "Add a Bluetooth device"}</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind" hint={BLE_KIND_HELP[kind]}>
          <select value={kind} onChange={(e) => setKind(e.target.value as BleKind)} className={FIELD}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {BLE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isTag ? "Tag on pallet jack 2" : kind === "mobile" ? "Dana's phone" : "Dock A gateway"}
            className={FIELD}
          />
        </Field>
      </div>

      {identified ? (
        <div>
          <span className={LABEL}>{isTag ? "What the tag broadcasts" : "What the beacon broadcasts"}</span>
          <div className="mt-1">
            <IdentityFields value={identity} onChange={setIdentity} />
          </div>
          <span className="mt-1 block text-xs text-slate-500">
            Printed on the beacon or its box, or shown by the vendor's app. Or pick it from Heard nearby.
          </span>
        </div>
      ) : (
        <Field
          label={kind === "mobile" ? "Phone id (optional)" : "Serial or MAC (optional)"}
          hint={
            kind === "mobile"
              ? "Only for your own reference; the phone is identified by its token."
              : "What the gateway calls itself in its reports. Needed for MQTT and INGEST_TOKEN posts; a gateway posting with its own token needs none."
          }
        >
          <input value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="AC233FC04EAB" className={FIELD} />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {zoned && (
          <Field
            label={kind === "ble_gateway" ? "Room it covers" : "Room it is in"}
            hint={
              kind === "ble_gateway"
                ? `Tags this gateway hears best are placed in this ${locationWord}. Leave empty for a gateway that roams.`
                : `A phone hearing this beacon best is in this ${locationWord}.`
            }
          >
            <ZonePicker locations={locations} value={locationId} onChange={setLocationId} label="Room" />
          </Field>
        )}
        {isTag && (
          <div>
            <span className={LABEL}>Attached to</span>
            <div className="mt-1">
              <AssetPicker value={asset} onChange={setAsset} />
            </div>
            <span className="mt-1 block text-xs text-slate-500">
              The {itemWord} (or vault, pallet, cage) this tag follows. A spare tag for calibrating can stay unattached.
            </span>
          </div>
        )}
        {zoned && (
          <Field
            label="Signal offset (dB)"
            hint="Added to everything this device is heard at. Set it with Calibrate; 0 unless a gateway reads weak or strong."
          >
            <input value={rssiOffset} onChange={(e) => setRssiOffset(e.target.value)} inputMode="decimal" placeholder="0" className={FIELD} />
          </Field>
        )}
        {kind === "mobile" && (
          <Field label="Belongs to" hint="Whose room this phone reports. Scans by that person can default to it.">
            <select
              value={owner?.oid ?? ""}
              onChange={(e) => setOwner(owners.find((o) => o.oid === e.target.value) ?? null)}
              className={FIELD}
            >
              <option value="">Nobody yet</option>
              {owners.map((o) => (
                <option key={o.oid} value={o.oid}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {kind === "ble_gateway" && (
        <div className="flex items-start justify-between gap-4 rounded-lg bg-slate-800/40 p-3">
          <div>
            <p className="text-sm font-medium text-slate-200">Move {terms.item.plural.toLowerCase()} into this room</p>
            <p className="text-sm text-slate-500">
              When on, a tag placed in this room changes where its {itemWord} is on file. When off, it only changes
              where the {itemWord} was last seen.
            </p>
          </div>
          <Toggle label="Move into this room" checked={updatesLocation} onChange={setUpdatesLocation} />
        </div>
      )}

      {isTag && (
        <details className="rounded-lg bg-slate-800/40 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-200">Tag options</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Missing after (minutes)" hint="Unheard this long and it is reported missing. 0 never. Blank uses the default.">
              <input value={missingMinutes} onChange={(e) => setMissingMinutes(e.target.value)} inputMode="numeric" placeholder="10" className={FIELD} />
            </Field>
            <Field label="Telemetry MAC" hint="For an iBeacon or Eddystone tag that sends its battery in separate TLM frames from this address.">
              <input value={bleMac} onChange={(e) => setBleMac(e.target.value)} placeholder="AC:23:3F:A1:B2:C3" className={FIELD} />
            </Field>
            <Field label="Battery full / empty (mV)" hint="For batteries reported in millivolts. Defaults suit a coin cell: 3000 and 2000.">
              <div className="flex gap-2">
                <input value={fullMv} onChange={(e) => setFullMv(e.target.value)} inputMode="numeric" placeholder="3000" aria-label="Full" className={FIELD} />
                <input value={emptyMv} onChange={(e) => setEmptyMv(e.target.value)} inputMode="numeric" placeholder="2000" aria-label="Empty" className={FIELD} />
              </div>
            </Field>
            <Field label="Signal at 1 m (dBm)" hint="Optional; for your reference.">
              <input value={txPower} onChange={(e) => setTxPower(e.target.value)} inputMode="numeric" placeholder="-59" className={FIELD} />
            </Field>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={afterHours} onChange={(e) => setAfterHours(e.target.checked)} />
            Alert when it changes room outside working hours
          </label>
        </details>
      )}

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
        Disabled: ignore it
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
