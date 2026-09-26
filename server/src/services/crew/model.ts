import type { ComplianceLight, CredentialStatus, CrewPolicy } from "../../db/schema";

/**
 * The rules of crew compliance, with no database and no clock of their own, so
 * every decision a gate makes can be tested with fixed dates.
 *
 * A credential is judged on the day ("today" in the viewer's time zone), not
 * the instant: a card that expires on the 12th is good all day on the 12th.
 *
 *   green  valid today, and not expiring within its type's warning window
 *   amber  valid today, but expiring within the window
 *   red    missing, expired, pending, failed, suspended or revoked
 *
 * Only red can stop a check-in. Amber is a heads-up for whoever renews it.
 */

export const CREDENTIAL_STATUSES = ["valid", "pending", "expired", "failed", "suspended", "revoked"] as const;
export const CREW_POLICIES = ["warn", "block"] as const;
export const LIGHTS = ["green", "amber", "red"] as const;

export type CredentialReason =
  | "valid"
  | "expiring"
  | "expired"
  | "missing"
  | "pending"
  | "failed"
  | "suspended"
  | "revoked";

const LIGHT_RANK: Record<ComplianceLight, number> = { green: 0, amber: 1, red: 2 };

export const worstLight = (lights: ComplianceLight[]): ComplianceLight =>
  lights.reduce<ComplianceLight>((worst, l) => (LIGHT_RANK[l] > LIGHT_RANK[worst] ? l : worst), "green");

// --- Dates --------------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since the epoch for a YYYY-MM-DD, or null when it is not a real date. */
export function dayNumber(date: string): number | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null;
  }
  return Math.round(ms / 86_400_000);
}

export const isDateOnly = (s: string): boolean => dayNumber(s) !== null;

/** `to - from` in whole days. */
export function daysBetween(from: string, to: string): number {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (a === null || b === null) throw new Error(`Not a date: ${a === null ? from : to}`);
  return b - a;
}

