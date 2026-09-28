import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The secrets behind a portal link. Pure, so the tests can pin their shape.
 *
 * - A link token is 32 random bytes. Only its sha256 is stored, like an API
 *   key, so a copy of the database does not open anyone's portal.
 * - A pass is what a browser gets back for entering an emailed code, and is
 *   stored the same way.
 * - A code is six digits, hashed with the grant's id so a code for one link
 *   says nothing about another's. Six digits are guessable offline; what
 *   protects them is the ten-minute life, the five tries, and needing the link
 *   token as well.
 */

/** The prefixes make a leaked link or pass recognisable in a log or a chat. */
export const TOKEN_PREFIX = "bdxp_";
export const PASS_PREFIX = "bdxs_";

const TOKEN_RE = /^bdxp_[A-Za-z0-9_-]{43}$/;
const PASS_RE = /^bdxs_[A-Za-z0-9_-]{43}$/;

export const generateToken = (): string => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
export const generatePass = (): string => `${PASS_PREFIX}${randomBytes(32).toString("base64url")}`;

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** Cheap shape check before any database work, so junk never costs a query. */
export const looksLikeToken = (value: unknown): value is string => typeof value === "string" && TOKEN_RE.test(value);
export const looksLikePass = (value: unknown): value is string => typeof value === "string" && PASS_RE.test(value);

export const generateCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

export const hashCode = (grantId: string, code: string): string =>
  createHash("sha256").update(`${grantId}:${code}`).digest("hex");

/** Digits only, so "123 456" and "123-456" as typed from an email both work. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

export function codeMatches(storedHash: string, grantId: string, code: string): boolean {
  const given = Buffer.from(hashCode(grantId, code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}
