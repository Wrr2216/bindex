import type {
  ConditionRating,
  ConditionStage,
  ContainerFlag,
  Defect,
  DefectSeverity,
  DefectType,
} from "../../db/tables/ai-condition";

/**
 * The fixed words condition records use, and pure functions that map whatever
 * a person or a model wrote onto them. Kept free of I/O so every odd reply can
 * be a fixture test.
 */

export const STAGES = ["before", "after", "inspection", "custom"] as const satisfies readonly ConditionStage[];
export const RATINGS = ["excellent", "good", "fair", "poor", "damaged"] as const satisfies readonly ConditionRating[];
export const DEFECT_TYPES = [
  "scratch",
  "dent",
  "gouge",
  "stain",
  "crack",
  "loose",
  "missing_part",
  "other",
] as const satisfies readonly DefectType[];
export const SEVERITIES = ["minor", "moderate", "major"] as const satisfies readonly DefectSeverity[];
export const CONTAINER_FLAGS = [
  "fragile",
  "this_side_up",
  "high_value",
  "heavy",
  "keep_dry",
] as const satisfies readonly ContainerFlag[];

export const DEFAULT_SIZE_CLASSES = [
  "small",
  "medium",
  "large",
  "wardrobe",
  "dish pack",
  "tote",
  "pallet",
  "crate",
] as const;

export const DEFAULT_CATEGORIES = [
  "Kitchenware",
  "Dishes and glassware",
  "Books and paper",
  "Documents and files",
  "Clothing and linens",
  "Electronics",
  "IT equipment",
  "Office supplies",
  "Tools and hardware",
  "Decor and art",
  "Toys and games",
  "Furniture parts",
  "Other",
] as const;

/** Worst first is the wrong way round for sorting; this is best to worst. */
export const RATING_RANK: Record<ConditionRating, number> = { excellent: 0, good: 1, fair: 2, poor: 3, damaged: 4 };
export const SEVERITY_RANK: Record<DefectSeverity, number> = { minor: 0, moderate: 1, major: 2 };

const PLACEHOLDER = new Set(["", "n/a", "na", "none", "null", "unknown", "-", "--", "?", "not visible", "not applicable", "unclear"]);

/** A trimmed single-line string, or null for blanks and placeholders. */
export function cleanText(v: unknown, max = 200): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (PLACEHOLDER.has(s.toLowerCase())) return null;
  return s.slice(0, max) || null;
}

/** Like cleanText but keeps line breaks, for handwriting transcribed line by line. */
export function cleanLines(v: unknown, max = 2000): string | null {
  if (Array.isArray(v)) v = v.filter((x) => typeof x === "string").join("\n");
  if (typeof v !== "string") return null;
  const lines = v
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const s = lines.join("\n").slice(0, max);
  return s && !PLACEHOLDER.has(s.toLowerCase()) ? s : null;
}

const word = (v: unknown) =>
  typeof v === "string"
    ? v
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

// Anchored at the start, so "not damaged" is not read as damaged.
const RATING_WORDS: [RegExp, ConditionRating][] = [
  [/^(excellent|mint|new|brand new|like new|as new|pristine|perfect|unused)\b/, "excellent"],
  [/^(very good|good|ok|okay|fine|used|light wear|lightly used|normal wear|serviceable)\b/, "good"],
  [/^(fair|average|acceptable|worn|moderate wear|some wear|moderate|minor damage|slightly damaged|some damage)\b/, "fair"],
  [/^(poor|very poor|bad|heavily worn|heavy wear|very worn|rough|well worn)\b/, "poor"],
  [/^(damaged|heavily damaged|broken|destroyed|cracked|shattered|unusable|not usable|defective|smashed|wrecked)\b/, "damaged"],
];