export function addDays(date: string, days: number): string {
  const n = dayNumber(date);
  if (n === null) throw new Error(`Not a date: ${date}`);
  return new Date((n + days) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The issue date plus a number of months, landing on the last day of a short
 * month rather than rolling into the next (31 Jan + 1 month is 28 or 29 Feb).
 */
export function addMonths(date: string, months: number): string {
  const m = DATE.exec(date);
  if (!m || dayNumber(date) === null) throw new Error(`Not a date: ${date}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(Number(m[3]), lastDay);
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A time zone Intl understands, or null. */
export function validTimeZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** The calendar date at `at` in `tz` (UTC when the zone is unknown). */
export function localDate(at: Date, tz?: string | null): string {
  const zone = validTimeZone(tz) ?? "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Wall-clock parts at `at` in `tz`, for spreadsheets that should show local time. */
export function localParts(at: Date, tz?: string | null) {
  const zone = validTimeZone(tz) ?? "UTC";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute"), second: n("second") };
}

/** How far `tz`'s wall clock is ahead of UTC at `at`, in milliseconds. */
export function zoneOffsetMs(at: Date, tz?: string | null): number {
  const p = localParts(at, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant a calendar day starts in `tz`: the lower bound of "shifts on
 * 2026-09-26" for a site in that zone. Checked twice so a day that starts just
 * after a daylight-saving change still lands on its own midnight.
 */
export function zonedMidnight(date: string, tz?: string | null): Date {
  const n = dayNumber(date);
  if (n === null) throw new Error(`Not a date: ${date}`);
  const base = n * 86_400_000;
  let guess = base - zoneOffsetMs(new Date(base), tz);
  guess = base - zoneOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

// --- One credential -------------------------------------------------------------

export type CredentialFacts = {
  id?: string | null;
  typeKey: string;
  status: CredentialStatus;
  expiresOn: string | null;
  issuedOn?: string | null;
  source?: "manual" | "verifier";
  number?: string | null;
};

export type CredentialAssessment = {
  light: ComplianceLight;
  reason: CredentialReason;
  /** Days until expiry; negative once expired; null when it does not expire. */
  daysLeft: number | null;
};

export function assessCredential(c: CredentialFacts, warnDays: number, today: string): CredentialAssessment {
  const daysLeft = c.expiresOn && isDateOnly(c.expiresOn) ? daysBetween(today, c.expiresOn) : null;
  if (c.status !== "valid") return { light: "red", reason: c.status, daysLeft };
  if (daysLeft === null) return { light: "green", reason: "valid", daysLeft };
  if (daysLeft < 0) return { light: "red", reason: "expired", daysLeft };
  if (daysLeft <= Math.max(0, warnDays)) return { light: "amber", reason: "expiring", daysLeft };
  return { light: "green", reason: "valid", daysLeft };
}

/** A short phrase for a person: "Expires in 5 days", "Expired 2026-09-01". */
export function describeAssessment(a: CredentialAssessment, expiresOn: string | null): string {
  switch (a.reason) {
    case "missing":
      return "Missing";
    case "pending":
      return "Pending";
    case "failed":
      return "Failed";
    case "suspended":
      return "Suspended";
    case "revoked":
      return "Revoked";
    case "expired":
      if (a.daysLeft !== null && a.daysLeft < 0) {
        const ago = -a.daysLeft;
        return `Expired ${ago === 1 ? "yesterday" : `${ago} days ago`}`;
      }
      return "Expired";
    case "expiring":
      if (a.daysLeft === 0) return "Expires today";
      return `Expires in ${a.daysLeft} day${a.daysLeft === 1 ? "" : "s"}`;
    case "valid":
      return expiresOn ? `Valid until ${expiresOn}` : "Valid, no expiry";
  }
}

// Verifier statuses that mean "not cleared". A verifier is the authority it is
// plugged in to be: a paper copy of a background check cannot out-vote the
// service saying it was revoked.
const VERIFIER_VETO: ReadonlySet<CredentialStatus> = new Set(["failed", "suspended", "revoked", "expired"]);

/**
 * The credential that decides a type, from all the worker holds of it
 * (renewals keep their history, so there may be several). A verifier's
 * refusal decides outright; otherwise the best standing wins, then the
 * longest-lived, then the most recently issued.
 */
export function decidingCredential<T extends CredentialFacts>(
  candidates: T[],
  warnDays: number,
  today: string,
): { credential: T; assessment: CredentialAssessment } | null {
  if (candidates.length === 0) return null;
  const veto = candidates.find((c) => c.source === "verifier" && VERIFIER_VETO.has(c.status));
  if (veto) return { credential: veto, assessment: assessCredential(veto, warnDays, today) };
  const scored = candidates.map((credential) => ({ credential, assessment: assessCredential(credential, warnDays, today) }));
  scored.sort((a, b) => {
    const light = LIGHT_RANK[a.assessment.light] - LIGHT_RANK[b.assessment.light];
    if (light !== 0) return light;
    const ax = a.credential.expiresOn ?? "9999-12-31";
    const bx = b.credential.expiresOn ?? "9999-12-31";
    if (ax !== bx) return ax < bx ? 1 : -1;
    const ai = a.credential.issuedOn ?? "";
    const bi = b.credential.issuedOn ?? "";
    return ai === bi ? 0 : ai < bi ? 1 : -1;
  });
  return scored[0]!;
}

// --- A worker against a job's requirements -------------------------------------

export type RequiredType = { key: string; name: string; warnDays: number };

export type CredentialCheck = {
  typeKey: string;
  typeName: string;
  light: ComplianceLight;
  reason: CredentialReason;
  label: string;
  credentialId: string | null;
  expiresOn: string | null;
  daysLeft: number | null;
  source: "manual" | "verifier" | null;
};

export type Compliance = {
  light: ComplianceLight;
  checks: CredentialCheck[];
  /** One line for a person, e.g. "Forklift licence expired 3 days ago". */
  summary: string;
};

export function evaluateCompliance(input: {
  required: RequiredType[];
  credentials: CredentialFacts[];
  today: string;
}): Compliance {
  const checks: CredentialCheck[] = input.required.map((type) => {
    const decided = decidingCredential(
      input.credentials.filter((c) => c.typeKey === type.key),
      type.warnDays,
      input.today,
    );
    if (!decided) {
      return {
        typeKey: type.key,
        typeName: type.name,
        light: "red",
        reason: "missing",
        label: "Missing",
        credentialId: null,
        expiresOn: null,
        daysLeft: null,
        source: null,
      };
    }
    const { credential, assessment } = decided;
    return {
      typeKey: type.key,
      typeName: type.name,
      light: assessment.light,
      reason: assessment.reason,
      label: describeAssessment(assessment, credential.expiresOn),
      credentialId: credential.id ?? null,
      expiresOn: credential.expiresOn,
      daysLeft: assessment.daysLeft,
      source: credential.source ?? "manual",
    };
  });
  const light = worstLight(checks.map((c) => c.light));
  return { light, checks, summary: summarize(light, checks) };
}

function summarize(light: ComplianceLight, checks: CredentialCheck[]): string {
  if (checks.length === 0) return "No credentials required";
  if (light === "green") return "All required credentials valid";
  const worst = checks.filter((c) => c.light === light);
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  return worst.map((c) => `${c.typeName} ${lower(c.label)}`).join("; ");
}

/**
 * Every credential type the worker holds, each judged by its deciding
 * credential: what the worker page and list filters show outside any job.
 */
export function standing(
  credentials: CredentialFacts[],
  types: Map<string, { name: string; warnDays: number }>,
  today: string,
): { light: ComplianceLight | null; checks: CredentialCheck[] } {
  const keys = [...new Set(credentials.map((c) => c.typeKey))].filter((k) => types.has(k));
  const { checks } = evaluateCompliance({
    required: keys.map((key) => ({ key, name: types.get(key)!.name, warnDays: types.get(key)!.warnDays })),
    credentials,
    today,
  });
  return { light: checks.length ? worstLight(checks.map((c) => c.light)) : null, checks };
}

// --- The gate --------------------------------------------------------------------

export type CrewPolicySetting = {
  /** Credential type keys a worker must hold. */
  required: string[];
  policy: CrewPolicy;
  /** Only an administrator may override a block. */
  overrideAdminOnly: boolean;
};

export const DEFAULT_POLICY: CrewPolicySetting = { required: [], policy: "warn", overrideAdminOnly: false };

/** Whatever is stored under job_types.settings.crew, made safe to use. */
export function normalizePolicy(raw: unknown): CrewPolicySetting {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_POLICY };
  const r = raw as Record<string, unknown>;
  const required = Array.isArray(r.required)
    ? [...new Set(r.required.filter((k): k is string => typeof k === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(k)))]
    : [];
  return {
    required,
    policy: r.policy === "block" ? "block" : "warn",
    overrideAdminOnly: r.overrideAdminOnly === true,
  };
}

export type GateDecision =
  | { allowed: true; overridden: boolean; warned: boolean }
  | { allowed: false; reason: "override_required" | "override_admin_only" };

/**
 * Whether a check-in goes ahead. Red under a blocking policy needs an override
 * reason (and an administrator, when the policy says so); red under a warning
 * policy goes ahead flagged. Green and amber always go ahead.
 */
export function decideGate(
  compliance: Pick<Compliance, "light">,
  policy: Pick<CrewPolicySetting, "policy" | "overrideAdminOnly">,
  override: { reason?: string | null; isAdmin: boolean },
): GateDecision {
  if (compliance.light !== "red") return { allowed: true, overridden: false, warned: compliance.light === "amber" };
  if (policy.policy === "warn") return { allowed: true, overridden: false, warned: true };
  const reason = override.reason?.trim();
  if (!reason) return { allowed: false, reason: "override_required" };
  if (policy.overrideAdminOnly && !override.isAdmin) return { allowed: false, reason: "override_admin_only" };
  return { allowed: true, overridden: true, warned: true };
}

// --- Badges ----------------------------------------------------------------------

/**
 * The badge code a scan carries. A badge QR holds a link to the worker's badge
 * page (…/crew/badge/CRW-7F3K2A), so a phone camera opens it; a handheld
 * reader types the same link, or the bare code of a badge printed elsewhere.
 */
export function badgeCodeFromScan(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const link = /\/crew\/badge\/([^/?#\s]+)/i.exec(text);
  if (link) {
    try {
      return decodeURIComponent(link[1]!).trim() || null;
    } catch {
      return link[1]!.trim() || null;
    }
  }
  return text.length <= 200 ? text : null;
}

// --- Hours ----------------------------------------------------------------------

/** Paid minutes of one shift; an open shift counts up to `now`. Never negative. */
export function shiftMinutes(
  checkedInAt: Date,
  checkedOutAt: Date | null,
  breakMinutes: number,
  now: Date,
): number {
  const end = checkedOutAt ?? now;
  const gross = Math.floor((end.getTime() - checkedInAt.getTime()) / 60_000);
  return Math.max(0, gross - Math.max(0, breakMinutes));
}

/** Minutes as decimal hours to two places, the way timesheets are keyed. */
export const toHours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

// --- External verifier replies ----------------------------------------------------

const STATUS_WORDS: Record<string, CredentialStatus> = {
  valid: "valid",
  active: "valid",
  clear: "valid",
  cleared: "valid",
  passed: "valid",
  pass: "valid",
  ok: "valid",
  current: "valid",
  approved: "valid",
  verified: "valid",
  compliant: "valid",
  pending: "pending",
  in_progress: "pending",
  processing: "pending",
  submitted: "pending",
  in_review: "pending",
  review: "pending",
  expired: "expired",
  lapsed: "expired",
  failed: "failed",
  fail: "failed",
  rejected: "failed",
  denied: "failed",
  not_clear: "failed",
  suspended: "suspended",
  inactive: "suspended",
  on_hold: "suspended",
  revoked: "revoked",
  cancelled: "revoked",
  canceled: "revoked",
  terminated: "revoked",
};

export type VerifiedCredential = {
  typeKey: string;
  status: CredentialStatus;
  expiresOn: string | null;
  issuedOn: string | null;
  number: string | null;
  issuer: string | null;
};

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function dateField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.trim().slice(0, 10);
  return isDateOnly(d) ? d : null;
}

function textField(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, 200) : null;
}

/**
 * Read a verifier's reply. Accepts `{ credentials: [...] }` or a bare array;
 * each entry names its type (`type`, `key` or `credential`, matched to a
 * credential type key after lowercasing) and a `status` in any of the common
 * words for it. Entries for types this instance does not have are returned as
 * `unmatched`; entries without a status it understands are dropped.
 */
export function normalizeVerifierReply(
  body: unknown,
  knownKeys: ReadonlySet<string>,
): { credentials: VerifiedCredential[]; unmatched: string[] } {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { credentials?: unknown }).credentials)
      ? (body as { credentials: unknown[] }).credentials
      : [];
  const credentials = new Map<string, VerifiedCredential>();
  const unmatched = new Set<string>();
  for (const entry of list.slice(0, 200)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const rawType = [e.type, e.key, e.credential].find((v) => typeof v === "string") as string | undefined;
    const status = typeof e.status === "string" ? STATUS_WORDS[slug(e.status)] : undefined;
    if (!rawType || !status) continue;
    const typeKey = slug(rawType);
    if (!knownKeys.has(typeKey)) {
      unmatched.add(typeKey || rawType.slice(0, 40));
      continue;
    }
    // One answer per type; the first one given wins.
    if (credentials.has(typeKey)) continue;
    credentials.set(typeKey, {
      typeKey,
      status,
      expiresOn: dateField(e.expiresOn ?? e.expires_on ?? e.expires ?? e.expiry),
      issuedOn: dateField(e.issuedOn ?? e.issued_on ?? e.issued),
      number: textField(e.number ?? e.id),
      issuer: textField(e.issuer),
    });
  }
  return { credentials: [...credentials.values()], unmatched: [...unmatched] };
}
