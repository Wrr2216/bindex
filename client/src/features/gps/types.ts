/** Client-side shapes for GPS tracking. Mirrors server/src/services/gps. */

import type { TrackingDevice } from "../tracking-core/types";

export interface MapConfig {
  tileUrl: string;
  attribution: string;
  maxZoom: number;
  maxSpeedMps: number;
  batteryLowPct: number;
  /** Whether projects, jobs and shipments are on, so shipment screens exist. */
  jobs: boolean;
  endpoints: { osmand: string; traccar: string; batch: string };
}

export type SpeedUnit = "kn" | "mps" | "kmh" | "mph";

export type TrackerStatus = "available" | "assigned" | "awaiting_return" | "disposed";

export interface TrackerSettings {
  maxSpeedMps: number | null;
  singleUse: boolean;
  speedUnit: SpeedUnit | null;
  relay: boolean;
  batteryLowPct: number | null;
}

export interface TrackerLink {
  id: string;
  deviceId: string;
  shipmentId: string | null;
  vehicleLocationId: string | null;
  originGeofenceId: string | null;
  destinationGeofenceId: string | null;
  assignedAt: string;
  assignedBy: string | null;
  endedAt: string | null;
  endReason: string | null;
  endedBy: string | null;
  deviceName: string | null;
  shipmentCode: string | null;
  shipmentName: string | null;
  shipmentStatus: string | null;
  jobId: string | null;
  jobCode: string | null;
  vehicleName: string | null;
  originName: string | null;
  destinationName: string | null;
}

export interface Tracker extends TrackingDevice {
  gps: TrackerSettings;
  status: TrackerStatus;
  statusAt: string | null;
  lastFixAt: string | null;
  lastFixLat: number | null;
  lastFixLng: number | null;
  lastAccuracyM: number | null;
  batteryLow: boolean;
  stale: boolean;
  links: TrackerLink[];
}

export type GeofenceKind = "circle" | "polygon";

export type GeofenceGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "Polygon"; coordinates: [number, number][][] };

export interface Geofence {
  id: string;
  name: string;
  kind: GeofenceKind;
  geometry: GeofenceGeometry;
  radiusM: number | null;
  locationId: string | null;
  locationName: string | null;
  active: boolean;
  dwellSeconds: number;
  color: string | null;
  notes: string | null;
  geometryAt: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  areaM2: number;
}

export interface GeofenceInput {
  name: string;
  kind: GeofenceKind;
  geometry: GeofenceGeometry;
  radiusM?: number | null;
  locationId?: string | null;
  active?: boolean;
  dwellSeconds?: number;
  color?: string | null;
  notes?: string | null;
}

export interface TrailPoint {
  id: number;
  at: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  deviceId: string | null;
  locationId: string | null;
  rejected: string | null;
  outOfOrder: boolean;
}

export interface Trail {
  points: TrailPoint[];
  truncated: boolean;
}

export interface TrackerTrail extends Trail {
  tracker: { id: string; name: string; itemId: string | null; itemName: string | null };
}

export interface GeofenceEvent {
  id: number;
  geofenceId: string | null;
  geofenceName: string;
  locationId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  itemId: string | null;
  itemName: string | null;
  shipmentIds: string[];
  kind: "entered" | "exited";
  occurredAt: string;
  confirmedAt: string;
  lat: number | null;
  lng: number | null;
  auditId: number | null;
}

export interface ShipmentGps {
  originGeofenceId: string | null;
  originName: string | null;
  destinationGeofenceId: string | null;
  destinationName: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  travelledM: number;
  countedUntil: string | null;
  remainingM: number | null;
  speedMps: number | null;
  eta: string | null;
  lastFix: { lat: number; lng: number; at: string; deviceId: string } | null;
  prompt: { status: string; at: string; geofenceId: string | null; reason: string | null } | null;
  waypoints: { geofenceId: string; name: string; at: string }[];
  updatedAt: string | null;
}

export interface ShipmentMap {
  shipment: {
    id: string;
    code: string;
    name: string;
    status: string;
    jobId: string;
    jobCode: string;
    jobName: string;
    vehicleLocationId: string | null;
    vehicleName: string | null;
    departedAt: string | null;
    arrivedAt: string | null;
    eta: string | null;
    distanceKm: number | null;
  };
  gps: ShipmentGps;
  origin: Geofence | null;
  destination: Geofence | null;
  links: TrackerLink[];
  trails: { deviceId: string; deviceName: string | null; points: TrailPoint[]; truncated: boolean }[];
  events: GeofenceEvent[];
  history: { fromStatus: string | null; toStatus: string; actor: string | null; reason: string | null; at: string }[];
}

export interface OpenShipment {
  id: string;
  code: string;
  name: string;
  status: string;
  jobCode: string;
  jobName: string;
}

export interface LinkInput {
  deviceId: string;
  shipmentId?: string | null;
  vehicleLocationId?: string | null;
  originGeofenceId?: string | null;
  destinationGeofenceId?: string | null;
}
