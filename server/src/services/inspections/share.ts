import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { inspectionShares, type Inspection, type InspectionShare } from "../../db/schema";
import { env } from "../../env";
import { badRequest, notFound } from "../../lib/errors";

/**
 * Read-only report links for someone without an account: a facility manager,
 * a landlord, an insurer.
 *
 * The token is <share id>.<expiry>.<MAC>. The MAC (HMAC-SHA256, truncated to
 * 144 bits) covers the id and the expiry, so neither can be altered, and a
 * forged or expired token is refused before the database is asked. The row it
 * names is what lets a link be revoked before it expires and counts how often
 * it was opened. Nothing secret is stored: the token is recomputed from the
 * row and the key, which is how the screen can show a live link again.
 *
 * The key is derived from SESSION_SECRET, so rotating that secret invalidates
 * every outstanding link, which is the right failure for a leaked secret.
 *
 * This is deliberately small. The external portal (T15) may absorb it later
 * into its own grants.
 */

export const SHARE_DEFAULT_DAYS = 14;
export const SHARE_MAX_DAYS = 90;

const MAC_BYTES = 18;

export function shareKey(secret: string = env.SESSION_SECRET): Buffer {
  return createHmac("sha256", secret).update("bindex:inspections:share-link:v1").digest();
}

const mac = (key: Buffer, id: string, exp: string) =>
  createHmac("sha256", key).update(`${id}.${exp}`).digest().subarray(0, MAC_BYTES);

export function signShareToken(shareId: string, expiresAt: Date, key: Buffer = shareKey()): string {
  const id = shareId.replace(/-/g, "").toLowerCase();
  const exp = Math.floor(expiresAt.getTime() / 1000).toString(36);
  return `${id}.${exp}.${mac(key, id, exp).toString("base64url")}`;
}

export type TokenCheck =
  | { ok: true; shareId: string; expiresAt: Date }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function readShareToken(token: string, key: Buffer = shareKey(), now: Date = new Date()): TokenCheck {
  const m = /^([0-9a-f]{32})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{24})$/.exec(token);
  if (!m) return { ok: false, reason: "malformed" };
  const [, id, exp, sig] = m as unknown as [string, string, string, string];
  const given = Buffer.from(sig, "base64url");
  const expected = mac(key, id, exp);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  const expiresAt = new Date(parseInt(exp, 36) * 1000);
  if (!(expiresAt.getTime() > now.getTime())) return { ok: false, reason: "expired" };
  const shareId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  return { ok: true, shareId, expiresAt };
}

/** Where a share link opens, relative to the site root. */
export const sharePath = (token: string) => `/api/share/inspections/${token}`;

export type ShareLink = Omit<InspectionShare, "inspectionId"> & {
  inspectionId: string;
  active: boolean;
  /** Present while the link works. */
  token: string | null;
  path: string | null;
  url: string | null;
};

function present(row: InspectionShare, now = new Date()): ShareLink {
  const active = !row.revokedAt && row.expiresAt.getTime() > now.getTime();
  const token = active ? signShareToken(row.id, row.expiresAt) : null;
  return {
    ...row,
    active,
    token,
    path: token ? sharePath(token) : null,
    url: token ? `${env.APP_BASE_URL.replace(/\/+$/, "")}${sharePath(token)}` : null,
  };
}

export async function listShares(inspectionId: string): Promise<ShareLink[]> {
  const rows = await db
    .select()
    .from(inspectionShares)
    .where(eq(inspectionShares.inspectionId, inspectionId))
    .orderBy(desc(inspectionShares.createdAt));
  const now = new Date();
  return rows.map((r) => present(r, now));
}

export async function createShare(inspection: Inspection, days: number, userOid: string | null): Promise<ShareLink> {
  if (!Number.isFinite(days) || days <= 0 || days > SHARE_MAX_DAYS) {
    throw badRequest(`A link can last from a few hours up to ${SHARE_MAX_DAYS} days.`);
  }
  // Whole seconds, because that is what the token carries.
  const expiresAt = new Date(Math.floor((Date.now() + days * 86_400_000) / 1000) * 1000);
  const [row] = await db
    .insert(inspectionShares)
    .values({ inspectionId: inspection.id, expiresAt, createdBy: userOid })
    .returning();
  return present(row!);
}

export async function revokeShare(inspectionId: string, shareId: string): Promise<ShareLink> {
  const [row] = await db
    .update(inspectionShares)
    .set({ revokedAt: sql`coalesce(${inspectionShares.revokedAt}, now())` })
    .where(and(eq(inspectionShares.id, shareId), eq(inspectionShares.inspectionId, inspectionId)))
    .returning();
  if (!row) throw notFound("That link does not exist.");
  return present(row);
}

/**
 * The share a token names, if it still works. Distinguishes a link that has
 * run out (worth telling the person, so they ask for a new one) from one that
 * never existed.
 */
export async function openShare(
  token: string,
  opts: { count?: boolean } = {},
): Promise<{ ok: true; share: InspectionShare } | { ok: false; reason: "not_found" | "expired" | "revoked" }> {
  const check = readShareToken(token);
  if (!check.ok) return { ok: false, reason: check.reason === "expired" ? "expired" : "not_found" };
  const [row] = await db.select().from(inspectionShares).where(eq(inspectionShares.id, check.shareId)).limit(1);
  // The expiry in the token must be the row's: a token signed for another
  // expiry is not this link.
  if (!row || Math.floor(row.expiresAt.getTime() / 1000) !== Math.floor(check.expiresAt.getTime() / 1000)) {
    return { ok: false, reason: "not_found" };
  }
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (opts.count) {
    await db
      .update(inspectionShares)
      .set({ openCount: sql`${inspectionShares.openCount} + 1`, lastOpenedAt: new Date() })
      .where(eq(inspectionShares.id, row.id));
  }
  return { ok: true, share: row };
}
