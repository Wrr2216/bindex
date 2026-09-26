import type { ConditionRating, ContainerFlag, ContentLine, Defect } from "../../db/tables/ai-condition";
import {
  cleanLines,
  cleanText,
  confidenceValue,
  matchListEntry,
  normalizeBool,
  normalizeDefects,
  normalizeFlags,
  normalizeQty,
  normalizeRating,
} from "./vocab";

/**
 * Turn what a vision model sent back into drafts a person reviews. Pure, so
 * each odd reply seen in the wild becomes a fixture test. Every function
 * returns null for a reply with nothing usable in it, never throws, and never
 * lets a value outside the fixed vocabularies through.
 */

export const LOW_CONFIDENCE = 0.6;
export const MAX_CONTENT_LINES = 100;

export type ContainerDraft = {
  /** One of the configured size classes, or null. */
  sizeClass: string | null;
  /** What the model said when it did not match a configured class, for the reviewer. */
  sizeClassRaw: string | null;
  handwrittenText: string | null;
  room: string | null;
  contentsSummary: string | null;
  contents: ContentLine[];
  flags: ContainerFlag[];
  /** 0 to 1 per field; 0 for a field that was not read. */
  confidence: { sizeClass: number; handwrittenText: number; room: number; contents: number };
};

export type AssessmentDraft = {
  rating: ConditionRating | null;
  /** The model's own description; saved as the report's ai_notes. */
  summary: string | null;
  defects: Defect[];
  handlingNote: string | null;
  confidence: number | null;
};

