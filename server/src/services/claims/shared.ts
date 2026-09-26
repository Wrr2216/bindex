import { randomBytes } from "node:crypto";
import type { Claim, ClaimType } from "../../db/schema";
import { isUniqueViolation } from "../../lib/errors";
import { codePrefix } from "./model";

/**
 * Who is acting on a claim: a signed-in account (or API key), or an outside
 * party holding a portal grant, who has no account at all.
 */
export type ClaimActor = {
  userOid: string | null;
  name: string | null;
  role?: "admin" | "member";
  email?: string | null;
  grantId?: string | null;
};

// Crockford base32, as for asset and job codes: no I, L, O or U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function genClaimCode(type: ClaimType, length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${codePrefix(type)}-${out}`;
}

/** Insert with a fresh code, retrying on the rare collision with the unique index. */
export async function withClaimCode<T>(type: ClaimType, insert: (code: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await insert(genClaimCode(type));
    } catch (err) {
      if (attempt < 4 && isUniqueViolation(err, "uq_claims_code")) continue;
      throw err;
    }
  }
}

/** Trim to null, so an empty form field clears a column instead of storing "". */
export const clean = (s: string | null | undefined): string | null => {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t ? t : null;
};

/**
 * Why this person may not decide this claim, or null when they may.
 * Approving, denying and paying are for the assigned reviewer or an
 * administrator, and never for the person who reported it unless they are an
 * administrator: nobody signs off their own claim.
 */
export function decisionRefusal(
  claim: Pick<Claim, "assigneeUserOid" | "reporterUserOid">,
  actor: ClaimActor,
): string | null {
  if (actor.grantId || !actor.userOid) return "Only the assigned reviewer or an administrator can decide a claim.";
  if (actor.role === "admin") return null;
  if (claim.reporterUserOid && claim.reporterUserOid === actor.userOid) {
    return "You reported this claim, so someone else has to decide it.";
  }
  if (!claim.assigneeUserOid) return "Assign a reviewer first. Only the assigned reviewer or an administrator can decide a claim.";
  if (claim.assigneeUserOid !== actor.userOid) {
    return "Only the assigned reviewer or an administrator can decide this claim.";
  }
  return null;
}
