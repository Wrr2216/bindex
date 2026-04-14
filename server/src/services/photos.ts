import { eq } from "drizzle-orm";
import { db, pool } from "../db/client";
import { items, itemImages } from "../db/schema";
import { badRequest } from "../lib/errors";
import { validateImageUrl, fetchImageBytes } from "./images";
import { getItemDetail } from "./items";

/**
 * Store a captured/uploaded photo as the item's primary image. Bytes live in
 * Postgres (item_photos); the served URL is local (/api/photos/:id) so it loads
 * from our own origin and survives external link-rot. Excluded from the JSON
 * backup by design, being binary. A database dump covers them instead.
 */
export async function savePhoto(itemId: string, mime: string, bytes: Buffer) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO item_photos (item_id, mime, bytes) VALUES ($1, $2, $3) RETURNING id`,
    [itemId, mime, bytes],
  );
  const url = `/api/photos/${rows[0]!.id}`;
  await db.update(items).set({ primaryImageUrl: url, updatedAt: new Date() }).where(eq(items.id, itemId));
  await db.insert(itemImages).values({ itemId, url, isPrimary: true, sort: 0 });
  return getItemDetail(itemId);
}

/**
 * Fetch a remote image (e.g. a candidate photo found during pricing lookup) and
 * store it as the item's primary image. Copying the bytes into item_photos makes
 * the photo durable instead of hotlinking a URL that can rot or hotlink-block.
 */
export async function savePhotoFromUrl(itemId: string, rawUrl: string) {
  const target = validateImageUrl(rawUrl);
  const img = await fetchImageBytes(target);
  if (!img) throw badRequest("Could not fetch that image.");
  return savePhoto(itemId, img.mime, img.bytes);
}

export async function getPhoto(id: string): Promise<{ mime: string; bytes: Buffer } | null> {
  const { rows } = await pool.query<{ mime: string; bytes: Buffer }>(
    `SELECT mime, bytes FROM item_photos WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
