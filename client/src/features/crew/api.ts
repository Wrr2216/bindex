import { req } from "../../api/client";
import type {
  Candidate,
  CheckInOutcome,
  Credential,
  Checkin,
  CredentialStatus,
  CredentialType,
  CrewJob,
  CrewPolicy,
  CrewStatus,
  DigestResult,
  ExpiringCredential,
  JobOption,
  JobTypePolicy,
  Light,
  Roster,
  Timesheet,
  VerifierResult,
  Worker,
  WorkerBrief,
  WorkerDetail,
  WorkerSummary,
} from "./types";

/** Client calls for /api/crew. */

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | boolean | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** The viewer's time zone: expiry dates are judged on the viewer's calendar day. */
export const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export type WorkerInput = {
  name: string;
  company?: string | null;
  role?: string | null;
  badgeCode?: string;
  phone?: string | null;
  active?: boolean;
  notes?: string | null;
  photoAttachmentId?: string | null;
};

export type CredentialInput = {
  typeId?: string;
  issuer?: string | null;
  number?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  status?: CredentialStatus;
  notes?: string | null;
};

export type CredentialTypeInput = {
  key?: string;
  name: string;
  description?: string | null;
  validityMonths?: number | null;
  warnDays?: number;
  active?: boolean;
};

export type WorkerFilters = {
  q?: string;
  company?: string;
  active?: "true" | "false" | "all";
  light?: Light | "none";
  credentialType?: string;
  expiring?: number;
};

export type CheckInInput = {
  code?: string;
  workerId?: string;
  via?: string;
  overrideReason?: string;
  switchJob?: boolean;
  note?: string;
};

export type TimesheetQuery = { jobId?: string; workerId?: string; from?: string; to?: string };

export const crewApi = {
  status: () => req<CrewStatus>("/api/crew/status"),

  credentialTypes: (all = false) => req<CredentialType[]>(`/api/crew/credential-types${query({ all: all || undefined })}`),
  createCredentialType: (input: CredentialTypeInput) => req<CredentialType>("/api/crew/credential-types", json("POST", input)),
  updateCredentialType: (id: string, patch: Partial<Omit<CredentialTypeInput, "key">>) =>
    req<CredentialType>(`/api/crew/credential-types/${id}`, json("PATCH", patch)),
  deleteCredentialType: (id: string) => req<void>(`/api/crew/credential-types/${id}`, { method: "DELETE" }),

  jobTypePolicies: () => req<JobTypePolicy[]>("/api/crew/job-types"),
  setJobTypePolicy: (id: string, body: { required: string[]; policy: CrewPolicy; overrideAdminOnly: boolean }) =>
    req<JobTypePolicy>(`/api/crew/job-types/${id}/policy`, json("PUT", body)),

  workers: (filters: WorkerFilters = {}) =>
    req<{ workers: WorkerSummary[]; companies: string[] }>(`/api/crew/workers${query({ ...filters, tz: tz() })}`),
  worker: (id: string) => req<WorkerDetail>(`/api/crew/workers/${id}${query({ tz: tz() })}`),
  workerByBadge: (code: string) =>
    req<{ id: string; name: string; active: boolean }>(`/api/crew/workers/by-badge/${encodeURIComponent(code)}`),
  createWorker: (input: WorkerInput) => req<Worker>("/api/crew/workers", json("POST", input)),
  updateWorker: (id: string, patch: Partial<WorkerInput>) => req<Worker>(`/api/crew/workers/${id}`, json("PATCH", patch)),
  deleteWorker: (id: string) => req<void>(`/api/crew/workers/${id}`, { method: "DELETE" }),
  reissueBadge: (id: string) => req<Worker>(`/api/crew/workers/${id}/reissue-badge`, { method: "POST" }),
  verify: (id: string) => req<VerifierResult>(`/api/crew/workers/${id}/verify`, { method: "POST" }),

  addCredential: (workerId: string, input: CredentialInput) =>
    req<Credential>(`/api/crew/workers/${workerId}/credentials`, json("POST", input)),
  updateCredential: (id: string, patch: Omit<CredentialInput, "typeId">) =>
    req<Credential>(`/api/crew/credentials/${id}`, json("PATCH", patch)),
  deleteCredential: (id: string) => req<void>(`/api/crew/credentials/${id}`, { method: "DELETE" }),

  jobs: () => req<CrewJob[]>("/api/crew/jobs"),
  allJobs: () => req<JobOption[]>("/api/jobs"),
  roster: (jobId: string) => req<Roster>(`/api/crew/jobs/${jobId}/roster${query({ tz: tz() })}`),
  candidates: (jobId: string, q: string) => req<Candidate[]>(`/api/crew/jobs/${jobId}/candidates${query({ q, tz: tz() })}`),
  checkIn: (jobId: string, input: CheckInInput) =>
    req<CheckInOutcome>(`/api/crew/jobs/${jobId}/checkins`, json("POST", { ...input, tz: tz() })),
  checkOutByCode: (jobId: string, input: { code?: string; workerId?: string; breakMinutes?: number }) =>
    req<{ checkin: Checkin; worker: WorkerBrief }>(`/api/crew/jobs/${jobId}/checkout`, json("POST", input)),
  checkOutAll: (jobId: string) => req<{ count: number }>(`/api/crew/jobs/${jobId}/checkout-all`, json("POST", {})),
  checkOut: (id: string, input: { breakMinutes?: number; at?: string | null } = {}) =>
    req<Checkin>(`/api/crew/checkins/${id}/checkout`, json("POST", input)),
  updateCheckin: (id: string, patch: { checkedInAt?: string; checkedOutAt?: string | null; breakMinutes?: number; notes?: string | null }) =>
    req<Checkin>(`/api/crew/checkins/${id}`, json("PATCH", patch)),
  deleteCheckin: (id: string) => req<void>(`/api/crew/checkins/${id}`, { method: "DELETE" }),

  timesheet: (q: TimesheetQuery) => req<Timesheet>(`/api/crew/timesheet${query({ ...q, tz: tz() })}`),
  timesheetUrl: (q: TimesheetQuery) => `/api/crew/timesheet.xlsx${query({ ...q, tz: tz() })}`,

  expiring: (days: number) => req<ExpiringCredential[]>(`/api/crew/expiring${query({ days, tz: tz() })}`),
  sendDigest: () => req<DigestResult>("/api/crew/expiry-digest", json("POST", { tz: tz() })),

  badgePngUrl: (id: string, version?: string) => `/api/crew/workers/${id}/badge.png${query({ v: version })}`,
  badgePdfUrl: (id: string, layout: "card" | "sheet" = "card") => `/api/crew/workers/${id}/badge.pdf${query({ layout })}`,
  badgesPdfUrl: (ids: string[], layout: "card" | "sheet") => `/api/crew/badges.pdf${query({ ids: ids.join(","), layout })}`,
};

