import { req } from "../../api/client";
import type {
  DeviceKind,
  DevicePayload,
  DeviceWithToken,
  FeedPage,
  Position,
  SightingPage,
  TrackingDevice,
} from "./types";

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const trackingApi = {
  listDevices: (kinds?: DeviceKind[]) =>
    req<{ devices: TrackingDevice[] }>(
      `/api/tracking/devices${kinds?.length ? `?kind=${kinds.join(",")}` : ""}`,
    ).then((r) => r.devices),
  getDevice: (id: string) => req<TrackingDevice>(`/api/tracking/devices/${id}`),
  /** The response carries the device's ingest token: the only time it is shown. */
  createDevice: (payload: DevicePayload) =>
    req<DeviceWithToken>("/api/tracking/devices", { method: "POST", ...json(payload) }),
  updateDevice: (id: string, payload: Partial<DevicePayload>) =>
    req<TrackingDevice>(`/api/tracking/devices/${id}`, { method: "PATCH", ...json(payload) }),
  deleteDevice: (id: string) => req<void>(`/api/tracking/devices/${id}`, { method: "DELETE" }),
  rotateToken: (id: string) =>
    req<{ device: TrackingDevice; token: string }>(`/api/tracking/devices/${id}/rotate-token`, {
      method: "POST",
    }),
  revokeToken: (id: string) =>
    req<TrackingDevice>(`/api/tracking/devices/${id}/token`, { method: "DELETE" }),

  itemPositions: (itemId: string) =>
    req<{ positions: Position[] }>(`/api/tracking/items/${itemId}/positions`).then((r) => r.positions),
  itemSightings: (itemId: string, before?: string | null, limit = 25) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) qs.set("before", before);
    return req<SightingPage>(`/api/tracking/items/${itemId}/sightings?${qs}`);
  },
  present: (locationId: string, withinMinutes?: number) =>
    req<{ present: Position[] }>(
      `/api/tracking/locations/${locationId}/present${withinMinutes ? `?within=${withinMinutes}` : ""}`,
    ).then((r) => r.present),
  feed: (params: { since?: number; deviceId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.since !== undefined) qs.set("since", String(params.since));
    if (params.deviceId) qs.set("deviceId", params.deviceId);
    if (params.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    return req<FeedPage>(`/api/tracking/feed${suffix}`);
  },
};
