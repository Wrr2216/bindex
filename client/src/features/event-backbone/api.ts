import { req } from "../../api/client";
import type {
  AuditEntry,
  AuditFilters,
  AuditPage,
  AuditStatus,
  DeliveryStatus,
  EventTypeInfo,
  VerifyResult,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointInput,
} from "./types";

function query(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const auditLogApi = {
  list: (filters: AuditFilters, before?: number | null) =>
    req<AuditPage>(`/api/audit-log${query({ ...filters, before: before ?? undefined, limit: 50 })}`),
  get: (id: number) => req<AuditEntry>(`/api/audit-log/${id}`),
  status: () => req<AuditStatus>("/api/audit-log/status"),
  verify: () => req<VerifyResult>("/api/audit-log/verify"),
  checkpoint: () => req<AuditEntry>("/api/audit-log/checkpoint", { method: "POST" }),
  /** A plain link: the browser downloads the streamed file itself. */
  exportUrl: (format: "ndjson" | "csv", filters: AuditFilters) =>
    `/api/audit-log/export${query({ ...filters, format })}`,
};

export const webhooksApi = {
  list: () => req<{ endpoints: WebhookEndpoint[] }>("/api/webhooks").then((r) => r.endpoints),
  catalog: () => req<{ types: EventTypeInfo[] }>("/api/webhooks/catalog").then((r) => r.types),
  create: (input: WebhookEndpointInput) =>
    req<WebhookEndpoint & { secret: string }>("/api/webhooks", { method: "POST", ...json(input) }),
  update: (id: string, patch: Partial<WebhookEndpointInput>) =>
    req<WebhookEndpoint>(`/api/webhooks/${id}`, { method: "PATCH", ...json(patch) }),
  remove: (id: string) => req<void>(`/api/webhooks/${id}`, { method: "DELETE" }),
  rotateSecret: (id: string) => req<{ secret: string }>(`/api/webhooks/${id}/rotate-secret`, { method: "POST" }),
  ping: (id: string) => req<WebhookDelivery>(`/api/webhooks/${id}/ping`, { method: "POST" }),
  deliveries: (id: string, opts: { status?: DeliveryStatus | ""; before?: number | null } = {}) =>
    req<{ deliveries: WebhookDelivery[]; nextBefore: number | null }>(
      `/api/webhooks/${id}/deliveries${query({ status: opts.status, before: opts.before ?? undefined, limit: 25 })}`,
    ),
  redeliver: (deliveryId: number) =>
    req<WebhookDelivery>(`/api/webhooks/deliveries/${deliveryId}/redeliver`, { method: "POST" }),
};
