import { env } from "../../env";
import { logger } from "../../lib/logger";

const IMAGE_BASE = "https://api.search.brave.com/res/v1/images/search";
const WEB_BASE = "https://api.search.brave.com/res/v1/web/search";

export type BraveWebHit = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type ImageResponse = {
  results?: { url?: string; thumbnail?: { src?: string } }[];
};

type WebResponse = {
  web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] };
};

async function braveGet(endpoint: string, params: Record<string, string>): Promise<unknown | null> {
  if (!env.webSearchConfigured) return null;
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(`${endpoint}?${qs}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY },
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn("enrich.brave.http_error", { endpoint, status: resp.status });
      return null;
    }
    return await resp.json();
  } catch (err) {
    logger.warn("enrich.brave.fetch_error", { endpoint, err: String(err) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Image search: returns up to `count` direct image URLs. */
export async function braveImageSearch(query: string, count = 6): Promise<string[]> {
  const data = await braveGet(IMAGE_BASE, { q: query, count: String(count) });
  if (!data) return [];
  const results = (data as ImageResponse).results ?? [];
  return results
    .map((r) => r.url ?? r.thumbnail?.src)
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
    .slice(0, count);
}

/** Web search: returns snippets for the price-extraction path. */
export async function braveWebSearch(query: string, count = 5): Promise<BraveWebHit[]> {
  const data = await braveGet(WEB_BASE, { q: query, count: String(count) });
  if (!data) return [];
  const results = (data as WebResponse).web?.results ?? [];
  return results
    .map((r) => ({ title: r.title, url: r.url, description: r.description, age: r.age }))
    .filter((r) => r.url || r.description);
}
