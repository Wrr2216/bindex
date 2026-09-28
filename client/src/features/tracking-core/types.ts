/** Client-side shapes for the tracking core. Mirrors server/src/services/tracking. */

export type DeviceKind =
  | "rfid_reader"
  | "rfid_portal"
  | "ble_gateway"
  | "ble_beacon"
  | "ble_tag"
  | "gps_tracker"
  | "nfc_reader"
  | "mobile";

export type SightingTech = "rfid" | "ble" | "gps" | "nfc" | "barcode" | "manual";

export type Direction = "in" | "out";

export type PortalSide = "inside" | "outside";

/**
 * Stored device settings. Only the keys this feature edits are typed; others
 * (added by BLE or GPS) are kept as they are when a device is saved.
 */
export interface DeviceSettings {
  rssiFloor?: number | null;
  dedupSeconds?: number | null;
  antennaZones?: Record<string, string>;
  portal?: {
    sides: Record<string, PortalSide>;
    windowSeconds?: number;
    inLocationId?: string | null;
    outLocationId?: string | null;
  };
  [key: string]: unknown;
}

export interface TrackingDevice {
  id: string;
  kind: DeviceKind;
  name: string;
  externalId: string | null;
  locationId: string | null;
  locationName: string | null;
  itemId: string | null;
  itemName: string | null;
  itemAssetCode: string | null;
  unitId: string | null;
  unitLabel: string | null;
  unitAssetCode: string | null;
  updatesLocation: boolean;
  settings: DeviceSettings;
  hasToken: boolean;
  tokenLast4: string | null;
  batteryPct: number | null;
  lastSeenAt: string | null;
  lastLat: number | null;
  lastLng: number | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DevicePayload {
  kind: DeviceKind;
  name: string;
  externalId?: string | null;
  locationId?: string | null;
  itemId?: string | null;
  unitId?: string | null;
  updatesLocation?: boolean;
  settings?: DeviceSettings;
  disabled?: boolean;
  issueToken?: boolean;
}

/** A device with its token, returned only when one is issued. */
export interface DeviceWithToken {
  device: TrackingDevice;
  token: string | null;
}

export interface Sighting {
  id: number;
  observedAt: string;
  receivedAt: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceKind: DeviceKind | null;
  tech: SightingTech;
  code: string | null;
  itemId: string | null;
  itemName: string | null;
  itemAssetCode: string | null;
  unitId: string | null;
  unitLabel: string | null;
  unitAssetCode: string | null;
  locationId: string | null;
  locationName: string | null;
  rssi: number | null;
  antenna: number | null;
  direction: Direction | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  meta: Record<string, unknown> | null;
}

export interface Position {
  itemId: string;
  itemName: string;
  itemAssetCode: string;
  unitId: string | null;
  unitLabel: string | null;
  unitAssetCode: string | null;
  tech: SightingTech;
  locationId: string | null;
  locationName: string | null;
  previousLocationId: string | null;
  previousLocationName: string | null;
  recordedLocationId: string | null;
  recordedLocationName: string | null;
  lat: number | null;
  lng: number | null;
  deviceId: string | null;
  deviceName: string | null;
  deviceKind: DeviceKind | null;
  observedAt: string;
  enteredAt: string | null;
}

export interface SightingPage {
  sightings: Sighting[];
  /** Pass back as `before` for the next, older page. */
  next: string | null;
}

export interface FeedPage {
  cursor: number;
  sightings: Sighting[];
}
