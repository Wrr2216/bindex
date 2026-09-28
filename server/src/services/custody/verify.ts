import { createHash } from "node:crypto";
import { pool } from "../../db/client";
import { logger } from "../../lib/logger";
import { getAttachment, getSignedContent, listSignatures, readAttachmentBytes, verifySignature } from "../media-ai-core";
import { contentLines, diffHeader, diffLines, transferContent, type ContentLine, type LineChange } from "./content";
import { loadTransfer, transferLines } from "./transfers";

/**
 * Whether a custody receipt still says what was signed. Four independent
 * checks, each reported on its own so a failure says where:
 *
 * 1. The item list still hashes to the fingerprint stored when it was locked.
 * 2. Each signature still verifies against the transfer rebuilt from its rows
 *    (verifySignature), and its image is intact.
 * 3. The audit-log entry that published the handoff is there, with the hash
 *    recorded at the time, and names the same fingerprint and receipt.
 * 4. The stored PDF receipt still hashes to what the audit log recorded.
 *
 * When a signature no longer matches, the signed snapshot is compared with the
 * rows as they are now, so the page can show which lines changed.
 */

type AuditRow = { id: string; hash: string; type: string; subject_type: string | null; subject_id: string | null; data: Record<string, unknown>; occurred_at: Date };

export async function verifyTransfer(id: string) {
  const t = await loadTransfer(id);
  const lines = await transferLines(id);
  const current = transferContent(t, contentLines(lines));
  const problems: string[] = [];

  const items = {
    storedHash: t.contentHash,
    currentHash: current.itemsHash,
    matches: t.contentHash === null ? null : t.contentHash === current.itemsHash,
  };
  if (items.matches === false) problems.push("The item list has changed since it was locked.");

  const sigs = await listSignatures("custody_transfer", id);
  const parties = [
    { party: "from" as const, id: t.fromSignatureId },
    { party: "to" as const, id: t.toSignatureId },
  ].filter((p): p is { party: "from" | "to"; id: string } => p.id !== null);
  const signatures = await Promise.all(
    parties.map(async ({ party, id: sigId }) => {
      const s = sigs.find((x) => x.id === sigId);
      if (!s) return { party, id: sigId, signerName: null, signedAt: null, valid: false, reason: "missing" as const, signedHash: null, currentHash: null };
      const r = await verifySignature(sigId, current);
      return { party, id: sigId, signerName: s.signerName, signedAt: s.signedAt, valid: r.valid, reason: r.reason, signedHash: r.signedHash, currentHash: r.currentHash };
    }),
  );
  for (const s of signatures) {
    if (s.valid) continue;
    const who = s.party === "from" ? "releasing" : "receiving";
    problems.push(
      s.reason === "missing"
        ? `The ${who} party's signature record is missing.`
        : s.reason === "content_changed"
          ? `The transfer no longer matches what the ${who} party signed.`
          : `The ${who} party's signature image was ${s.reason === "image_missing" ? "removed" : "altered"}.`,
    );
  }

  let changes: { lines: LineChange[]; fields: string[] } | null = null;
  const changed = signatures.find((s) => s.reason === "content_changed");
  if (changed) {
    try {
      const signed = (await getSignedContent(changed.id)) as { items?: ContentLine[] } & Record<string, unknown>;
      changes = {
        lines: diffLines(signed.items ?? [], current.items),
        fields: diffHeader(signed, current as unknown as Record<string, unknown>),
      };
    } catch (err) {
      logger.warn("custody.verify.diff_failed", { id, err: String(err) });
    }
  }

  let audit: {
    entryId: number | null;
    found: boolean;
    hashMatches: boolean;
    contentMatches: boolean;
    occurredAt: Date | null;
    receiptSha256: string | null;
  } = { entryId: t.auditEntryId, found: false, hashMatches: false, contentMatches: false, occurredAt: null, receiptSha256: null };
  if (t.auditEntryId !== null) {
    const { rows } = await pool.query<AuditRow>(
      `SELECT id, hash, type, subject_type, subject_id, data, occurred_at FROM audit_log WHERE id = $1`,
      [t.auditEntryId],
    );
    const row = rows[0];
    if (row) {
      const receipt = row.data.receipt as { sha256?: string } | null | undefined;
      audit = {
        entryId: t.auditEntryId,
        found: true,
        hashMatches: row.hash === t.auditHash,
        contentMatches:
          row.type === "custody.transferred" &&
          row.subject_type === "custody_transfer" &&
          row.subject_id === t.id &&
          row.data.itemsHash === t.contentHash &&
          row.data.code === t.code,
        occurredAt: row.occurred_at,
        receiptSha256: receipt?.sha256 ?? null,
      };
    }
    if (!audit.found) problems.push(`Audit-log entry ${t.auditEntryId} is missing.`);
    else if (!audit.hashMatches) problems.push(`Audit-log entry ${t.auditEntryId} no longer has the hash recorded when it was written.`);
    else if (!audit.contentMatches) problems.push(`Audit-log entry ${t.auditEntryId} describes a different list.`);
  } else if (t.status === "completed") {
    problems.push("The handoff has not been published to the audit log yet.");
  }

  let receipt: { attachmentId: string | null; sha256: string | null; intact: boolean; matchesAudit: boolean } = {
    attachmentId: t.receiptAttachmentId,
    sha256: null,
    intact: false,
    matchesAudit: false,
  };
  if (t.receiptAttachmentId) {
    const a = await getAttachment(t.receiptAttachmentId);
    const read = a ? await readAttachmentBytes(a.id).catch(() => null) : null;
    const actual = read ? createHash("sha256").update(read.bytes).digest("hex") : null;
    receipt = {
      attachmentId: t.receiptAttachmentId,
      sha256: a?.sha256 ?? null,
      intact: Boolean(a && actual === a.sha256),
      matchesAudit: Boolean(a && audit.receiptSha256 === a.sha256),
    };
    if (!receipt.intact) problems.push("The stored PDF receipt is missing or was altered.");
    else if (audit.found && !receipt.matchesAudit) problems.push("The stored PDF receipt is not the one the audit log recorded.");
  } else if (t.status === "completed") {
    problems.push("The PDF receipt has not been written yet.");
  }

  const complete = t.status === "completed";
  const valid = complete && problems.length === 0 && signatures.length > 0;
  return {
    transferId: t.id,
    code: t.code,
    status: t.status,
    valid,
    checkedAt: new Date(),
    problems,
    items,
    signatures,
    changes,
    audit,
    receipt,
  };
}

export type VerifyReport = Awaited<ReturnType<typeof verifyTransfer>>;

/**
 * Check a PDF someone holds against the records: find the transfer whose
 * stored receipt has these exact bytes, and verify it.
 */
export async function verifyReceiptBytes(bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { rows } = await pool.query<{ owner_id: string }>(
    `SELECT owner_id FROM attachments WHERE owner_type = 'custody_transfer' AND stage = 'receipt' AND sha256 = $1 LIMIT 1`,
    [sha256],
  );
  if (!rows[0]) return { found: false as const, sha256, report: null };
  return { found: true as const, sha256, report: await verifyTransfer(rows[0].owner_id) };
}
