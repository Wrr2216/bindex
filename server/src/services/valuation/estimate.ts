import { visionJson, type VisionImage } from "../ai";
import { cleanText, parseConfidence, parseCurrency, parseMoney } from "./parse";

/**
 * AI valuation: photos of an item in, a suggested identification and value
 * range out, for a person to confirm. Nothing here saves anything; the value a
 * person accepts is recorded by recordValuation with the estimate attached as
 * its evidence.
 *
 * These are estimates. The prompt asks the model to say how sure it is, and
 * normalizeEstimate lowers that when the item was not identified or the range
 * is too wide to mean much.
 */

export const CONDITIONS = ["new", "like new", "good", "fair", "poor", "damaged"] as const;
export type Condition = (typeof CONDITIONS)[number];

export type ValueRange = {
  lowCents: number;
  highCents: number;
  /** The middle of the range, offered as the value to accept. */
  suggestedCents: number;
  currency: string;
  basis: string | null;
};

export type ValuationEstimate = {
  brand: string | null;
  model: string | null;
  category: string | null;
  materials: string | null;
  condition: string | null;
  conditionNotes: string | null;
  description: string | null;
  estimatedValue: ValueRange | null;
  /** 0 to 1, after the safeguards below. */
  confidence: number;
  /** The model answered in another currency than the instance uses; the value was not converted. */
  currencyMismatch: boolean;
};

export type KnownDetails = {
  name?: string | null;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
};

export const VALUATION_SYSTEM =
  "You identify items from photos and estimate what they are worth, for insurance and high-value declarations. " +
  "You describe only what is visible, never invent a model number, and say how sure you are. " +
  "Reply with one JSON object and nothing else.";

export function valuationPrompt(currency: string, known: KnownDetails = {}): string {
  const facts = [
    known.name && `name "${known.name}"`,
    known.brand && `brand "${known.brand}"`,
    known.model && `model "${known.model}"`,
    known.category && `category "${known.category}"`,
  ].filter(Boolean);
  return `Identify the item in the photos and estimate what it is worth today. Reply with this JSON object:
{
  "brand": maker or brand, or null,
  "model": model name or number as printed or as you recognise it, or null,
  "category": a short category such as "Laptop", "Office chair", "Pallet jack", or null,
  "materials": the main materials, such as "aluminium, glass" or "solid oak", or null,
  "condition": one of ${CONDITIONS.map((c) => `"${c}"`).join(", ")}, or null,
  "conditionNotes": visible wear or damage in one short sentence, or null,
  "description": one sentence an insurance adjuster could use to recognise this exact item,
  "estimatedValue": { "low": number, "high": number, "currency": "${currency}", "basis": one sentence on how you arrived at it, such as "used resale price for this model in good condition" },
  "confidence": a number from 0 to 1 for how sure you are of both the identification and the value
}
Amounts are plain numbers in major units (dollars, not cents) without symbols, in ${currency}. Estimate the fair market value of this item in its visible condition, not the new retail price. If you cannot identify the item, set brand and model to null, give a wide range and a low confidence.${
    facts.length ? `\nWhat is already on file: ${facts.join(", ")}. Use it if the photos agree; say otherwise if they do not.` : ""
  }`;
}

const CONDITION_WORDS: Record<string, Condition> = {
  new: "new",
  "brand new": "new",
  sealed: "new",
  "like new": "like new",
  "as new": "like new",
  excellent: "like new",
  mint: "like new",
  "very good": "good",
  good: "good",
  used: "good",
  fair: "fair",
  worn: "fair",
  poor: "poor",
  bad: "poor",
  damaged: "damaged",
  broken: "damaged",
};

/** A condition word mapped onto the short scale; other wording is kept as written. */
export function normalizeCondition(v: unknown): string | null {
  const s = cleanText(v, 40);
  if (!s) return null;
  return CONDITION_WORDS[s.toLowerCase()] ?? s;
}

const RANGE_SPLIT = /\s*(?:–|—|to|-)\s*/i;

