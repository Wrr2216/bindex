import { ApiError, req } from "../../api/client";
import type {
  Activity,
  Candidate,
  ClaimDetail,
  ClaimStatus,
  ClaimSummary,
  ClaimType,
  ClaimsMeta,
  EvidencePack,
  LineInput,
  LineProblem,
  PortalView,
  Resolution,
} from "./types";

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | boolean | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;

export type ClaimInput = {
  type: ClaimType;
  title: string;
  description?: string | null;
  category?: string | null;
  jobId?: string | null;
  shipmentId?: string | null;
  locationId?: string | null;
  occurredAt?: string | null;
  carrierReference?: string | null;
  insurerReference?: string | null;
  estimatedTotalCents?: number | null;
  reporterName?: string | null;
  reporterEmail?: string | null;
  relatedClaimId?: string | null;
  lines?: LineInput[];
};

export type ClaimPatch = Partial<Omit<ClaimInput, "lines" | "relatedClaimId">> & {
  approvedTotalCents?: number | null;
  paymentReference?: string | null;
  slaDueAt?: string | null;
};

export type LinePatch = {
  description?: string | null;
  damageDescription?: string | null;
  estimatedCents?: number | null;
  approvedCents?: number | null;
  resolution?: Resolution | null;
  notes?: string | null;
};

export type JobOption = { id: string; code: string; name: string; status: string };

export type ListFilters = {
  status?: string;
  type?: ClaimType;
  kind?: "claim" | "incident";
  jobId?: string;
  assignee?: string;
  q?: string;
  overdue?: boolean;
};

export const claimsApi = {
  meta: () => req<ClaimsMeta>("/api/claims/meta"),
  reviewers: () => req<{ userOid: string; name: string }[]>("/api/claims/reviewers"),
  candidates: (jobId: string, shipmentId?: string | null) =>
    req<Candidate[]>(`/api/claims/candidates${query({ jobId, shipmentId })}`),
  list: (filters: ListFilters = {}) =>
    req<{ claims: ClaimSummary[]; total: number }>(`/api/claims${query(filters)}`),
  create: (input: ClaimInput) => req<ClaimDetail>("/api/claims", json("POST", input)),
  get: (id: string) => req<ClaimDetail>(`/api/claims/${id}`),
  update: (id: string, patch: ClaimPatch) => req<ClaimDetail>(`/api/claims/${id}`, json("PATCH", patch)),
  remove: (id: string) => req<void>(`/api/claims/${id}`, { method: "DELETE" }),
  evidence: (id: string) => req<EvidencePack>(`/api/claims/${id}/evidence`),
  addLines: (id: string, lines: LineInput[]) =>
    req<{ added: number; alreadyOnClaim: number; problems: LineProblem[]; claim: ClaimDetail }>(
      `/api/claims/${id}/lines`,
      json("POST", { lines }),
    ),
  updateLine: (id: string, lineId: string, patch: LinePatch) =>
    req<ClaimDetail>(`/api/claims/${id}/lines/${lineId}`, json("PATCH", patch)),
  removeLine: (id: string, lineId: string) =>
    req<ClaimDetail>(`/api/claims/${id}/lines/${lineId}`, { method: "DELETE" }),
  setStatus: (
    id: string,
    body: { status: ClaimStatus; note?: string | null; paidTotalCents?: number | null; paymentReference?: string | null },
  ) => req<ClaimDetail>(`/api/claims/${id}/status`, json("POST", body)),
  assign: (id: string, body: { userOid: string | null } | { me: true }) =>
    req<ClaimDetail>(`/api/claims/${id}/assign`, json("POST", body)),
  comment: (id: string, body: string) => req<Activity>(`/api/claims/${id}/comments`, json("POST", { body })),
  // Pickers for the new-claim form. Job routes exist only while jobs are on.
  jobs: () => req<JobOption[]>("/api/jobs"),
  job: (id: string) => req<JobOption & { shipments: { id: string; code: string; name: string; status: string }[] }>(`/api/jobs/${id}`),

  pdfUrl: (id: string) => `/api/claims/${id}/claim.pdf${query({ tz: tz() })}`,
  xlsxUrl: (id: string) => `/api/claims/${id}/claim.xlsx${query({ tz: tz() })}`,
};

/**
 * The portal's calls, made the way the portal page makes its own: the link
 * token in a header (never the URL, which ends up in logs), the pass for an
 * emailed code when the browser has one, and no cookie.
 */
export function portalClaimsClient(token: string, getPass: () => string | null = () => null) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { "x-portal-token": token };
    const pass = getPass();
    if (pass) headers["x-portal-pass"] = pass;
    if (init.body) headers["Content-Type"] = "application/json";
    const res = await fetch(`/api/claims-portal${path}`, { ...init, credentials: "omit", headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText, body.details);
    return body as T;
  }
  return {
    view: () => call<PortalView>(""),
    file: (input: {
      type: ClaimType;
      title?: string | null;
      description: string;
      occurredAt?: string | null;
      contactEmail?: string | null;
      lines: { jobItemId: string; damageDescription?: string | null; estimatedCents?: number | null }[];
    }) =>
      call<{ code: string; status: ClaimStatus; title: string; lines: number; estimatedTotalCents: number | null }>(
        "/claims",
        json("POST", input),
      ),
  };
}
