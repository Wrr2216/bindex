import { req } from "../../api/client";
import type {
  DamageSuggestion,
  Finding,
  FindingInput,
  InspectionDetail,
  InspectionInput,
  InspectionKind,
  InspectionStatus,
  InspectionSummary,
  InspectionsMeta,
  ShareLink,
  SignRequest,
  SignoffRole,
} from "./types";

/** Client calls for site inspections. */

/** The fields of a job the inspection screens use. */
export type JobOption = {
  id: string;
  code: string;
  name: string;
  status: string;
  originLocationId: string | null;
  destinationLocationId: string | null;
  originName: string | null;
  destinationName: string | null;
};

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

const base = (id: string) => `/api/inspections/${encodeURIComponent(id)}`;

/** The viewer's time zone, so printed times read the way they would on the wall clock. */
export const viewerTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

let metaPromise: Promise<InspectionsMeta> | null = null;

export const inspectionsApi = {
  meta: () => {
    metaPromise ??= req<InspectionsMeta>("/api/inspections/meta").catch((err) => {
      metaPromise = null;
      throw err;
    });
    return metaPromise;
  },
  list: (filters: { jobId?: string; locationId?: string; kind?: InspectionKind; status?: InspectionStatus; q?: string } = {}) =>
    req<InspectionSummary[]>(`/api/inspections${query(filters)}`),
  get: (id: string) => req<InspectionDetail>(base(id)),
  create: (input: InspectionInput) => req<InspectionDetail>("/api/inspections", json("POST", input)),
  update: (id: string, patch: Partial<InspectionInput>) => req<InspectionDetail>(base(id), json("PATCH", patch)),
  remove: (id: string) => req<void>(base(id), { method: "DELETE" }),
  complete: (id: string) => req<InspectionDetail>(`${base(id)}/complete`, { method: "POST" }),
  reopen: (id: string) => req<InspectionDetail>(`${base(id)}/reopen`, { method: "POST" }),

  addFinding: (id: string, input: FindingInput) => req<Finding>(`${base(id)}/findings`, json("POST", input)),
  updateFinding: (id: string, findingId: string, patch: FindingInput) =>
    req<Finding>(`${base(id)}/findings/${findingId}`, json("PATCH", patch)),
  removeFinding: (id: string, findingId: string) => req<void>(`${base(id)}/findings/${findingId}`, { method: "DELETE" }),
  pair: (id: string, findingId: string, choice: { preFindingId: string | null } | { auto: true }) =>
    req<Finding>(`${base(id)}/findings/${findingId}/pair`, json("POST", choice)),

  readDamage: (id: string, attachmentId: string) =>
    req<{ available: boolean; suggestion: DamageSuggestion | null; message?: string }>(
      `${base(id)}/ai/damage`,
      json("POST", { attachmentId }),
    ),
  matchWithAi: (id: string) =>
    req<{ available: boolean; considered: { pre: number; post: number }; paired: number }>(`${base(id)}/ai/match`, {
      method: "POST",
    }),

  signRequest: (id: string, role: SignoffRole) => req<SignRequest>(`${base(id)}/sign-request${query({ role })}`),
  recordSignoff: (id: string, role: SignoffRole, signatureId: string) =>
    req<InspectionDetail>(`${base(id)}/signoffs`, json("POST", { role, signatureId })),

  reportUrl: (id: string, download = false) => `${base(id)}/report.pdf${query({ tz: viewerTz(), download: download ? 1 : null })}`,

  /** Open jobs to attach an inspection to. Only called when the jobs feature is on. */
  jobs: () => req<JobOption[]>("/api/jobs"),

  shares: (id: string) => req<ShareLink[]>(`${base(id)}/shares`),
  createShare: (id: string, days: number) => req<ShareLink>(`${base(id)}/shares`, json("POST", { days })),
  revokeShare: (id: string, shareId: string) => req<ShareLink>(`${base(id)}/shares/${shareId}`, { method: "DELETE" }),
};
