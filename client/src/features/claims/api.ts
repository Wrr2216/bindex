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
 * The portal's calls. A portal visitor has no session, so these send no
 * cookie: the token in the path is the only credential.
 */
async function portalReq<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "omit",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText, body.details);
  return body as T;
}

export const portalClaimsApi = {
  view: (token: string) => portalReq<PortalView>(`/api/claims-portal/${encodeURIComponent(token)}`),
  file: (
    token: string,
    input: {
      type: ClaimType;
      title?: string | null;
      description: string;
      occurredAt?: string | null;
      contactEmail?: string | null;
      lines: { jobItemId: string; damageDescription?: string | null; estimatedCents?: number | null }[];
    },
  ) =>
    portalReq<{ code: string; status: ClaimStatus; title: string; lines: number; estimatedTotalCents: number | null }>(
      `/api/claims-portal/${encodeURIComponent(token)}/claims`,
      json("POST", input),
    ),
};
