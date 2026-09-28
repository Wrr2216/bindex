import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing. Each delivery carries
 *
 *   X-Bindex-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 *
 * keyed with the endpoint's secret as UTF-8 text. The timestamp is inside the
 * signed text so a captured request cannot be replayed later with a fresh
 * one. The same scheme as Stripe's, so receivers often have code for it.
 */

export const SIGNATURE_HEADER = "X-Bindex-Signature";
export const SIGNATURE_VERSION = "v1";
/** How far a receiver should let the signed time drift from its own clock. */
export const DEFAULT_TOLERANCE_SEC = 300;

/** `whsec_` makes a leaked secret recognisable in a log or a repository. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function signatureDigest(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function signatureHeader(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},${SIGNATURE_VERSION}=${signatureDigest(secret, timestamp, body)}`;
}

export type SignatureCheck = { valid: boolean; reason: string | null };

/**
 * Receiver-side check, kept here so the tests prove the documented algorithm.
 * Accepts several v1 values in one header, which lets a sender sign with an
 * old and a new secret during a rotation.
 */
export function verifySignatureHeader(
  header: string | undefined | null,
  body: string,
  secret: string,
  opts: { toleranceSec?: number; now?: number } = {},
): SignatureCheck {
  if (!header) return { valid: false, reason: "missing signature header" };
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s.trim());
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === SIGNATURE_VERSION && value) candidates.push(value);
  }
  if (timestamp === null) return { valid: false, reason: "no timestamp in signature header" };
  if (candidates.length === 0) return { valid: false, reason: "no v1 signature in header" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(now - timestamp) > tolerance) return { valid: false, reason: "timestamp outside tolerance" };

  const expected = Buffer.from(signatureDigest(secret, timestamp, body), "hex");
  const match = candidates.some((c) => {
    const given = Buffer.from(c, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { valid: true, reason: null } : { valid: false, reason: "signature does not match" };
}