/** { low, high } from whatever shape the model used: an object, one number, or "1,200 - 1,500". */
function readRange(raw: unknown): { low: number | null; high: number | null; currency: unknown; basis: unknown } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const single = parseMoney(r.value ?? r.mid ?? r.estimate);
    return {
      low: parseMoney(r.low ?? r.min ?? r.minimum) ?? single,
      high: parseMoney(r.high ?? r.max ?? r.maximum) ?? single,
      currency: r.currency,
      basis: r.basis ?? r.reason ?? r.method,
    };
  }
  if (typeof raw === "string") {
    const stripped = raw.trim();
    // A leading minus is a range separator only between two amounts.
    const parts = stripped.replace(/^-/, "").split(RANGE_SPLIT).filter(Boolean);
    if (parts.length === 2) return { low: parseMoney(parts[0]), high: parseMoney(parts[1]), currency: null, basis: null };
    const one = parseMoney(stripped);
    return { low: one, high: one, currency: null, basis: null };
  }
  const one = parseMoney(raw);
  return { low: one, high: one, currency: null, basis: null };
}

/**
 * Turn whatever the model sent into a clean estimate, or null when it sent
 * nothing usable. Pure, so every odd reply is a test case.
 *
 * Safeguards on top of the model's own confidence: an item it could not name
 * (no brand and no model) is capped at 0.5, and a range whose top is more than
 * five times its bottom is capped at 0.3, since that is not an estimate anyone
 * should sign.
 */
export function normalizeEstimate(raw: Record<string, unknown> | null, currency: string): ValuationEstimate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const range = readRange(raw.estimatedValue ?? raw.estimated_value ?? raw.value ?? raw.estimate ?? raw.price);
  let low = range.low;
  let high = range.high;
  if (low === null && high !== null) low = high;
  if (high === null && low !== null) high = low;
  if (low !== null && high !== null && low > high) [low, high] = [high, low];

  const answeredIn = parseCurrency(range.currency ?? raw.currency, currency) ?? currency;
  const estimatedValue: ValueRange | null =
    low !== null && high !== null && high > 0
      ? {
          lowCents: low,
          highCents: high,
          // Rounded to whole units: an estimate to the cent claims too much.
          suggestedCents: Math.round((low + high) / 2 / 100) * 100,
          currency: answeredIn,
          basis: cleanText(range.basis ?? raw.basis, 300),
        }
      : null;

  const estimate: ValuationEstimate = {
    brand: cleanText(raw.brand ?? raw.manufacturer, 120),
    model: cleanText(raw.model, 120),
    category: cleanText(raw.category, 60),
    materials: cleanText(
      Array.isArray(raw.materials) ? raw.materials.filter((m) => typeof m === "string").join(", ") : raw.materials,
      200,
    ),
    condition: normalizeCondition(raw.condition),
    conditionNotes: cleanText(raw.conditionNotes ?? raw.condition_notes ?? raw.damage, 300),
    description: cleanText(raw.description, 500),
    estimatedValue,
    confidence: 0,
    currencyMismatch: Boolean(estimatedValue && answeredIn !== currency),
  };

  if (!estimate.estimatedValue && !estimate.brand && !estimate.model && !estimate.description) return null;

  let c = parseConfidence(raw.confidence) ?? 0.5;
  if (!estimate.brand && !estimate.model) c = Math.min(c, 0.5);
  if (estimatedValue && estimatedValue.lowCents > 0 && estimatedValue.highCents > estimatedValue.lowCents * 5) c = Math.min(c, 0.3);
  if (estimatedValue && estimatedValue.lowCents === 0) c = Math.min(c, 0.3);
  estimate.confidence = Math.round(c * 100) / 100;
  return estimate;
}

/** Ask the vision model about an item's photos. Null when unavailable or unreadable. */
export async function estimateFromPhotos(
  images: VisionImage[],
  currency: string,
  known: KnownDetails = {},
  context: Record<string, unknown> = {},
): Promise<ValuationEstimate | null> {
  const raw = await visionJson({
    event: "ai.valuation",
    system: VALUATION_SYSTEM,
    prompt: valuationPrompt(currency, known),
    images,
    maxTokens: 900,
    context,
  });
  return normalizeEstimate(raw, currency);
}
