import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { renderJpeg } from "../media-ai-core/imaging";
import { parseChatReply } from "./reply";

/**
 * Ask a vision-capable model about one or more photos and get one JSON object
 * back. Same contract as chatJson in enrichment/model.ts: any OpenAI-compatible
 * chat/completions endpoint, null on any failure, never throws. Features built
 * on it must treat null as "no suggestion" and let the person carry on by hand.
 *
 * Images are redrawn as JPEG at most 1600 px on the longest side before they
 * are sent: a label is as legible at that size, the request stays small, and
 * providers bill by the pixel.
 */

export type VisionImage = { mime: string; bytes: Buffer };

export type VisionOptions = {
  /** Event prefix for the logs, e.g. "ai.data_plate". */
  event: string;
  system: string;
  prompt: string;
  images: VisionImage[];
  maxTokens?: number;
  /** Extra fields for the log lines, such as the record being read. */
  context?: Record<string, unknown>;
};

const TIMEOUT_MS = 45_000;
const MAX_EDGE = 1600;
const MAX_IMAGES = 10;
// Formats every vision provider accepts as they are, for when redrawing fails.
const PASSTHROUGH = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const PASSTHROUGH_MAX = 5 * 1024 * 1024;

async function toDataUrl(image: VisionImage): Promise<string | null> {
  const jpeg = await renderJpeg(image.bytes, { maxEdge: MAX_EDGE, quality: 85 });
  if (jpeg) return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  if (PASSTHROUGH.has(image.mime) && image.bytes.length <= PASSTHROUGH_MAX) {
    return `data:${image.mime};base64,${image.bytes.toString("base64")}`;
  }
  return null;
}

export async function visionJson(opts: VisionOptions): Promise<Record<string, unknown> | null> {
  if (!env.llmVisionConfigured) return null;
  try {
    if (opts.images.length > MAX_IMAGES) {
      logger.warn(`${opts.event}.too_many_images`, { ...opts.context, sent: MAX_IMAGES, given: opts.images.length });
    }
    const urls: string[] = [];
    for (const image of opts.images.slice(0, MAX_IMAGES)) {
      const url = await toDataUrl(image);
      if (url) urls.push(url);
      else logger.warn(`${opts.event}.image_unreadable`, { ...opts.context, mime: image.mime });
    }
    if (opts.images.length && !urls.length) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(`${env.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.llmVisionModel,
          max_tokens: opts.maxTokens ?? 1024,
          temperature: 0,
          messages: [
            { role: "system", content: opts.system },
            {
              role: "user",
              content: [
                { type: "text", text: opts.prompt },
                ...urls.map((url) => ({ type: "image_url", image_url: { url } })),
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        // The body usually says why ("model does not support images"), which
        // is the first thing anyone setting this up needs to see.
        const detail = (await resp.text().catch(() => "")).slice(0, 300);
        logger.warn(`${opts.event}.http_error`, { ...opts.context, status: resp.status, model: env.llmVisionModel, detail });
        return null;
      }
      const data = await resp.json().catch(() => null);
      const parsed = parseChatReply(data);
      if (!parsed) logger.warn(`${opts.event}.unparseable`, { ...opts.context, model: env.llmVisionModel });
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    logger.warn(`${opts.event}.fetch_error`, { ...opts.context, err: describeError(err) });
    return null;
  }
}
