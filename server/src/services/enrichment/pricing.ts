export type PricingQuery = {
  name: string;
  brand?: string | null;
  model?: string | null;
  upc?: string | null;
};

export type PricingResult = {
  found: boolean;
  priceCents?: number;
  currency?: string;
  retailer?: string;
  url?: string;
  /** ISO timestamp of the lookup, shown so a stale price is obvious. */
  checkedAt: string;
  notes?: string;
  images: string[];
  raw?: unknown;
};

export { lookupBestEffortPrice as lookupPricing } from "./price";
