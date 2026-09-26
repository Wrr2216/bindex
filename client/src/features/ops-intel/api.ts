import { req } from "../../api/client";
import type {
  AnomalyDetail,
  AnomalyPage,
  JobLoadPlan,
  JobOption,
  OpsMeta,
  OpsSettings,
  OpsSummary,
  Profile,
  ProfileInput,
  RunResult,
  ShipmentCapacity,
  SlottingResult,
  StorageItem,
  StorageReport,
} from "./types";

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | boolean | undefined | null | string[]>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const x of v) q.append(k, x);
    else if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
};

export type AnomalyQuery = {
  status?: "open" | "resolved" | "all";
  rule?: string;
  severity?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

export type PlanQuery = { stops?: string[]; vehicles?: string[]; repack?: boolean };

const planQuery = (p: PlanQuery) =>
  query({ stops: p.stops ?? [], vehicles: (p.vehicles ?? []).join(",") || undefined, repack: p.repack || undefined });

export const opsApi = {
  meta: () => req<OpsMeta>("/api/ops/meta"),
  summary: (days = 30) => req<OpsSummary>(`/api/ops/summary${query({ days })}`),
  anomalies: (q: AnomalyQuery) => req<AnomalyPage>(`/api/ops/anomalies${query(q)}`),
  anomaly: (id: string) => req<AnomalyDetail>(`/api/ops/anomalies/${id}`),
  resolve: (id: string, resolution: "fixed" | "dismissed", note: string) =>
    req<AnomalyDetail>(`/api/ops/anomalies/${id}/resolve`, json("POST", { resolution, note })),
  explain: (id: string) =>
    req<{ available: boolean; explanation: string | null }>(`/api/ops/anomalies/${id}/explain`, { method: "POST" }),
  run: () => req<RunResult>("/api/ops/anomalies/run", { method: "POST" }),
  saveSettings: (patch: Partial<OpsSettings> | Record<string, unknown>) =>
    req<OpsSettings>("/api/ops/settings", json("PUT", patch)),
  storage: (fresh = false) => req<StorageReport>(`/api/ops/storage${query({ fresh: fresh || undefined })}`),
  storageItems: (q: { abc?: string; longStored?: boolean; q?: string; sort?: string; limit?: number; offset?: number }) =>
    req<{ items: StorageItem[]; total: number }>(`/api/ops/storage/items${query(q)}`),
  slotting: () => req<SlottingResult>("/api/ops/slotting"),
  profiles: () => req<{ profiles: Profile[] }>("/api/ops/profiles").then((r) => r.profiles),
  saveProfile: (locationId: string, input: ProfileInput) =>
    req<{ profile: Profile | null }>(`/api/ops/profiles/${locationId}`, json("PUT", input)).then((r) => r.profile),
  deleteProfile: (locationId: string) => req<void>(`/api/ops/profiles/${locationId}`, { method: "DELETE" }),
  loadPlan: (jobId: string, p: PlanQuery) => req<JobLoadPlan>(`/api/ops/load-plans/jobs/${jobId}${planQuery(p)}`),
  loadPlanPdfUrl: (jobId: string, p: PlanQuery) => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const base = planQuery(p);
    return `/api/ops/load-plans/jobs/${jobId}/plan.pdf${base}${tz ? `${base ? "&" : "?"}tz=${encodeURIComponent(tz)}` : ""}`;
  },
  capacities: (jobId?: string) =>
    req<{ shipments: ShipmentCapacity[] }>(`/api/ops/shipments/capacity${query({ jobId })}`).then((r) => r.shipments),
  /** Open jobs to plan, from the jobs API. */
  openJobs: () =>
    Promise.all([
      req<JobOption[]>("/api/jobs?status=planned"),
      req<JobOption[]>("/api/jobs?status=in_progress"),
    ]).then(([a, b]) => [...b, ...a]),
};
