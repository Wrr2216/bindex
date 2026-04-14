import { badRequest, describeError } from "../lib/errors";
import { logger } from "../lib/logger";

/** Block obvious internal/loopback targets to reduce SSRF surface. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fe80:|fc00:|fd)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

/** Parse + vet a candidate image URL; throws badRequest when it can't be fetched. */
export function validateImageUrl(raw: string): URL {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw badRequest("Invalid image url.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw badRequest("Only http(s) image URLs are allowed.");
  }
  if (isBlockedHost(target.hostname)) throw badRequest("That host is not allowed.");
  return target;
}

/**
 * Fetch image bytes from a validated URL. Returns null on any network/content
 * failure (timeout, non-2xx, or a non-image content-type) so callers can decide
 * whether that's a 502 (proxy) or a 400 (import).
 */
export async function fetchImageBytes(
  target: URL,
): Promise<{ mime: string; bytes: Buffer } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let upstream: Response | null = null;
  try {
    upstream = await fetch(target.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "bindex image proxy", Accept: "image/*" },
    });
  } catch (err) {
    // `TypeError: fetch failed` on its own says nothing. The real reason (DNS,
    // TLS, reset, timeout) is on the cause chain.
    logger.warn("image.fetch_failed", { host: target.hostname, err: describeError(err) });
  } finally {
    clearTimeout(timeout);
  }

  const type = upstream?.headers.get("content-type") ?? "";
  if (!upstream || !upstream.ok || !type.startsWith("image/")) return null;

  const bytes = Buffer.from(await upstream.arrayBuffer());
  return { mime: type.split(";")[0]!.trim(), bytes };
}
