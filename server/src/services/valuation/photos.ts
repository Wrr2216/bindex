import { listAttachments, readAttachmentBytes, renderJpeg } from "../media-ai-core";
import { getPhoto } from "../photos";

/**
 * A small JPEG of a record, for printed documents. The unit's own photo first,
 * then the item's main photo when it is stored here, then the item's newest
 * photo attachment. Remote image URLs are not fetched: a report must not
 * reach out to the internet, and a slow host would stall it.
 */
export async function thumbFor(
  item: { id: string; primaryImageUrl: string | null },
  unitId: string | null,
  maxEdge = 240,
): Promise<Buffer | null> {
  try {
    if (unitId) {
      const own = await latestPhoto("unit", unitId, maxEdge);
      if (own) return own;
    }
    const local = /^\/api\/photos\/([0-9a-f-]{36})$/i.exec(item.primaryImageUrl ?? "");
    if (local) {
      const photo = await getPhoto(local[1]!);
      if (photo) {
        const jpeg = await renderJpeg(photo.bytes, { maxEdge, quality: 80 });
        if (jpeg) return jpeg;
      }
    }
    return await latestPhoto("item", item.id, maxEdge);
  } catch {
    // A missing or unreadable photo leaves a blank box; it never fails the document.
    return null;
  }
}

async function latestPhoto(ownerType: "item" | "unit", ownerId: string, maxEdge: number): Promise<Buffer | null> {
  const photos = (await listAttachments(ownerType, ownerId, { kind: "photo" })).filter((a) => a.mime.startsWith("image/"));
  for (let i = photos.length - 1; i >= 0 && i >= photos.length - 3; i--) {
    const { bytes } = await readAttachmentBytes(photos[i]!.id, 40 * 1024 * 1024);
    const jpeg = await renderJpeg(bytes, { maxEdge, quality: 80 });
    if (jpeg) return jpeg;
  }
  return null;
}
