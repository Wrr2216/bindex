import type { PortalCondition, PortalRole, PortalScope } from "../../db/tables/portal";

/**
 * What a portal link may do, decided without the database. Every rule a route
 * relies on for access is here, so the tests can cover each one directly.
 */

export const PORTAL_SCOPES = ["project", "job", "shipment"] as const satisfies readonly PortalScope[];
export const PORTAL_ROLES = ["viewer", "contributor"] as const satisfies readonly PortalRole[];
export const NOTE_CONDITIONS = ["good", "fair", "poor", "damaged"] as const satisfies readonly PortalCondition[];

/** Stages a contributor may scan to when the grant does not narrow them. */
export const DEFAULT_CONTRIBUTOR_STAGES = ["packed", "loaded", "delivered", "placed", "damaged", "missing"] as const;

/**
 * Photo stages a portal shows and accepts. Label photos (serial numbers, MAC
 * addresses) and anything a feature files under its own stage stay inside.
 */
export const PHOTO_STAGES = ["condition", "damage", "before", "after", "pack", "delivery", "placed"] as const;
export const DEFAULT_PHOTO_STAGE = "condition";

export const DEFAULT_EXPIRY_DAYS = 30;
export const MAX_EXPIRY_DAYS = 400;
/** How long a browser stays verified after entering an emailed code. */
export const PASS_DAYS = 30;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const PHOTO_MAX_BYTES = 25 * 1024 * 1024;
/** Largest scan batch through the portal; a crew's phone sends one or a few. */
export const MAX_PORTAL_SCAN = 500;

const DAY = 24 * 60 * 60_000;

export type GrantState = "active" | "revoked" | "expired" | "no_link";

/**
 * Whether a grant opens anything right now. Anything unexpected (a missing or
 * invalid expiry) counts as expired: the portal fails closed.
 */
export function grantState(
  g: { revokedAt: Date | null; expiresAt: Date | null; tokenHash: string | null },
  now: Date = new Date(),
): GrantState {
  if (g.revokedAt) return "revoked";
  if (!g.tokenHash) return "no_link";
  const expires = g.expiresAt instanceof Date ? g.expiresAt.getTime() : Number.NaN;
  if (!Number.isFinite(expires) || expires <= now.getTime()) return "expired";
  return "active";
}

/** Contributors work one job or one shipment; a project is too wide to hand over. */
export const roleAllowedForScope = (role: PortalRole, scope: PortalScope): boolean =>
  role === "viewer" || scope === "job" || scope === "shipment";

/**
 * The stages this grant may scan lines to. A grant's own list is trimmed to
 * stages that exist; pending is never allowed, since moving a line back to it
 * needs force, which a portal never has.
 */
export function contributorStages(
  role: PortalRole,
  allowed: readonly string[] | null | undefined,
  isStage: (stage: string) => boolean,
): string[] {
  if (role !== "contributor") return [];
  const wanted = allowed && allowed.length ? allowed : DEFAULT_CONTRIBUTOR_STAGES;
  return [...new Set(wanted)].filter((s) => s !== "pending" && isStage(s));
}

export const isPhotoStage = (stage: string): boolean => (PHOTO_STAGES as readonly string[]).includes(stage);

export type GrantShape = {
  scope: PortalScope;
  role: PortalRole;
  granteeEmail: string | null;
  requireCode: boolean;
  notify: boolean;
};

/**
 * A combination of settings that cannot work, as the message to show, or
 * null. `mailAvailable` is whether this server can send email at all.
 */
export function grantShapeProblem(g: GrantShape, mailAvailable: boolean): string | null {
  if (!roleAllowedForScope(g.role, g.scope)) {
    return "A contributor link covers one job or one shipment. Pick a job or a shipment, or make it a viewer link.";
  }
  if (g.requireCode && !g.granteeEmail) return "Add the person's email address so a code can be sent to it.";
  if (g.requireCode && !mailAvailable) {
    return "Email is not set up on this server (SMTP_URL), so a code cannot be sent. Leave the code off, or set up email first.";
  }
  if (g.notify && !g.granteeEmail) return "Add the person's email address to send them milestone emails.";
  return null;
}

/** An expiry in the future and no further out than MAX_EXPIRY_DAYS, or the problem. */
export function expiryProblem(expiresAt: Date, now: Date = new Date()): string | null {
  const t = expiresAt.getTime();
  if (!Number.isFinite(t)) return "Give the link an expiry date.";
  if (t <= now.getTime()) return "The expiry must be in the future.";
  if (t > now.getTime() + MAX_EXPIRY_DAYS * DAY) {
    return `Links last at most ${MAX_EXPIRY_DAYS} days. Pick an earlier expiry and extend it later if needed.`;
  }
  return null;
}

/** A pass never outlives its link. */
export function passExpiry(grantExpiresAt: Date, now: Date = new Date()): Date {
  return new Date(Math.min(grantExpiresAt.getTime(), now.getTime() + PASS_DAYS * DAY));
}

/** "d***@example.com": enough for the person to recognise, not enough to harvest. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** How a grant appears in histories and the audit log. */
export function portalActorName(g: { granteeName: string; granteeOrg: string | null }): string {
  const who = g.granteeOrg ? `${g.granteeName}, ${g.granteeOrg}` : g.granteeName;
  return `${who} (portal)`.slice(0, 200);
}

/** The audit-log actor for something a portal link did. */
export function portalActor(g: { id: string; granteeName: string; granteeOrg: string | null }) {
  return { kind: "system" as const, id: `portal:${g.id}`, name: portalActorName(g) };
}

/** Whole currency units from the environment to cents, as values are stored. */
export const highValueCents = (units: number): number => Math.round(units * 100);

export const isHighValue = (valueCents: number | null | undefined, thresholdCents: number): boolean =>
  typeof valueCents === "number" && thresholdCents > 0 && valueCents >= thresholdCents;