export type ComparisonDraft = {
  summary: string | null;
  newDefects: Defect[];
  resolvedDefects: Defect[];
  ratingAfter: ConditionRating | null;
  /** True when the model saw new damage. */
  changed: boolean;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

// Items must never land in the digital-asset category by accident; it switches
// on domain behaviour elsewhere in the app.
const RESERVED_CATEGORIES = new Set(["domain"]);

/** A content category mapped onto the configured list; unmatched ones become "Other" when the list has it. */
export function normalizeCategory(v: unknown, categories: readonly string[]): string | null {
  const matched = matchListEntry(v, categories);
  if (matched) return RESERVED_CATEGORIES.has(matched.toLowerCase()) ? null : matched;
  if (!cleanText(v)) return null;
  return categories.find((c) => c.toLowerCase() === "other") ?? null;
}

/** One contents line from a model or a form, or null when it has no name. */
export function normalizeContentLine(v: unknown, categories: readonly string[]): ContentLine | null {
  if (typeof v === "string") {
    // "3 x dinner plates" / "Books (12)"
    const text = cleanText(v, 120);
    if (!text) return null;
    const lead = /^(\d{1,4})\s*[x×]?\s+(.+)$/i.exec(text);
    const trail = /^(.+?)\s*[(x×]\s*(\d{1,4})\)?$/i.exec(text);
    const name = lead ? lead[2]! : trail ? trail[1]! : text;
    const qty = lead ? Number(lead[1]) : trail ? Number(trail[2]) : 1;
    return { name: name.slice(0, 120), category: null, qty: normalizeQty(qty), condition: null, fragile: false, description: null };
  }
  if (!isObject(v)) return null;
  const name = cleanText(v.name ?? v.item ?? v.title ?? v.label, 120);
  if (!name) return null;
  return {
    name,
    category: normalizeCategory(v.category ?? v.type, categories),
    qty: normalizeQty(v.qty ?? v.quantity ?? v.count),
    condition: normalizeRating(v.condition ?? v.rating),
    fragile: normalizeBool(v.fragile),
    description: cleanText(v.description ?? v.details ?? v.notes, 300),
  };
}

export function normalizeContentLines(v: unknown, categories: readonly string[]): ContentLine[] {
  if (!Array.isArray(v)) return [];
  const out: ContentLine[] = [];
  for (const x of v) {
    const line = normalizeContentLine(x, categories);
    if (line) out.push(line);
    if (out.length >= MAX_CONTENT_LINES) break;
  }
  return out;
}

function confidenceOf(conf: unknown, field: string, fallback: number | null): number {
  const c = isObject(conf) ? confidenceValue(conf[field]) : null;
  return c ?? fallback ?? 0.5;
}

export function normalizeContainerCapture(
  raw: Record<string, unknown> | null,
  lists: { sizeClasses: readonly string[]; categories: readonly string[] },
): ContainerDraft | null {
  if (!isObject(raw)) return null;
  const sizeRaw = cleanText(raw.sizeClass ?? raw.size_class ?? raw.size ?? raw.boxSize, 60);
  const sizeClass = matchListEntry(sizeRaw, lists.sizeClasses);
  const contents = normalizeContentLines(raw.contents ?? raw.items, lists.categories);
  const flags = normalizeFlags(raw.flags ?? raw.markings);
  // A line marked fragile in a box nobody marked is still a fragile box.
  if (contents.some((c) => c.fragile) && !flags.includes("fragile")) flags.unshift("fragile");

  const draft: ContainerDraft = {
    sizeClass,
    sizeClassRaw: sizeClass ? null : sizeRaw,
    handwrittenText: cleanLines(raw.handwrittenText ?? raw.handwriting ?? raw.writing ?? raw.text),
    room: cleanText(raw.room ?? raw.destination ?? raw.area, 80),
    contentsSummary: cleanText(raw.contentsSummary ?? raw.contents_summary ?? raw.summary, 200),
    contents,
    flags,
    confidence: { sizeClass: 0, handwrittenText: 0, room: 0, contents: 0 },
  };

  // A single overall number applies to every field that was filled in.
  const overall = confidenceValue(raw.confidence);
  const conf = raw.confidence;
  draft.confidence = {
    sizeClass: sizeRaw ? confidenceOf(conf, "sizeClass", overall) : 0,
    handwrittenText: draft.handwrittenText ? confidenceOf(conf, "handwrittenText", overall) : 0,
    room: draft.room ? confidenceOf(conf, "room", overall) : 0,
    contents: contents.length ? confidenceOf(conf, "contents", overall) : 0,
  };
  // An answer that is not one of the configured classes is not to be trusted
  // as one, whatever the model claimed.
  if (sizeRaw && !sizeClass) draft.confidence.sizeClass = Math.min(draft.confidence.sizeClass, 0.3);

  const found =
    draft.sizeClass || draft.sizeClassRaw || draft.handwrittenText || draft.room || draft.contentsSummary ||
    draft.contents.length || draft.flags.length;
  return found ? draft : null;
}

export function normalizeAssessment(raw: Record<string, unknown> | null): AssessmentDraft | null {
  if (!isObject(raw)) return null;
  const draft: AssessmentDraft = {
    rating: normalizeRating(raw.rating ?? raw.condition ?? raw.grade),
    summary: cleanText(raw.summary ?? raw.notes ?? raw.description, 1000),
    defects: normalizeDefects(raw.defects ?? raw.damage),
    handlingNote: cleanText(raw.handlingNote ?? raw.handling_note ?? raw.handling, 300),
    confidence: confidenceValue(raw.confidence),
  };
  // Any one of these is worth showing; a reply with none of them is a miss.
  if (!draft.rating && !draft.summary && !draft.defects.length && !draft.handlingNote) return null;
  return draft;
}

export function normalizeComparison(raw: Record<string, unknown> | null): ComparisonDraft | null {
  if (!isObject(raw)) return null;
  const newDefects = normalizeDefects(raw.newDefects ?? raw.new_defects ?? raw.added);
  const resolvedDefects = normalizeDefects(raw.resolvedDefects ?? raw.resolved_defects ?? raw.resolved);
  const summary = cleanText(raw.summary ?? raw.notes, 1000);
  const ratingAfter = normalizeRating(raw.ratingAfter ?? raw.rating_after ?? raw.rating);
  if (!summary && !newDefects.length && !resolvedDefects.length && !ratingAfter && typeof raw.changed !== "boolean") {
    return null;
  }
  return {
    summary,
    newDefects,
    resolvedDefects,
    ratingAfter,
    // Trust the list over the flag: new defects listed means something changed.
    changed: newDefects.length > 0 || raw.changed === true,
  };
}
