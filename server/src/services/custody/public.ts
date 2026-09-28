import { pool } from "../../db/client";
import { notFound } from "../../lib/errors";
import { getConfig } from "../config";
import { thumbnail } from "../media-ai-core";
import { OUTCOME_LABEL, statementFor } from "./model";
import { hashLinkToken, linkState, looksLikeToken } from "./rules";
import { countable, findByLinkHash, linkGone, transferLines } from "./transfers";

/**
 * What a one-time signing link shows. Everything is scoped to the one
 * transfer the token names: its lines, and photos of the items on it.
 */

const PHOTOS_PER_LINE = 3;

export async function transferForToken(token: string) {
  if (!looksLikeToken(token)) throw linkGone();
  const t = await findByLinkHash(hashLinkToken(token));
  if (!t || !t.linkParty || linkState(t) !== "active" || t.status === "completed" || t.status === "void") throw linkGone();
  return t;
}

export async function publicView(token: string) {
  const t = await transferForToken(token);
  const party = t.linkParty!;
  const [lines, config] = await Promise.all([transferLines(t.id), getConfig()]);
  const codeOf = new Map(lines.map((l) => [l.itemId, l.assetCode]));
  const photos = new Map<string, string[]>();
  if (t.purpose === "delivery" && lines.length) {
    const { rows } = await pool.query<{ id: string; owner_id: string }>(
      `SELECT id, owner_id FROM (
         SELECT id, owner_id, row_number() OVER (PARTITION BY owner_id ORDER BY created_at DESC) AS n
           FROM attachments
          WHERE owner_type = 'item' AND owner_id = ANY($1::uuid[]) AND kind = 'photo'
       ) p WHERE n <= $2`,
      [[...new Set(lines.map((l) => l.itemId))], PHOTOS_PER_LINE],
    );
    for (const r of rows) {
      photos.set(r.owner_id, [...(photos.get(r.owner_id) ?? []), `/api/custody-public/${token}/photos/${r.id}`]);
    }
  }
  const signer = party === "to" ? { kind: t.toKind, name: t.toName } : { kind: t.fromKind, name: t.fromName };
  return {
    appName: config.appName,
    code: t.code,
    purpose: t.purpose,
    party,
    status: t.status,
    expiresAt: t.linkExpiresAt,
    from: { name: t.fromName, org: t.fromOrg },
    to: { name: t.toName, org: t.toOrg },
    place: t.locationName,
    jobCode: t.jobCode,
    shipmentCode: t.shipmentCode,
    seals: t.sealNumbers,
    conditionNote: t.conditionNote,
    // A delivery is reviewed by the receiver; anything else was counted and fixed before the link was sent.
    editable: t.status === "draft" && t.purpose === "delivery" && party === "to",
    statement: statementFor(t.purpose, party, { code: t.code, fromName: t.fromName, toName: t.toName, count: countable(lines) }),
    // A person is named; an organisation or team is not a signature name.
    signerName: signer.kind === "external" ? signer.name : "",
    lines: lines.map((l) => ({
      id: l.id,
      name: l.name,
      code: l.unitCode ?? l.assetCode,
      inside: l.via === "contained" && l.parentItemId ? codeOf.get(l.parentItemId) ?? null : null,
      outcome: l.outcome,
      outcomeLabel: OUTCOME_LABEL[l.outcome],
      note: l.note,
      flag: l.outcome === "accepted" ? null : `Flagged ${OUTCOME_LABEL[l.outcome].toLowerCase()}`,
      photos: photos.get(l.itemId) ?? [],
    })),
  };
}

/** A photo of an item on the link's transfer, and nothing else. */
export async function publicPhoto(token: string, attachmentId: string) {
  const t = await transferForToken(token);
  const { rows } = await pool.query(
    `SELECT 1 FROM attachments a
       JOIN custody_transfer_items ti ON ti.item_id = a.owner_id AND ti.transfer_id = $2
      WHERE a.id = $1 AND a.owner_type = 'item' AND a.kind = 'photo' LIMIT 1`,
    [attachmentId, t.id],
  );
  if (!rows.length) throw notFound("Photo not found.");
  const thumb = await thumbnail(attachmentId, 240);
  if (!thumb) throw notFound("There is no preview for this photo.");
  return thumb.bytes;
}
