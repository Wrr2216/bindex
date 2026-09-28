import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { signatures, type SignatureRow } from "../../db/tables/media-ai-core";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { saveAttachment } from "./attachments";
import { canonicalJson, contentHash } from "./canonical";
import { assertOwner } from "./owners";

/**
 * Signed records: who agreed to what, when, and a fingerprint of the content
 * they saw.
 *
 * The content is whatever the owning feature says was signed (an item list, a
 * delivery receipt, a filled form), passed as plain JSON. Its canonical hash is
 * stored with the signature, so verifying later is a matter of rebuilding the
 * same JSON from the record as it is now and comparing: any edit after signing
 * shows up as a mismatch. The signature image is stored as an attachment of
 * the same record with kind "signature".
 */

export type Signature = Omit<SignatureRow, "content"> & {
  /** Streams the signature PNG, when there is one. */
  imageUrl: string | null;
};

export type SignInput = {
  ownerType: string;
  ownerId: string;
  signerName: string;
  signerEmail?: string | null;
  signerRole?: string | null;
  /** The exact words the signer agreed to, stored verbatim. */
  statement: string;
  /** What was signed, as JSON. Build it the same way when verifying. */
  content: unknown;
  /** The drawn signature as a PNG (or JPEG/WebP). Optional for typed-name sign-off. */
  image?: Buffer | null;
  ip?: string | null;
  userAgent?: string | null;
  /** The signed-in user, or null for someone without an account. */
  signedByUser?: string | null;
};

export type VerifyResult = {
  valid: boolean;
  /**
   * - ok: the content and the signature image are unchanged.
   * - content_changed: the record no longer matches what was signed.
   * - image_missing / image_altered: the signature image was removed or edited.
   */
  reason: "ok" | "content_changed" | "image_missing" | "image_altered";
  signedHash: string;
  currentHash: string;
  signedAt: Date;
};

const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

const text = (v: string | null | undefined, max: number, field: string): string | null => {
  const t = v?.trim();
  if (!t) return null;
  if (t.length > max) throw badRequest(`${field} is limited to ${max} characters.`);
  return t;
};

function present(row: SignatureRow): Signature {
  const { content: _content, ...rest } = row;
  return { ...rest, imageUrl: row.attachmentId ? `/api/attachments/${row.attachmentId}` : null };
}

/**
 * Record a signature. The image and the signature row are written in one
 * transaction, so there is never a signature without its image or the reverse.
 */
export async function sign(input: SignInput): Promise<Signature> {
  const signerName = text(input.signerName, 200, "The signer's name");
  if (!signerName) throw badRequest("Enter the signer's name.");
  const statement = text(input.statement, 4000, "The statement");
  if (!statement) throw badRequest("A signature needs the statement being agreed to.");
  const signerEmail = text(input.signerEmail, 320, "The email address");
  if (signerEmail && !/^[^\s@]+@[^\s@]+$/.test(signerEmail)) throw badRequest("That email address does not look right.");
  const signerRole = text(input.signerRole, 120, "The role");

  let canonical: string;
  try {
    canonical = canonicalJson(input.content);
  } catch (err) {
    throw badRequest(`The signed content must be plain JSON: ${(err as Error).message}`);
  }
  if (Buffer.byteLength(canonical) > MAX_CONTENT_BYTES) throw badRequest("The signed content is limited to 2 MB.");
  if (input.image && input.image.length > MAX_IMAGE_BYTES) {
    throw badRequest("The signature image is too large. It should be a small PNG from the signature pad.");
  }

  await assertOwner(input.ownerType, input.ownerId);

  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const image = input.image?.length
      ? await saveAttachment(
          {
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            kind: "signature",
            mime: "image/png",
            bytes: input.image,
            caption: `Signature: ${signerName}`,
            meta: { signatureId: id },
            createdBy: input.signedByUser ?? null,
          },
          client,
        )
      : null;
    await client.query(
      `INSERT INTO signatures
         (id, owner_type, owner_id, signer_name, signer_email, signer_role, statement,
          content_hash, content, attachment_id, ip, user_agent, signed_by_user)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
      [
        id,
        input.ownerType,
        input.ownerId,
        signerName,
        signerEmail,
        signerRole,
        statement,
        contentHash(input.content),
        canonical,
        image?.id ?? null,
        input.ip?.slice(0, 100) ?? null,
        input.userAgent?.slice(0, 500) ?? null,
        input.signedByUser ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  logger.info("signatures.signed", { id, ownerType: input.ownerType, ownerId: input.ownerId });
  return (await getSignature(id))!;
}

export async function getSignature(id: string): Promise<Signature | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(signatures).where(eq(signatures.id, id)).limit(1);
  return row ? present(row) : null;
}

/** The canonical content exactly as it was signed, for showing what someone agreed to. */
export async function getSignedContent(id: string): Promise<unknown> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Signature not found.");
  const [row] = await db.select({ content: signatures.content }).from(signatures).where(eq(signatures.id, id)).limit(1);
  if (!row) throw notFound("Signature not found.");
  return row.content;
}

export async function listSignatures(ownerType: string, ownerId: string): Promise<Signature[]> {
  if (!/^[0-9a-f-]{36}$/i.test(ownerId)) return [];
  const rows = await db
    .select()
    .from(signatures)
    .where(and(eq(signatures.ownerType, ownerType), eq(signatures.ownerId, ownerId)))
    .orderBy(asc(signatures.signedAt));
  return rows.map(present);
}

/**
 * Check a signature against the record as it is now. `currentContent` must be
 * built exactly as the content passed to sign() was; the canonical form takes
 * care of key order and whitespace, not of fields added or renamed.
 *
 * Also confirms the signature image still hashes to what was stored.
 */
export async function verifySignature(id: string, currentContent: unknown): Promise<VerifyResult> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Signature not found.");
  const [row] = await db
    .select({
      contentHash: signatures.contentHash,
      attachmentId: signatures.attachmentId,
      signedAt: signatures.signedAt,
    })
    .from(signatures)
    .where(eq(signatures.id, id))
    .limit(1);
  if (!row) throw notFound("Signature not found.");

  let currentHash: string;
  try {
    currentHash = contentHash(currentContent);
  } catch {
    currentHash = "";
  }
  const base = { signedHash: row.contentHash, currentHash, signedAt: row.signedAt };
  if (currentHash !== row.contentHash) return { ...base, valid: false, reason: "content_changed" };

  if (row.attachmentId) {
    const { rows } = await pool.query<{ sha256: string; bytes: Buffer | null }>(
      `SELECT sha256, bytes FROM attachments WHERE id = $1`,
      [row.attachmentId],
    );
    const img = rows[0];
    if (!img?.bytes) return { ...base, valid: false, reason: "image_missing" };
    const actual = createHash("sha256").update(img.bytes).digest("hex");
    if (actual !== img.sha256) return { ...base, valid: false, reason: "image_altered" };
  }
  return { ...base, valid: true, reason: "ok" };
}
