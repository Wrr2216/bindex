import { req } from "../../api/client";
import type {
  Card,
  JobProgress,
  KioskEntry,
  KioskPage,
  Observation,
  PlaceResult,
  PlacementJobSummary,
  Proposals,
  ReadersStatus,
  RoomMapRow,
  RoomStatus,
  SweepResult,
} from "./types";

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | boolean | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

const job = (id: string) => `/api/placement/jobs/${id}`;

export type Roots = { originRootId?: string | null; destinationRootId?: string | null; overwrite?: boolean };

export const placementApi = {
  jobs: () => req<{ jobs: PlacementJobSummary[] }>("/api/placement/jobs").then((r) => r.jobs),
  progress: (id: string) => req<JobProgress>(`${job(id)}/progress`),
  observations: (id: string, limit = 100) =>
    req<{ observations: Observation[] }>(`${job(id)}/observations${query({ limit })}`).then((r) => r.observations),
  setFloorColors: (id: string, colors: Record<string, string>) =>
    req<{ colors: Record<string, string> }>(`${job(id)}/floor-colors`, json("PUT", { colors })),

  lookup: (id: string, code: string, opts: { shipmentId?: string | null; record?: boolean } = {}) =>
    req<Card>(`${job(id)}/lookup`, json("POST", { code, ...opts })),
  place: (id: string, jobItemIds: string[], code?: string | null) =>
    req<PlaceResult>(`${job(id)}/place`, json("POST", { jobItemIds, code })),
  markMissing: (id: string, jobItemIds: string[], note?: string) =>
    req<{ missing: number; already: number; blocked: { jobItemId: string; reason: string }[] }>(
      `${job(id)}/mark-missing`,
      json("POST", { jobItemIds, note }),
    ),
  sweep: (id: string, locationId: string, codes: string[], nested: boolean) =>
    req<SweepResult>(`${job(id)}/sweep`, json("POST", { locationId, codes, nested })),
  room: (id: string, locationId: string, nested: boolean) =>
    req<RoomStatus>(`${job(id)}/rooms/${locationId}${query({ nested: nested || undefined })}`),
  kiosk: (id: string, params: { deviceId?: string; locationId?: string; since?: number }) =>
    req<KioskPage>(`${job(id)}/kiosk${query(params)}`),
  kioskScan: (id: string, code: string, params: { deviceId?: string; locationId?: string }) =>
    req<{ entry: KioskEntry | null }>(`${job(id)}/kiosk/scan`, json("POST", { code, ...params })).then((r) => r.entry),

  proposals: (id: string, roots: Roots) => {
    // An empty root is sent as an empty parameter ("no root"); a missing one
    // means the job's own.
    const q = new URLSearchParams();
    if (roots.overwrite) q.set("overwrite", "true");
    if (roots.originRootId !== undefined) q.set("originRootId", roots.originRootId ?? "");
    if (roots.destinationRootId !== undefined) q.set("destinationRootId", roots.destinationRootId ?? "");
    const s = q.toString();
    return req<Proposals>(`${job(id)}/proposals${s ? `?${s}` : ""}`);
  },
  applyProposals: (id: string, roots: Roots & { jobItemIds?: string[] }) =>
    req<{ updated: number }>(`${job(id)}/proposals/apply`, json("POST", roots)),
  roomMap: (id: string) => req<{ rows: RoomMapRow[] }>(`${job(id)}/room-map`).then((r) => r.rows),
  setRoomMap: (id: string, rows: { originLocationId: string; destinationLocationId: string }[]) =>
    req<{ rows: RoomMapRow[] }>(`${job(id)}/room-map`, json("PUT", { rows })).then((r) => r.rows),

  readers: () => req<ReadersStatus>("/api/placement/readers"),
  setReader: (deviceId: string, patch: { confirm?: boolean; nested?: boolean }) =>
    req<ReadersStatus>(`/api/placement/readers/${deviceId}`, json("PATCH", patch)),

  /**
   * The room this person's phone is in, from Bluetooth room beacons, when
   * that feature is installed. Anything else (not installed, no room, an
   * answer in a shape this does not know) is null.
   */
  bleRoom: async (): Promise<string | null> => {
    try {
      const r = await req<Record<string, unknown>>("/api/ble/me/room");
      const pick = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
      const nested = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
      return (
        pick(r.locationId) ??
        pick(nested(r.room).locationId) ??
        pick(nested(r.room).id) ??
        pick(nested(r.location).id) ??
        null
      );
    } catch {
      return null;
    }
  },
};
