import { req } from "../../api/client";
import type {
  Geofence,
  GeofenceEvent,
  GeofenceInput,
  LinkInput,
  MapConfig,
  OpenShipment,
  ShipmentGps,
  ShipmentMap,
  Trail,
  Tracker,
  TrackerLink,
  TrackerSettings,
  TrackerTrail,
} from "./types";

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export type TrailRange = { from?: string; to?: string; rejected?: boolean; limit?: number };

export const gpsApi = {
  config: () => req<MapConfig>("/api/gps/config"),

  trackers: () => req<{ trackers: Tracker[] }>("/api/gps/trackers").then((r) => r.trackers),
  tracker: (id: string) => req<Tracker>(`/api/gps/trackers/${id}`),
  updateTrackerSettings: (id: string, patch: Partial<TrackerSettings>) =>
    req<Tracker>(`/api/gps/trackers/${id}/settings`, json("PATCH", patch)),
  setTrackerStatus: (id: string, status: "available" | "disposed", note?: string) =>
    req<Tracker>(`/api/gps/trackers/${id}/status`, json("POST", { status, note })),
  trackerTrail: (id: string, range: TrailRange = {}) =>
    req<TrackerTrail>(
      `/api/gps/trackers/${id}/trail${query({ from: range.from, to: range.to, limit: range.limit, rejected: range.rejected ? "true" : undefined })}`,
    ),
  itemTrail: (id: string, range: TrailRange = {}) =>
    req<Trail>(`/api/gps/items/${id}/trail${query({ from: range.from, to: range.to, limit: range.limit })}`),

  geofences: (all = false) =>
    req<{ geofences: Geofence[] }>(`/api/gps/geofences${all ? "?all=true" : ""}`).then((r) => r.geofences),
  createGeofence: (input: GeofenceInput) => req<Geofence>("/api/gps/geofences", json("POST", input)),
  updateGeofence: (id: string, patch: Partial<GeofenceInput>) =>
    req<Geofence>(`/api/gps/geofences/${id}`, json("PATCH", patch)),
  deleteGeofence: (id: string) => req<void>(`/api/gps/geofences/${id}`, { method: "DELETE" }),

  events: (filter: { geofenceId?: string; deviceId?: string; shipmentId?: string; itemId?: string; limit?: number }) =>
    req<{ events: GeofenceEvent[]; next: number | null }>(`/api/gps/events${query(filter)}`),

  links: (filter: { deviceId?: string; shipmentId?: string; active?: boolean }) =>
    req<{ links: TrackerLink[] }>(
      `/api/gps/links${query({ ...filter, active: filter.active ? "true" : undefined })}`,
    ).then((r) => r.links),
  createLink: (input: LinkInput) => req<TrackerLink>("/api/gps/links", json("POST", input)),
  endLink: (id: string) => req<TrackerLink>(`/api/gps/links/${id}/end`, { method: "POST" }),

  openShipments: () => req<{ shipments: OpenShipment[] }>("/api/gps/shipments/open").then((r) => r.shipments),
  shipment: (id: string) => req<ShipmentMap>(`/api/gps/shipments/${id}`),
  dismissPrompt: (id: string) => req<ShipmentGps>(`/api/gps/shipments/${id}/dismiss-prompt`, { method: "POST" }),
};
