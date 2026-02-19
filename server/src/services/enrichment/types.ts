/** Where a set of product details came from. */
export type EnrichmentSource = "upcitemdb" | "web" | "none";

export type EnrichmentResult = {
  found: boolean;
  source: EnrichmentSource;
  name?: string;
  description?: string;
  brand?: string;
  model?: string;
  category?: string;
  imageUrl?: string;
  images?: string[];
  raw?: unknown;
};

export const NOT_FOUND: EnrichmentResult = { found: false, source: "none" };

/** Is this a UPC or EAN barcode, and so worth asking the barcode database? */
export function isUpcLike(code: string): boolean {
  return /^\d{8}$|^\d{12,14}$/.test(code.trim());
}

/**
 * Is a slower web lookup worth running for this code? Tag reads and asset codes
 * never resolve to a real product, and skipping them keeps scanning instant.
 */
export function isEnrichable(code: string): boolean {
  const t = code.trim();
  if (isUpcLike(t)) return true;
  // Even-length hex of eight or more characters: a tag EPC, not a product.
  if (/^[0-9a-fA-F]+$/.test(t) && t.length >= 8 && t.length % 2 === 0) return false;
  if (t.length < 4) return false;
  // Model numbers contain letters; a bare run of digits is an asset code.
  return /[a-zA-Z]/.test(t);
}
