import { req } from "../../api/client";
import type {
  BatteryRow,
  BleAlert,
  BleDevice,
  BleDevicePayload,
  BleStatus,
  Calibration,
  HeardAdvert,
  ItemTagPresence,
  MyRoom,
  QuietTag,
  ZoneOccupancy,
} from "./types";

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const bleApi = {
  status: () => req<BleStatus>("/api/ble/status"),
  occupancy: () => req<{ zones: ZoneOccupancy[] }>("/api/ble/occupancy").then((r) => r.zones),
  notSeen: (hours: number) => req<{ tags: QuietTag[] }>(`/api/ble/not-seen?hours=${hours}`).then((r) => r.tags),
  battery: (below?: number) =>
    req<{ below: number; devices: BatteryRow[] }>(`/api/ble/battery${below !== undefined ? `?below=${below}` : ""}`),
  alerts: (opts: { open?: boolean; before?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.open) qs.set("open", "true");
    if (opts.before) qs.set("before", String(opts.before));
    const suffix = qs.toString() ? `?${qs}` : "";
    return req<{ alerts: BleAlert[]; next: number | null }>(`/api/ble/alerts${suffix}`);
  },
  itemPresence: (itemId: string) =>
    req<{ tags: ItemTagPresence[]; attached: number }>(`/api/ble/items/${itemId}/presence`),
  myRoom: () => req<{ room: MyRoom | null }>("/api/ble/me/room").then((r) => r.room),

  listDevices: () => req<{ devices: BleDevice[] }>("/api/ble/devices").then((r) => r.devices),
  /** The response carries a gateway's or phone's ingest token: the only time it is shown. */
  createDevice: (payload: BleDevicePayload) =>
    req<{ device: { id: string; name: string; kind: string }; token: string | null }>("/api/ble/devices", {
      method: "POST",
      ...json(payload),
    }),
  updateDevice: (id: string, payload: Partial<BleDevicePayload>) =>
    req<{ id: string; name: string }>(`/api/ble/devices/${id}`, { method: "PATCH", ...json(payload) }),
  // Deleting and tokens are the tracking core's, shared with every other device.
  deleteDevice: (id: string) => req<void>(`/api/tracking/devices/${id}`, { method: "DELETE" }),
  rotateToken: (id: string) =>
    req<{ device: { id: string; name: string; kind: string }; token: string }>(
      `/api/tracking/devices/${id}/rotate-token`,
      { method: "POST" },
    ),
  heard: (opts: { gatewayId?: string; all?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (opts.gatewayId) qs.set("gatewayId", opts.gatewayId);
    if (opts.all) qs.set("all", "true");
    const suffix = qs.toString() ? `?${qs}` : "";
    return req<{ heard: HeardAdvert[] }>(`/api/ble/heard${suffix}`).then((r) => r.heard);
  },

  startCalibration: (input: { tagId: string; locationId: string; seconds: number }) =>
    req<Calibration>("/api/ble/calibrations", { method: "POST", ...json(input) }),
  calibration: (id: string) => req<Calibration>(`/api/ble/calibrations/${id}`),
  stopCalibration: (id: string) => req<Calibration>(`/api/ble/calibrations/${id}/stop`, { method: "POST" }),
};
