import type {
  SightingDirection,
  SightingTech,
  TrackingDevice,
  TrackingDeviceKind,
} from "../../db/tables/tracking-core";

export type { SightingDirection, SightingTech, TrackingDevice, TrackingDeviceKind };

/**
 * One read, in the shape every adapter produces and recordSightings consumes.
 * Only `code` is usually present; everything else is whatever the hardware
 * reported.
 */
export type NormalizedRead = {
  /**
   * EPC, NFC UID, beacon identity or tracker id. Normalized by the ingest.
   * Leave it empty when a tracker reports its own position: the read is then
   * about the asset the device is attached to.
   */
  code?: string | null;
  /** When the hardware saw it. Defaults to when the server received it. */
  observedAt?: Date | null;
  /** Defaults from the device kind (rfid for readers, ble for gateways...). */
  tech?: SightingTech | null;
  /** dBm. */
  rssi?: number | null;
  antenna?: number | null;
  /** Set when the hardware already knows; otherwise a portal infers it. */
  direction?: SightingDirection | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  /**
   * The zone, when the caller already decided it (a BLE presence engine, a
   * geofence). Never taken from an HTTP payload. `null` means "known to be in
   * no zone"; leave it undefined to let the device's zone apply.
   */
  locationId?: string | null;
  /** The asset, when the caller already resolved it. Skips code resolution. */
  asset?: { itemId: string; unitId: string | null } | null;
  /** Anything vendor-specific worth keeping (phase, channel, read count). */
  meta?: Record<string, unknown> | null;
};

/** How a portal's antennas face. */
export type PortalSide = "inside" | "outside";

export type PortalSettings = {
  /** Antenna port number to the side of the door it faces. */
  sides: Record<string, PortalSide>;
  /**
   * Longest gap between two reads of the same tag that still counts as one
   * pass through the door. Also how long a tag may dwell in the portal field.
   */
  windowSeconds?: number;
  /** Zone an asset is in after passing in. Defaults to the portal's own zone. */
  inLocationId?: string | null;
  /** Zone an asset is in after passing out. Unknown (no zone) when unset. */
  outLocationId?: string | null;
};

/**
 * What lives in tracking_devices.settings. Other features add their own keys
 * (BLE UUID/major/minor, RSSI offset, GPS speed limits); unknown keys are kept.
 */
export type TrackingDeviceSettings = {
  /** Reads weaker than this many dBm are ignored. */
  rssiFloor?: number | null;
  /** Overrides TRACKING_DEDUP_SECONDS for this device. */
  dedupSeconds?: number | null;
  /** A reader whose antennas cover different zones: antenna port to location id. */
  antennaZones?: Record<string, string>;
  /** Only for rfid_portal devices. */
  portal?: PortalSettings;
  [key: string]: unknown;
};

/** The technology a device reports with unless a read says otherwise. */
export const DEFAULT_TECH: Record<TrackingDeviceKind, SightingTech> = {
  rfid_reader: "rfid",
  rfid_portal: "rfid",
  ble_gateway: "ble",
  ble_beacon: "ble",
  ble_tag: "ble",
  gps_tracker: "gps",
  nfc_reader: "nfc",
  mobile: "barcode",
};

/** Kinds that post reads and so get an ingest token when created. */
export const REPORTING_KINDS: readonly TrackingDeviceKind[] = [
  "rfid_reader",
  "rfid_portal",
  "ble_gateway",
  "gps_tracker",
  "nfc_reader",
  "mobile",
];

/** Kinds allowed on the RFID endpoints (/scan and the reader vendor formats). */
export const RFID_KINDS: readonly TrackingDeviceKind[] = [
  "rfid_reader",
  "rfid_portal",
  "nfc_reader",
  "mobile",
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Read a device's settings defensively. The column is free-form jsonb that
 * other features also write to, so nothing here trusts its shape.
 */
export function readSettings(raw: unknown): TrackingDeviceSettings {
  const s = isRecord(raw) ? raw : {};
  const out: TrackingDeviceSettings = { ...s };
  out.rssiFloor = num(s.rssiFloor) ?? null;
  out.dedupSeconds = num(s.dedupSeconds) ?? null;

  const zones: Record<string, string> = {};
  if (isRecord(s.antennaZones)) {
    for (const [k, v] of Object.entries(s.antennaZones)) if (typeof v === "string" && v) zones[k] = v;
  }
  out.antennaZones = zones;

  if (isRecord(s.portal) && isRecord(s.portal.sides)) {
    const sides: Record<string, PortalSide> = {};
    for (const [k, v] of Object.entries(s.portal.sides)) {
      if (v === "inside" || v === "outside") sides[k] = v;
    }
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    out.portal = {
      sides,
      windowSeconds: num(s.portal.windowSeconds),
      inLocationId: str(s.portal.inLocationId),
      outLocationId: str(s.portal.outLocationId),
    };
  } else {
    delete out.portal;
  }
  return out;
}
