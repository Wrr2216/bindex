/**
 * Pure helpers for comparing what a vision model called things. Merging
 * duplicates across photos rests on these, so they lean conservative: two
 * names are only "the same thing" when their head nouns agree and the rest of
 * the words mostly do too.
 */

const STOP = new Set(["a", "an", "the", "of", "with", "and", "for", "on", "in", "set", "pair", "piece", "unit"]);

/** Words that describe colour; two names that each carry a different one are different things. */
const COLOURS = new Set([
  "black", "white", "grey", "gray", "silver", "red", "blue", "green", "yellow", "orange", "purple", "pink",
  "brown", "beige", "tan", "gold", "navy", "teal", "cream", "charcoal", "walnut", "oak", "maple", "cherry",
]);

const IRREGULAR: Record<string, string> = {
  shelves: "shelf",
  knives: "knife",
  mice: "mouse",
  people: "person",
  men: "man",
  women: "woman",
};

/** A rough singular: enough to make "chairs" meet "chair" and "boxes" meet "box". */
export function singular(word: string): string {
  const irregular = IRREGULAR[word];
  if (irregular) return irregular;
  if (word.length <= 3) return word;
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:xes|ches|shes|sses|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Lowercase words with punctuation, counts and filler removed, each made singular. */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w) && !/^\d+x?$/.test(w) && !/^x\d+$/.test(w))
    .map(singular);
}

/** The words of a name joined back up, for grouping identical names. */
export const nameKey = (name: string): string => nameTokens(name).join(" ");

/** The head noun, which in an English noun phrase is the last word: "office chair" → "chair". */
export function headNoun(tokens: string[]): string | null {
  return tokens.length ? tokens[tokens.length - 1]! : null;
}

/** The colour words in a name. */
export const colours = (name: string): Set<string> => new Set(nameTokens(name).filter((w) => COLOURS.has(w)));

export type NameMatch = { same: boolean; score: number; reason: string };

/**
 * Whether two names describe the same kind of thing. Same when the head nouns
 * agree, no colour conflicts, and either one name's words contain the other's
 * ("chair" and "black office chair") or at least two thirds of the words are
 * shared. "Black chair" and "red chair" stay apart; so do "monitor" and
 * "monitor arm".
 */