/** A rating from a word, a phrase starting with one, or a 1-5 score (5 best). */
export function normalizeRating(v: unknown): ConditionRating | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1 && v <= 5 ? RATINGS[5 - v]! : null;
  let w = word(v);
  if (!w) return null;
  if (/^[1-5]$/.test(w)) return RATINGS[5 - Number(w)]!;
  // "Overall condition: good", "in fair condition", "appears like new".
  w = w.replace(/^(?:(?:overall|condition|in|looks|appears|seems|is|item|rated|rating)\s+)+/, "");
  if ((RATINGS as readonly string[]).includes(w)) return w as ConditionRating;
  for (const [re, rating] of RATING_WORDS) if (re.test(w)) return rating;
  return null;
}

const TYPE_WORDS: [RegExp, DefectType][] = [
  [/\b(missing|absent|lost)\b/, "missing_part"],
  [/\b(loose|wobbl\w*|detached|unstable|rattl\w*)\b/, "loose"],
  [/\b(crack\w*|fractur\w*|split|broken|shatter\w*|craz\w*)\b/, "crack"],
  [/\b(gouge\w*|chip\w*|nick\w*|puncture\w*|hole|tear|torn|rip\w*|cut)\b/, "gouge"],
  [/\b(dent\w*|ding\w*|bent|deform\w*|crush\w*|warp\w*)\b/, "dent"],
  // Before stains, so "scuff marks" is a scratch and "water marks" a stain.
  [/\b(scratch\w*|scuff\w*|abrasion\w*|scrap\w*|rub\w*|wear)\b/, "scratch"],
  [/\b(stain\w*|spill\w*|discolou?r\w*|mark\w*|water damage|watermark|mould|mold|rust\w*|soil\w*|dirt\w*)\b/, "stain"],
];

export function normalizeDefectType(v: unknown): DefectType {
  const w = word(v).replace(/ /g, "_");
  if ((DEFECT_TYPES as readonly string[]).includes(w)) return w as DefectType;
  const spaced = w.replace(/_/g, " ");
  for (const [re, type] of TYPE_WORDS) if (re.test(spaced)) return type;
  return "other";
}

/** minor / moderate / major, from a word or a 1-3 score. Unknown reads as moderate. */
export function normalizeSeverity(v: unknown): DefectSeverity {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v <= 1) return "minor";
    return v < 3 ? "moderate" : "major";
  }
  const w = word(v);
  if (/^[0-9]+$/.test(w)) return normalizeSeverity(Number(w));
  if (/\b(minor|light|low|small|slight|cosmetic|superficial|faint|hairline|tiny)\b/.test(w)) return "minor";
  if (/\b(major|severe|high|heavy|serious|significant|structural|deep|large|critical|extensive)\b/.test(w)) return "major";
  return "moderate";
}

const FLAG_WORDS: [RegExp, ContainerFlag][] = [
  [/\b(fragile|handle with care|glass|breakable|delicate|with care)\b/, "fragile"],
  [/\b(this side up|this way up|keep upright|top load only|arrows? up|up arrows?|upright)\b/, "this_side_up"],
  [/\b(high value|valuable|valuables|high val|expensive|precious)\b/, "high_value"],
  [/\b(heavy|team lift|two person lift|2 person lift)\b/, "heavy"],
  [/\b(keep dry|do not get wet|protect from (?:moisture|rain|water)|umbrella)\b/, "keep_dry"],
];

export function normalizeFlag(v: unknown): ContainerFlag | null {
  const w = word(v);
  if (!w) return null;
  const slug = w.replace(/ /g, "_");
  if ((CONTAINER_FLAGS as readonly string[]).includes(slug)) return slug as ContainerFlag;
  for (const [re, flag] of FLAG_WORDS) if (re.test(w)) return flag;
  return null;
}

/** Unique known flags, in the fixed order, from a list or a comma-separated string. */
export function normalizeFlags(v: unknown): ContainerFlag[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;|]/) : [];
  const found = new Set<ContainerFlag>();
  for (const x of list) {
    const f = normalizeFlag(x);
    if (f) found.add(f);
  }
  return CONTAINER_FLAGS.filter((f) => found.has(f));
}

