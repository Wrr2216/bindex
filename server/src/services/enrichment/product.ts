import { chatJson } from "./model";
import { str } from "./extract";

export type ProductGuess = {
  name?: string;
  description?: string;
  brand?: string;
  model?: string;
  category?: string;
};

const SYSTEM = [
  "You identify physical products from a scanned identifier (UPC, EAN, serial,",
  "model number or MAC address) plus any fields already known.",
  "Reply with one JSON object in a ```json code block and nothing else, with the",
  "keys: name, description, brand, model, category. Use null for anything you",
  "cannot determine. The description is one or two factual sentences with no",
  'marketing language. If you cannot identify the product, reply {"name": null}.',
].join(" ");

/**
 * Guess what a scanned code belongs to when the barcode database has no answer.
 * Returns null when no language model is configured or the product could not be
 * identified, which the caller treats the same as a miss.
 */
export async function lookupProduct(
  code: string,
  known: { name?: string | null; brand?: string | null; model?: string | null } = {},
): Promise<ProductGuess | null> {
  const parts = [`scanned identifier: "${code}"`];
  if (known.name) parts.push(`known name: ${known.name}`);
  if (known.brand) parts.push(`known brand: ${known.brand}`);
  if (known.model) parts.push(`known model: ${known.model}`);

  const parsed = await chatJson({
    event: "enrich.product",
    context: { code },
    system: SYSTEM,
    user: `Identify the product for this ${parts.join("; ")}. Return the JSON object.`,
  });
  if (!parsed) return null;

  const name = str(parsed.name);
  if (!name) return null;

  return {
    name,
    description: str(parsed.description),
    brand: str(parsed.brand),
    model: str(parsed.model),
    category: str(parsed.category),
  };
}
