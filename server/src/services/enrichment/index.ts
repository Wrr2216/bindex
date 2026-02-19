import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { enrichmentCache } from "../../db/schema";
import { env } from "../../env";
import { logger } from "../../lib/logger";
import { lookupUpcItemDb } from "./upcitemdb";
import { lookupProduct } from "./product";
import { braveImageSearch } from "./brave";
import { NOT_FOUND, isUpcLike, isEnrichable, type EnrichmentResult } from "./types";

export type { EnrichmentResult } from "./types";
export { lookupPricing } from "./pricing";
export type { PricingQuery, PricingResult } from "./pricing";

export type ItemLookupResult = { description?: string; images: string[] };

/**
 * Fill in a description and photos for an item that already exists, using its
 * own fields as the query. Unlike `enrich`, this does not touch the code-keyed
 * cache: the result belongs to this item, not to a barcode.
 */
export async function lookupItemFields(input: {
  name: string;
  brand?: string | null;
  model?: string | null;
  identifier?: string | null;
}): Promise<ItemLookupResult> {
  if (!env.llmConfigured && !env.webSearchConfigured) return { images: [] };

  const code = input.identifier ?? "";
  const guess = code
    ? await lookupProduct(code, {
        name: input.name,
        brand: input.brand,
        model: input.model,
      }).catch(() => null)
    : null;

  const query = [
    guess?.name ?? input.name,
    guess?.brand ?? input.brand,
    guess?.model ?? input.model,
  ]
    .filter(Boolean)
    .join(" ");
  const images = env.webSearchConfigured
    ? await braveImageSearch(query).catch(() => [] as string[])
    : [];

  return { description: guess?.description, images };
}

async function readCache(code: string): Promise<EnrichmentResult | null> {
  const [row] = await db
    .select()
    .from(enrichmentCache)
    .where(eq(enrichmentCache.code, code))
    .limit(1);
  return row ? (row.payload as EnrichmentResult) : null;
}

async function writeCache(code: string, result: EnrichmentResult): Promise<void> {
  await db
    .insert(enrichmentCache)
    .values({ code, provider: result.source, payload: result })
    .onConflictDoUpdate({
      target: enrichmentCache.code,
      set: { provider: result.source, payload: result, fetchedAt: new Date() },
    });
}

/** Second try for a code the barcode database did not recognise. */
async function lookupFromWeb(code: string): Promise<EnrichmentResult> {
  if (!env.llmConfigured && !env.webSearchConfigured) return NOT_FOUND;

  const guess = await lookupProduct(code).catch((err) => {
    logger.warn("enrich.product.error", { code, err: String(err) });
    return null;
  });

  const query = [guess?.name, guess?.brand, guess?.model].filter(Boolean).join(" ") || code;
  const images = env.webSearchConfigured
    ? await braveImageSearch(query).catch((err) => {
        logger.warn("enrich.brave.error", { code, err: String(err) });
        return [] as string[];
      })
    : [];

  if (!guess && images.length === 0) return NOT_FOUND;

  return {
    found: true,
    source: "web",
    name: guess?.name,
    description: guess?.description,
    brand: guess?.brand,
    model: guess?.model,
    category: guess?.category,
    imageUrl: images[0],
    images: images.length ? images : undefined,
    raw: guess,
  };
}

/**
 * Resolve product details for a code nobody has entered yet: cache, then the
 * barcode database, then the web. Reports not-found rather than throwing, and
 * the caller falls back to manual entry.
 *
 * `refresh` skips the cache, which is what a corrected re-search needs.
 */
export async function enrich(
  code: string,
  opts: { refresh?: boolean } = {},
): Promise<EnrichmentResult> {
  const trimmed = code.trim();
  if (!trimmed) return NOT_FOUND;

  if (!opts.refresh) {
    const cached = await readCache(trimmed);
    if (cached) return cached;
  }

  let result: EnrichmentResult = NOT_FOUND;

  if (isUpcLike(trimmed)) {
    result = await lookupUpcItemDb(trimmed).catch((err) => {
      logger.warn("enrich.upcitemdb.error", { code: trimmed, err: String(err) });
      return NOT_FOUND;
    });
  }

  // Only codes that could plausibly be a product are worth a slow lookup. Tag
  // reads and asset codes skip straight to the create form.
  if (!result.found && isEnrichable(trimmed)) {
    result = await lookupFromWeb(trimmed).catch((err) => {
      logger.warn("enrich.web.error", { code: trimmed, err: String(err) });
      return NOT_FOUND;
    });
  }

  if (result.found) await writeCache(trimmed, result);
  logger.info("enrich.result", { code: trimmed, found: result.found, source: result.source });
  return result;
}
