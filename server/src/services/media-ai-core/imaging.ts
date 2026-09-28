import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";

/**
 * Redraw a photo as a JPEG no larger than `maxEdge` on its longest side. Used
 * for gallery thumbnails and for the copy of a photo sent to a vision model,
 * which reads a 1600 px label as well as a 12 MP one and bills by the pixel.
 *
 * The decoder applies EXIF orientation itself, so a portrait phone photo comes
 * out the right way up without any help here.
 *
 * Returns null for anything the decoder cannot read (HEIC, mostly), so a caller
 * can fall back rather than fail.
 */
export async function renderJpeg(
  bytes: Buffer,
  opts: { maxEdge: number; quality?: number },
): Promise<Buffer | null> {
  let img: Awaited<ReturnType<typeof loadImage>>;
  try {
    img = await loadImage(bytes);
  } catch (err) {
    logger.debug("imaging.decode_failed", { err: describeError(err) });
    return null;
  }
  if (!img.width || !img.height) return null;

  const scale = Math.min(1, opts.maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // JPEG has no alpha; a transparent PNG would otherwise turn black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toBuffer("image/jpeg", opts.quality ?? 85);
}
