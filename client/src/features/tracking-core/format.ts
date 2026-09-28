import type { DeviceKind, Direction, SightingTech } from "./types";

export const KIND_LABELS: Record<DeviceKind, string> = {
  rfid_reader: "RFID reader",
  rfid_portal: "RFID portal (door or dock)",
  ble_gateway: "BLE gateway",
  ble_beacon: "BLE room beacon",
  ble_tag: "BLE tag",
  gps_tracker: "GPS tracker",
  nfc_reader: "NFC reader",
  mobile: "Phone or handheld",
};

/** What each kind is for, shown under the kind picker. */
export const KIND_HELP: Record<DeviceKind, string> = {
  rfid_reader: "A fixed or handheld UHF reader. Give it a zone if it stays in one place.",
  rfid_portal: "Antennas on both sides of a doorway, so each pass has a direction.",
  ble_gateway: "Listens for Bluetooth tags in a zone.",
  ble_beacon: "Fixed in a room so phones can tell where they are.",
  ble_tag: "Attached to something you want to follow.",
  gps_tracker: "Attached to something that travels.",
  nfc_reader: "A tap reader at a desk or doorway.",
  mobile: "A phone or handheld that posts what it scans.",
};

export const DEVICE_KINDS = Object.keys(KIND_LABELS) as DeviceKind[];

/** Kinds that post reads and so need an ingest token. */
export const REPORTING_KINDS: DeviceKind[] = [
  "rfid_reader",
  "rfid_portal",
  "ble_gateway",
  "gps_tracker",
  "nfc_reader",
  "mobile",
];

/** Kinds whose reads reach the Building Audit channel. */
export const RFID_KINDS: DeviceKind[] = ["rfid_reader", "rfid_portal", "nfc_reader", "mobile"];

/** Kinds that are attached to an asset rather than installed in a zone. */
export const ATTACHED_KINDS: DeviceKind[] = ["ble_tag", "gps_tracker"];

export const TECH_LABELS: Record<SightingTech, string> = {
  rfid: "RFID",
  ble: "Bluetooth",
  gps: "GPS",
  nfc: "NFC",
  barcode: "Barcode",
  manual: "Manual",
};

export const DIRECTION_LABELS: Record<Direction, string> = { in: "In", out: "Out" };

/** "12 s ago", "5 min ago", "3 h ago", then a date. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "Never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 5) return "Just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** A map of the point on OpenStreetMap, which needs no key or setup. */
export const mapUrl = (lat: number, lng: number) =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;

/** The channel a reader's reads arrive on in the Building Audit screen. */
export const channelOf = (d: { id: string; externalId: string | null }) => d.externalId || d.id;