/**
 * Match a free-text answer to one entry of a configured list (size classes,
 * categories): exact, then ignoring case and punctuation, then the shortest
 * entry the answer contains or that contains the answer. Null when none fits.
 */
export function matchListEntry(v: unknown, list: readonly string[]): string | null {
  const text = cleanText(v, 120);
  if (!text) return null;
  const exact = list.find((e) => e === text);
  if (exact) return exact;
  const w = word(text);
  if (!w) return null;
  const keyed = list.map((e) => ({ e, k: word(e) })).filter((x) => x.k);
  const same = keyed.find((x) => x.k === w || x.k.replace(/ /g, "") === w.replace(/ /g, ""));
  if (same) return same.e;
  // "Medium box" -> "medium"; "Books" -> "Books and paper". Whole words only,
  // so "pallet" does not match "palette knife".
  const has = (hay: string, needle: string) => ` ${hay} `.includes(` ${needle} `);
  const plural = (s: string) => s.replace(/s\b/g, "");
  const hits = keyed.filter(
    (x) => has(w, x.k) || has(x.k, w) || has(plural(w), plural(x.k)) || has(plural(x.k), plural(w)),
  );
  if (!hits.length) return null;
  hits.sort((a, b) => a.k.length - b.k.length);
  return hits[0]!.e;
}

/** A model's confidence in whatever form it chose: 0.9, 90, "90%", "high". */
export function confidenceValue(v: unknown): number | null {
  if (typeof v === "string") {
    const w = v.trim().toLowerCase();
    if (w === "high") return 0.9;
    if (w === "medium") return 0.6;
    if (w === "low") return 0.3;
    v = Number(w.replace(/%$/, ""));
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  if (v > 1 && v <= 100) return Math.round(v) / 100;
  return v <= 1 ? Math.round(v * 100) / 100 : null;
}

/** A whole quantity from 1 to 9999; 1 when the model gave nothing usable. */
export function normalizeQty(v: unknown): number {
  const n = typeof v === "string" ? Number(/\d+(?:\.\d+)?/.exec(v)?.[0] ?? NaN) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return 1;
  return Math.min(9999, Math.round(n));
}

export function normalizeBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return /^(true|yes|y|1|fragile)$/i.test(String(v ?? "").trim());
}

/** One defect from a model or a form, or null when it says nothing at all. */
export function normalizeDefect(v: unknown): Defect | null {
  if (typeof v === "string") {
    const text = cleanText(v, 300);
    return text ? { area: "general", type: normalizeDefectType(text), severity: normalizeSeverity(text), description: text } : null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const area = cleanText(r.area ?? r.location ?? r.where ?? r.part, 80);
  const description = cleanText(r.description ?? r.details ?? r.note ?? r.notes, 300);
  const rawType = r.type ?? r.kind ?? r.defect;
  if (!area && !description && !cleanText(rawType)) return null;
  return {
    area: area ?? "general",
    // A model that wrote only "deep scratch on lid" in the description still
    // gets a type.
    type: cleanText(rawType) ? normalizeDefectType(rawType) : normalizeDefectType(description),
    severity: normalizeSeverity(r.severity ?? r.level ?? description),
    description,
  };
}

/** Up to 50 defects, dropping empty entries and exact repeats. */
export function normalizeDefects(v: unknown): Defect[] {
  if (!Array.isArray(v)) return [];
  const out: Defect[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const d = normalizeDefect(x);
    if (!d) continue;
    const key = `${d.type}|${d.area.toLowerCase()}|${d.severity}|${(d.description ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
    if (out.length >= 50) break;
  }
  return out;
}

const FLAG_TEXT: Record<ContainerFlag, string> = {
  fragile: "Fragile",
  this_side_up: "This side up",
  high_value: "High value",
  heavy: "Heavy",
  keep_dry: "Keep dry",
};

export const flagLabel = (f: ContainerFlag) => FLAG_TEXT[f];
