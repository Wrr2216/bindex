import { env } from "../../env";
import { logger } from "../../lib/logger";
import { str } from "./extract";
import { chatJson } from "./model";
import { braveWebSearch, type BraveWebHit } from "./brave";
import type { PricingQuery, PricingResult } from "./pricing";

const SYSTEM = [
  "You read search-result snippets and report the current retail price of the",
  "product they describe. Reply with one JSON object in a ```json code block and",
  "nothing else, with the keys: priceUsd (a number in US dollars with no",
  'currency symbol, or null), currency (such as "USD"), retailer (the source,',
  "or null), url (a direct link to the listing, or null), notes (one short",
  "factual sentence, or null). Set priceUsd to null when the snippets do not",
  "state a price.",
].join(" ");

type Extracted = {
  priceCents?: number;
  retailer?: string;
  url?: string;
  notes?: string;
};

function describe(q: PricingQuery): string {
  return [q.brand, q.name, q.model && `model ${q.model}`, q.upc && `UPC ${q.upc}`]
    .filter((part) => (typeof part === "string" ? part.trim() : part))
    .join(", ");
}

async function extractPrice(descriptor: string, hits: BraveWebHit[]): Promise<Extracted | null> {
  const snippets = hits
    .map((h, i) => `(${i + 1}) ${h.title ?? ""}\n${h.description ?? ""}\n${h.url ?? ""}`)
    .join("\n\n");
  if (!snippets) return null;

  const parsed = await chatJson({
    event: "price.extract",
    context: { descriptor },
    system: SYSTEM,
    user: `Product: ${descriptor}\n\nSearch snippets:\n${snippets}\n\nReturn the JSON object.`,
  });
  if (!parsed) return null;

  const common = { retailer: str(parsed.retailer), url: str(parsed.url), notes: str(parsed.notes) };
  const priceUsd = typeof parsed.priceUsd === "number" ? parsed.priceUsd : 0;
  if (!(priceUsd > 0)) return common;
  return { ...common, priceCents: Math.round(priceUsd * 100) };
}

/**
 * Best-effort street price: search the web for listings, then read a price out
 * of the snippets. Needs both a search key and a language model; without either
 * it reports nothing found rather than failing.
 */
export async function lookupBestEffortPrice(q: PricingQuery): Promise<PricingResult> {
  const checkedAt = new Date().toISOString();
  if (!env.webSearchConfigured || !env.llmConfigured) {
    return { found: false, checkedAt, images: [] };
  }

  const descriptor = describe(q);
  const hits = await braveWebSearch(`price ${descriptor}`);
  const extracted = await extractPrice(descriptor, hits);

  const result: PricingResult = {
    found: extracted?.priceCents !== undefined,
    priceCents: extracted?.priceCents,
    currency: "USD",
    retailer: extracted?.retailer,
    url: extracted?.url,
    notes: extracted?.notes,
    checkedAt,
    images: [],
  };

  logger.info("price.result", { descriptor, found: result.found, priceCents: result.priceCents });
  return result;
}