export function compareNames(a: string, b: string): NameMatch {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return { same: false, score: 0, reason: "no words to compare" };
  if (headNoun(ta) !== headNoun(tb)) return { same: false, score: 0, reason: "different kinds of thing" };
  const sa = new Set(ta);
  const sb = new Set(tb);
  const ca = [...sa].filter((w) => COLOURS.has(w));
  const cb = [...sb].filter((w) => COLOURS.has(w));
  if (ca.length && cb.length && !ca.some((c) => sb.has(c))) {
    return { same: false, score: 0, reason: "different colours" };
  }
  const shared = [...sa].filter((w) => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  const jaccard = shared / union;
  const contained = shared === sa.size || shared === sb.size;
  if (contained) return { same: true, score: 0.8 + jaccard * 0.2, reason: sa.size === sb.size ? "same name" : "one name contains the other" };
  if (jaccard >= 2 / 3) return { same: true, score: jaccard, reason: "mostly the same words" };
  return { same: false, score: jaccard, reason: "names differ too much" };
}

/** Brand or model text reduced for comparison: "Herman-Miller" meets "herman miller". */
export const squashText = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** True when both sides name a brand (or model) and they differ. */
export function conflicts(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = squashText(a);
  const y = squashText(b);
  if (!x || !y) return false;
  return !(x === y || x.includes(y) || y.includes(x));
}

// ---- Categories ------------------------------------------------------------

/**
 * A fixed vocabulary the model is asked to use, so "same category" means
 * something when merging. Each key lists words that mean it, checked against a
 * free-text category first and the item's name second.
 */
export const CATEGORIES: { key: string; label: string; words: string[] }[] = [
  { key: "seating", label: "Seating", words: ["seating", "chair", "stool", "sofa", "couch", "bench", "armchair", "seat", "ottoman", "recliner"] },
  { key: "desk", label: "Desk", words: ["desk", "workstation desk", "workbench"] },
  { key: "table", label: "Table", words: ["table"] },
  {
    key: "storage",
    label: "Storage",
    words: ["storage", "cabinet", "pedestal", "drawer", "shelf", "shelving", "bookcase", "bookshelf", "locker", "cupboard", "credenza", "filing", "file cabinet", "wardrobe", "hutch"],
  },
  { key: "monitor", label: "Monitor", words: ["monitor", "display", "screen"] },
  { key: "computer", label: "Computer", words: ["computer", "pc", "desktop", "tower", "server", "thin client", "mac mini", "imac"] },
  { key: "laptop", label: "Laptop", words: ["laptop", "notebook", "macbook", "chromebook"] },
  {
    key: "peripheral",
    label: "Peripheral",
    words: ["peripheral", "dock", "docking station", "port replicator", "keyboard", "mouse", "headset", "webcam", "hub", "ups"],
  },
  { key: "printer", label: "Printer", words: ["printer", "copier", "scanner", "plotter", "mfp", "fax"] },
  { key: "phone", label: "Phone", words: ["phone", "telephone", "handset", "conference phone", "smartphone"] },
  { key: "networking", label: "Networking", words: ["networking", "switch", "router", "access point", "patch panel", "firewall", "modem", "rack"] },
  { key: "av", label: "Audio-visual", words: ["av", "audio visual", "audio-visual", "projector", "television", "tv", "speaker", "camera", "microphone", "soundbar"] },
  {
    key: "appliance",
    label: "Appliance",
    words: ["appliance", "fridge", "refrigerator", "microwave", "kettle", "coffee machine", "coffee maker", "dishwasher", "water cooler", "freezer", "toaster", "oven"],
  },
  { key: "lighting", label: "Lighting", words: ["lighting", "lamp", "light", "floor lamp", "desk lamp"] },
  { key: "artwork", label: "Artwork", words: ["artwork", "art", "painting", "picture", "poster", "sculpture", "print"] },
  { key: "fixture", label: "Fixture", words: ["fixture", "whiteboard", "noticeboard", "partition", "screen divider", "coat rack", "mirror", "clock", "rug", "curtain"] },
  { key: "equipment", label: "Equipment", words: ["equipment", "machine", "forklift", "pallet jack", "trolley", "cart", "dolly", "ladder", "generator", "compressor"] },
  { key: "tool", label: "Tool", words: ["tool", "drill", "saw", "toolbox", "grinder", "wrench"] },
  { key: "container", label: "Container", words: ["container", "box", "carton", "crate", "bin", "tote", "case"] },
  { key: "plant", label: "Plant", words: ["plant", "planter"] },
  { key: "other", label: "Other", words: ["other"] },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
const BY_LABEL = new Map(CATEGORIES.map((c) => [c.label.toLowerCase(), c]));

function lookupWords(text: string): string | null {
  const tokens = nameTokens(text);
  if (!tokens.length) return null;
  const phrase = ` ${tokens.join(" ")} `;
  // The head noun decides first, so "desk lamp" is lighting, not a desk.
  const head = headNoun(tokens)!;
  for (const c of CATEGORIES) if (c.words.some((w) => nameKey(w) === head)) return c.key;
  for (const c of CATEGORIES) if (c.words.some((w) => phrase.includes(` ${nameKey(w)} `))) return c.key;
  return null;
}

/**
 * The category key for a free-text category and a name: an exact key or label
 * first, then the category's words, then the name's. "other" when nothing fits.
 */
export function categoryKey(category: string | null | undefined, name?: string | null): string {
  const raw = (category ?? "").trim().toLowerCase();
  if (raw) {
    if (BY_KEY.has(raw)) return raw;
    const byLabel = BY_LABEL.get(raw);
    if (byLabel) return byLabel.key;
    const found = lookupWords(raw);
    if (found) return found;
  }
  if (name) {
    const found = lookupWords(name);
    if (found) return found;
  }
  return "other";
}

/** The label shown and stored on the item for a category key. */
export const categoryLabel = (key: string): string => BY_KEY.get(key)?.label ?? "Other";

/** A category as stored on a draft: the model's own word when it is not one of ours, else our label. */
export function displayCategory(category: string | null | undefined, name?: string | null): string {
  const key = categoryKey(category, name);
  if (key !== "other") return categoryLabel(key);
  const raw = (category ?? "").trim();
  return raw && raw.toLowerCase() !== "other" ? raw.slice(0, 60) : "Other";
}
