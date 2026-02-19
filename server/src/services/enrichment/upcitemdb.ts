import { env } from "../../env";
import { logger } from "../../lib/logger";
import { NOT_FOUND, type EnrichmentResult } from "./types";

type UpcItem = {
  title?: string;
  brand?: string;
  description?: string;
  category?: string;
  images?: string[];
  model?: string;
};

/** Look up a UPC/EAN via UPCitemdb (trial endpoint, or keyed endpoint if set). */
export async function lookupUpcItemDb(code: string): Promise<EnrichmentResult> {
  const useKey = Boolean(env.UPC_API_KEY);
  const base = useKey
    ? "https://api.upcitemdb.com/prod/v1/lookup"
    : "https://api.upcitemdb.com/prod/trial/lookup";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (useKey) {
    headers["user_key"] = env.UPC_API_KEY;
    headers["key_type"] = "3scale";
  }

  const resp = await fetch(`${base}?upc=${encodeURIComponent(code)}`, { headers });
  if (!resp.ok) {
    logger.warn("enrich.upcitemdb.http_error", { code, status: resp.status });
    return NOT_FOUND;
  }

  const data = (await resp.json()) as { items?: UpcItem[] };
  const item = data.items?.[0];
  if (!item?.title) return NOT_FOUND;

  return {
    found: true,
    source: "upcitemdb",
    name: item.title,
    brand: item.brand,
    model: item.model,
    description: item.description,
    category: item.category,
    imageUrl: item.images?.[0],
    images: item.images,
    raw: item,
  };
}
