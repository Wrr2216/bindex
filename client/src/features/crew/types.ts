/** Shapes returned by /api/crew. docs/crew.md describes each one. */

export type Light = "green" | "amber" | "red";
export type CredentialStatus = "valid" | "pending" | "expired" | "failed" | "suspended" | "revoked";
export type CrewPolicy = "warn" | "block";
export type CredentialReason =
  | "valid"
  | "expiring"
  | "expired"
  | "missing"
  | "pending"
  | "failed"
  | "suspended"
  | "revoked";

export const CREDENTIAL_STATUSES: CredentialStatus[] = ["valid", "pending", "expired", "failed", "suspended", "revoked"];

export interface CrewStatus {
  verifier: { available: boolean };
  digest: { days: number; hourUtc: number };
  jobs: boolean;
  isAdmin: boolean;
}

export interface CredentialType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  validityMonths: number | null;
  warnDays: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialCheck {
  typeKey: string;
  typeName: string;
  light: Light;
  reason: CredentialReason;
  label: string;
  credentialId: string | null;
  expiresOn: string | null;
  daysLeft: number | null;
  source: "manual" | "verifier" | null;
}

export interface Compliance {
  light: Light;
  checks: CredentialCheck[];
  summary: string;
}

export interface PolicySetting {
  required: string[];
  policy: CrewPolicy;
  overrideAdminOnly: boolean;
}

export interface JobTypePolicy extends PolicySetting {
  jobTypeId: string;
  name: string;
  color: string;
  active: boolean;
}

export interface WorkerBrief {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  badgeCode: string;
  active: boolean;
  photoUrl: string | null;
}

export interface OpenCheckin {
  checkinId: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  since: string;
}

export interface Worker {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  badgeCode: string;
  phone: string | null;
  photoAttachmentId: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerSummary extends Worker {
  photoUrl: string | null;
  light: Light | null;
  checks: CredentialCheck[];
  nextExpiry: { typeName: string; expiresOn: string; daysLeft: number } | null;
  onJob: OpenCheckin | null;
}

export interface Credential {
  id: string;
  workerId: string;
  typeId: string;
  issuer: string | null;
  number: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  status: CredentialStatus;
  source: "manual" | "verifier";
  verifiedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  typeKey: string;
  typeName: string;
  warnDays: number;
  typeActive: boolean;
  documentCount: number;
  light: Light;
  reason: CredentialReason;
  label: string;
  daysLeft: number | null;
}

export interface Checkin {
  id: string;
  jobId: string;
  workerId: string;
  checkedInAt: string;
  checkedOutAt: string | null;
  breakMinutes: number;
  via: string;
  compliance: Light;
  complianceDetail: CredentialCheck[];
  policy: CrewPolicy;
  overrideReason: string | null;
  overriddenBy: string | null;
  overriddenByName: string | null;
  checkedInBy: string | null;
  checkedInByName: string | null;
  checkedOutBy: string | null;
  checkedOutByName: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerDetail extends WorkerSummary {
  photoLargeUrl: string | null;
  credentials: Credential[];
  checkins: (Checkin & { jobCode: string; jobName: string; minutes: number })[];
  totals: { shifts: number; minutes: number };
}

export interface VerifierResult {
  available: boolean;
  ok: boolean;
  found: boolean;
  merged: number;
  unmatched: string[];
  error: string | null;
  checkedAt: string | null;
}

export interface CheckInOutcome {
  status: "checked_in" | "already";
  checkin: Checkin;
  worker: WorkerBrief;
  compliance: Compliance;
  policy: PolicySetting;
  verifier: VerifierResult | null;
  warned: boolean;
  overridden: boolean;
  movedFrom: { jobId: string; jobCode: string } | null;
}

/** `details` of a 409 credentials_blocked. */
export interface BlockedDetails {
  worker: WorkerBrief;
  compliance: Compliance;
  policy: PolicySetting;
  verifier: VerifierResult | null;
  reason: "override_required" | "override_admin_only";
}

/** `details` of a 409 checked_in_elsewhere. */
export interface ElsewhereDetails {
  worker: WorkerBrief;
  jobId: string;
  jobCode: string;
  jobName: string;
  checkinId: string;
  since: string;
}

export interface CrewJob {
  id: string;
  code: string;
  name: string;
  status: string;
  jobTypeId: string | null;
  jobTypeName: string | null;
  jobTypeColor: string | null;
  scheduledStart: string | null;
  onSite: number;
}

export interface RosterEntry extends Checkin {
  worker: WorkerBrief;
  minutes: number;
  current: Compliance;
}

export interface Roster {
  job: {
    id: string;
    code: string;
    name: string;
    status: string;
    jobTypeId: string | null;
    jobTypeName: string | null;
    jobTypeColor: string | null;
  };
  policy: PolicySetting;
  required: { key: string; name: string; warnDays: number }[];
  onSite: RosterEntry[];
  shifts: RosterEntry[];
  workers: { worker: WorkerBrief; minutes: number; shifts: number; onSite: boolean }[];
  totals: { minutes: number; workers: number; onSite: number };
}

export interface Candidate {
  worker: WorkerBrief;
  compliance: Compliance;
  onJob: { workerId: string; jobId: string; jobCode: string } | null;
}

export interface TimesheetRow {
  checkinId: string;
  day: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  workerId: string;
  workerName: string;
  company: string | null;
  badgeCode: string;
  checkedInAt: string;
  checkedOutAt: string | null;
  breakMinutes: number;
  minutes: number;
  open: boolean;
  compliance: Light;
  overrideReason: string | null;
}

export interface TimesheetRosterRow {
  jobId: string;
  jobCode: string;
  jobName: string;
  workerId: string;
  workerName: string;
  company: string | null;
  shifts: number;
  minutes: number;
  onSite: boolean;
  compliance: Light;
  overrides: number;
}

export interface Timesheet {
  rows: TimesheetRow[];
  roster: TimesheetRosterRow[];
  totals: { minutes: number; shifts: number; workers: number };
}

export interface ExpiringCredential {
  workerId: string;
  workerName: string;
  company: string | null;
  typeKey: string;
  typeName: string;
  expiresOn: string;
  daysLeft: number;
}

export interface DigestResult {
  count: number;
  delivered: boolean;
  skipped: string | null;
}

/** A job from /api/jobs, for the timesheet picker (any status). */
export interface JobOption {
  id: string;
  code: string;
  name: string;
  status: string;
}
