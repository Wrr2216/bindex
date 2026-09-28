/** Client-side shapes for Bluetooth presence. Mirrors server/src/services/ble. */

export type BleKind = "ble_gateway" | "ble_beacon" | "ble_tag" | "mobile";

export type BeaconFrame =
  | "ibeacon"
  | "altbeacon"
  | "eddystone_uid"
  | "eddystone_url"
  | "eddystone_tlm"
  | "eddystone_eid"
  | "none";

export interface BleOptions {
  rssiOffset: number;
  txPower: number | null;
  bleMac: string | null;
  missingMinutes: number | null;
  afterHoursAlert: boolean;
  batteryFullMv: number | null;
  batteryEmptyMv: number | null;
  userOid: string | null;
  userName: string | null;
}

export type BleOptionsPatch = { [K in keyof BleOptions]?: BleOptions[K] | null };

export interface BleDevice {
  id: string;
  kind: BleKind;
  name: string;
  externalId: string | null;
  identities: string[];
  locationId: string | null;
  locationName: string | null;
  itemId: string | null;
  itemName: string | null;
  unitId: string | null;
  updatesLocation: boolean;
  disabled: boolean;
  hasToken: boolean;
  tokenLast4: string | null;
  batteryPct: number | null;
  lastSeenAt: string | null;
  lastLat: number | null;
  lastLng: number | null;
  ble: BleOptions;
  presence: { locationId: string | null; locationName: string | null; missingSince: string | null } | null;
  room: { locationId: string; locationName: string; expiresAt: string } | null;
}

export interface BleDevicePayload {
  kind: BleKind;
  name: string;
  externalId?: string | null;
  locationId?: string | null;
  itemId?: string | null;
  unitId?: string | null;
  updatesLocation?: boolean;
  disabled?: boolean;
  ble?: BleOptionsPatch;
}

export interface TagPresence {
  tagKey: string;
  tagId: string | null;
  tagName: string | null;
  identity: string;
  itemId: string | null;
  itemName: string | null;
  itemAssetCode: string | null;
  unitId: string | null;
  unitLabel: string | null;
  locationId: string | null;
  locationName: string | null;
  previousLocationId: string | null;
  previousLocationName: string | null;
  zoneSince: string | null;
  gatewayId: string | null;
  gatewayName: string | null;
  rssi: number | null;
  lastHeardAt: string;
  missingSince: string | null;
  batteryPct: number | null;
  batteryMv: number | null;
  temperatureC: number | null;
}

export interface ZoneOccupancy {
  locationId: string | null;
  locationName: string | null;
  gateways: { id: string; name: string; lastSeenAt: string | null; disabled: boolean }[];
  present: TagPresence[];
  missing: TagPresence[];
}

export interface QuietTag {
  tagKey: string;
  tagId: string | null;
  tagName: string | null;
  identity: string | null;
  itemId: string | null;
  itemName: string | null;
  lastHeardAt: string | null;
  locationId: string | null;
  locationName: string | null;
  missingSince: string | null;
  batteryPct: number | null;
}

export interface BatteryRow {
  id: string;
  kind: BleKind;
  name: string;
  externalId: string | null;
  batteryPct: number;
  batteryMv: number | null;
  lastSeenAt: string | null;
  itemId: string | null;
  itemName: string | null;
  locationId: string | null;
  locationName: string | null;
}

export type AlertKind = "missing" | "after_hours_move" | "battery_low";

export interface BleAlert {
  id: number;
  kind: AlertKind;
  tagKey: string | null;
  deviceId: string | null;
  itemId: string | null;
  locationId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
  notifiedAt: string | null;
}

export interface HeardBy {
  gatewayId: string;
  gatewayName: string | null;
  zoneId: string | null;
  zoneName: string | null;
  rssi: number | null;
  samples: number;
  lastAt: number;
}

export interface ItemTagPresence extends TagPresence {
  heard: HeardBy[];
  candidateZoneId: string | null;
  candidateZoneName: string | null;
}

export interface HeardAdvert {
  key: string;
  gatewayId: string;
  identity: string | null;
  mac: string | null;
  frame: BeaconFrame;
  name: string | null;
  url: string | null;
  txPower: number | null;
  rssi: number | null;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface MyRoom {
  locationId: string;
  locationName: string;
  since: string;
  observedAt: string;
  expiresAt: string;
  phoneId: string;
  phoneName: string | null;
  beaconName: string | null;
}

export interface BleStatus {
  presence: { windowSeconds: number; smoothing: string; hysteresisDb: number; dwellSeconds: number; minSamples: number };
  missingMinutes: number;
  storeSeconds: number;
  phoneRoomSeconds: number;
  batteryLowPct: number;
  workHours: { configured: boolean; text: string | null; error: string | null; timeZone: string };
  mqtt: {
    configured: boolean;
    connected: boolean;
    url: string | null;
    topics: string[];
    messages: number;
    rejected: number;
    lastMessageAt: string | null;
    lastError: string | null;
  };
  counts: { gateways: number; beacons: number; tags: number; phones: number };
  engine: { tags: number };
}

export interface CalibrationGatewayReading {
  gatewayId: string;
  name: string;
  zoneId: string | null;
  offset: number;
  samples: number;
  medianRaw: number | null;
  medianAdjusted: number | null;
  min: number | null;
  max: number | null;
  spread: number | null;
}

export interface Calibration {
  id: string;
  tagId: string;
  tagName: string;
  locationId: string;
  locationName: string | null;
  startedAt: string;
  endsAt: string;
  done: boolean;
  readings: number;
  summary: {
    targetZoneId: string;
    winnerZoneId: string | null;
    margin: number | null;
    ok: boolean;
    gateways: CalibrationGatewayReading[];
    suggestions: { gatewayId: string; name: string; currentOffset: number; suggestedOffset: number }[];
    notes: string[];
  };
}
