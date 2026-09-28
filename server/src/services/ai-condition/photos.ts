import { pool } from "../../db/client";
import { badRequest } from "../../lib/errors";
import { logger } from "../../lib/logger";
import type { VisionImage } from "../ai";
import { readAttachmentBytes } from "../media-ai-core";

/**
 * Condition photos are ordinary attachments owned by the item (or one of its
 * units), so they show in the item's gallery under their stage. Reports and
 * captures keep only their ids; these helpers check the ids really are photos
 * of that record and turn them into what the API returns.
 */

export type PhotoRef = {
  id: string;
  url: string;
  thumbUrl: string | null;
  stage: string | null;
  ownerType: string;
  ownerId: string;
  createdAt: Date;
};

type Row = { id: string; owner_type: string; owner_id: string; mime: string; stage: string | null; kind: string; created_at: Date };

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const ref = (r: Row): PhotoRef => ({
  id: r.id,
  url: `/api/attachments/${r.id}`,
  thumbUrl: r.mime.startsWith("image/") ? `/api/attachments/${r.id}/thumb` : null,
  stage: r.stage,
  ownerType: r.owner_type,
  ownerId: r.owner_id,
  createdAt: r.created_at,
});

/**
 * The photos behind a set of ids, keyed by id. Ids whose attachment has been
 * deleted since are simply missing: a report outlives a photo removed from
 * the gallery.
 */
export async function photoRefs(ids: readonly string[]): Promise<Map<string, PhotoRef>> {
  const wanted = [...new Set(ids.filter(isUuid))];
  if (!wanted.length) return new Map();
  const { rows } = await pool.query<Row>(
    `SELECT id, owner_type, owner_id, mime, stage, kind, created_at FROM attachments WHERE id = ANY($1::uuid[])`,
    [wanted],
  );
  return new Map(rows.map((r) => [r.id, ref(r)]));
}

/**
 * Check that every id is a photo belonging to the item or to one of its units,
 * and return them in the order given, without repeats. `max` bounds how many
 * one record may carry.
 */
export async function assertPhotosOf(itemId: string, ids: readonly string[], max = 12): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  if (unique.length > max) throw badRequest(`Use at most ${max} photos.`);
  const bad = unique.find((id) => !isUuid(id));
  if (bad) throw badRequest(`"${bad}" is not an attachment id.`);
  const { rows } = await pool.query<Row & { unit_item: string | null }>(
    `SELECT a.id, a.owner_type, a.owner_id, a.mime, a.stage, a.kind, a.created_at, u.item_id AS unit_item
       FROM attachments a
       LEFT JOIN item_units u ON a.owner_type = 'unit' AND u.id = a.owner_id
      WHERE a.id = ANY($1::uuid[])`,
    [unique],
  );
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique) {
    const r = found.get(id);
    if (!r) throw badRequest("One of the photos no longer exists. Take it again.");
    if (!r.mime.startsWith("image/")) throw badRequest("Only photos can be used here, not video or documents.");
    const ownsIt = (r.owner_type === "item" && r.owner_id === itemId) || (r.owner_type === "unit" && r.unit_item === itemId);
    if (!ownsIt) throw badRequest("Use photos taken of this item. One of them belongs to a different record.");
  }
  return unique;
}

// A vision model reads a 12 MP phone photo no better than a 1600 px one, and
// the helper redraws it anyway; this only guards against a 60 MB panorama.
const PHOTO_LIMIT = 32 * 1024 * 1024;

/** Load photos for a vision call, skipping any that cannot be read. */
export async function visionImages(ids: readonly string[]): Promise<VisionImage[]> {
  const out: VisionImage[] = [];
  for (const id of ids) {
    try {
      const { attachment, bytes } = await readAttachmentBytes(id, PHOTO_LIMIT);
      out.push({ mime: attachment.mime, bytes });
    } catch (err) {
      logger.warn("ai_condition.photo.unreadable", { id, err: String(err) });
    }
  }
  return out;
}
