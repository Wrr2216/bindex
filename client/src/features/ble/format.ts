import type { AlertKind, BeaconFrame, BleKind } from "./types";

export { ago } from "../tracking-core/format";

export const BLE_KIND_LABELS: Record<BleKind, string> = {
  ble_gateway: "Gateway",
  ble_beacon: "Room beacon",
  ble_tag: "Tag",
  mobile: "Phone",
};

export const BLE_KIND_HELP: Record<BleKind, string> = {
  ble_gateway: "Listens for tags. Install one per room, dock or zone; it reports what it hears.",
  ble_beacon: "Fixed in a room so a phone can tell which room it is in.",
  ble_tag: "Attached to equipment, a pallet or a vault. Gateways hear it and place it in a room.",
  mobile: "A phone running a beacon scanner. It reports room beacons, placing its person in a room.",
};

export const FRAME_LABELS: Record<BeaconFrame, string> = {
  ibeacon: "iBeacon",
  altbeacon: "AltBeacon",
  eddystone_uid: "Eddystone-UID",
  eddystone_url: "Eddystone-URL",
  eddystone_tlm: "Eddystone-TLM",
  eddystone_eid: "Eddystone-EID",
  none: "No beacon frame",
};

export const ALERT_LABELS: Record<AlertKind, string> = {
  missing: "Missing",
  after_hours_move: "Moved out of hours",
  battery_low: "Battery low",
};

/** How a beacon names itself, for the identity editor. */
export type IdentityScheme = "ibeacon" | "eddystone" | "altbeacon" | "mac" | "other";

export type IdentityParts = {
  scheme: IdentityScheme;
  uuid: string;
  major: string;
  minor: string;
  namespace: string;
  instance: string;
  mac: string;
  other: string;
};

export const EMPTY_PARTS: IdentityParts = {
  scheme: "ibeacon",
  uuid: "",
  major: "",
  minor: "",
  namespace: "",
  instance: "",
  mac: "",
  other: "",
};

/** Split a stored identity back into the editor's fields. */
export function splitIdentity(id: string | null | undefined): IdentityParts {
  if (!id) return { ...EMPTY_PARTS };
  const [prefix, ...rest] = id.split(":");
  switch (prefix) {
    case "ibeacon":
    case "altbeacon":
      return { ...EMPTY_PARTS, scheme: prefix, uuid: rest[0] ?? "", major: rest[1] ?? "", minor: rest[2] ?? "" };
    case "eddystone":
      return { ...EMPTY_PARTS, scheme: "eddystone", namespace: rest[0] ?? "", instance: rest[1] ?? "" };
    case "mac":
      return { ...EMPTY_PARTS, scheme: "mac", mac: rest.join(":") };
  }
  return { ...EMPTY_PARTS, scheme: "other", other: id };
}

/** The identity the editor's fields describe. The server checks and canonicalises it. */
export function joinIdentity(p: IdentityParts): string {
  switch (p.scheme) {
    case "ibeacon":
    case "altbeacon":
      return `${p.scheme}:${p.uuid.trim()}:${p.major.trim()}:${p.minor.trim()}`;
    case "eddystone":
      return `eddystone:${p.namespace.trim()}:${p.instance.trim()}`;
    case "mac":
      return `mac:${p.mac.trim()}`;
    default:
      return p.other.trim();
  }
}

/** A short, readable form of an identity for lists. */
export function shortIdentity(id: string | null | undefined): string {
  if (!id) return "";
  const p = splitIdentity(id);
  switch (p.scheme) {
    case "ibeacon":
      return `iBeacon ${p.uuid.slice(0, 8)}… ${p.major}/${p.minor}`;
    case "altbeacon":
      return `AltBeacon ${p.uuid.slice(0, 8)}… ${p.major}/${p.minor}`;
    case "eddystone":
      return `Eddystone ${p.namespace.slice(0, 6)}… ${p.instance}`;
    case "mac":
      return p.mac;
    default:
      return id;
  }
}

/** Signal strength in words, which reads better than dBm to most people. */
export function signalWord(rssi: number | null | undefined): string {
  if (rssi === null || rssi === undefined) return "";
  if (rssi >= -60) return "strong";
  if (rssi >= -75) return "good";
  if (rssi >= -88) return "weak";
  return "faint";
}

export const dbm = (rssi: number | null | undefined) =>
  rssi === null || rssi === undefined ? "" : `${Math.round(rssi)} dBm`;
