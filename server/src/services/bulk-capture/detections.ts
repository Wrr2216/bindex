import type { CaptureBbox, CaptureDeskTemplate } from "../../db/tables/bulk-capture";
import { cleanValue, confidenceValue } from "../media-ai-core/dataPlate";
import { CATEGORIES, displayCategory, nameKey } from "./names";

/**
 * What a vision model saw in one walkthrough or desk photo, and the prompts
 * that ask for it. The normalizers are pure so every odd reply a provider
 * sends can be a fixture test.
 */

export type Detection = {
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
  qty: number;
  bbox: CaptureBbox | null;
  confidence: number | null;
  description: string | null;
};

export type PhotoReading = {
  /** The model's short description of the space, if it gave one. */
  room: string | null;
  /** A desk or workstation number it could read on a sign or label. */
  deskLabel: string | null;
  items: Detection[];
};

const MAX_ITEMS = 80;
const MAX_QTY = 999;

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12, pair: 2, single: 1, a: 1, an: 1,
};

/**
 * A count as people and models write it: 3, "3", "3 ea", "x3", "3x", "qty: 3",
 * "two", "1/2" (read as 1). Null when there is no count at all.
 */
export function parseQty(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.min(MAX_QTY * 100, Math.max(1, Math.round(v))) : null;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  const digits = /(\d+(?:[.,]\d+)?)/.exec(s.replace(/^(?:qty|quantity|count|pcs|no)\s*[:.]?\s*/, ""));
  if (digits) {
    const n = Number(digits[1]!.replace(",", "."));
    if (Number.isFinite(n) && n > 0) return Math.min(MAX_QTY * 100, Math.max(1, Math.round(n)));
    return null;
  }
  const word = s.split(/[\s-]+/).find((w) => WORDS[w] !== undefined);
  return word ? WORDS[word]! : null;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * A bounding box in whatever shape the model chose, as fractions of the image
 * with the origin top left. The prompt asks for [x, y, width, height] in 0–1;
 * models also send corner pairs, 0–1000 grids and pixels (converted when the
 * image size is known). Null for anything implausible, since a wrong crop is
 * worse than none.
 */
export function normalizeBbox(v: unknown, image?: { width: number | null; height: number | null } | null): CaptureBbox | null {
  let nums: number[] | null = null;
  if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    nums = v as number[];
  } else if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null);
    const x = n("x") ?? n("left") ?? n("x1") ?? n("xmin");
    const y = n("y") ?? n("top") ?? n("y1") ?? n("ymin");
    const w = n("w") ?? n("width");
    const h = n("h") ?? n("height");
    const x2 = n("right") ?? n("x2") ?? n("xmax");
    const y2 = n("bottom") ?? n("y2") ?? n("ymax");
    if (x !== null && y !== null && w !== null && h !== null) nums = [x, y, w, h];
    else if (x !== null && y !== null && x2 !== null && y2 !== null) nums = [x, y, x2 - x, y2 - y];
  }
  if (!nums || nums.some((n) => n < 0)) return null;
  let [x, y, w, h] = nums as [number, number, number, number];

  const max = Math.max(x, y, w, h);
  if (max > 1) {
    // Up to 1000 is read as the 0–1000 grid several model families use; only
    // pixels run past it. Pixels are of the image the model was sent.
    const W = image?.width ?? null;
    const H = image?.height ?? null;
    const [sx, sy] = max <= 1000 ? [1000, 1000] : W && H ? [W, H] : [0, 0];
    if (!sx || !sy) return null;
    x /= sx;
    w /= sx;
    y /= sy;
    h /= sy;
  }
  // [x1, y1, x2, y2] read as a width and height runs off the image; as corners it fits.
  if ((x + w > 1.02 || y + h > 1.02) && w > x && h > y && w <= 1 && h <= 1) {
    w -= x;
    h -= y;
  }
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  if (w < 0.01 || h < 0.01) return null;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
}

function arrayIn(raw: Record<string, unknown>, keys: string[]): unknown[] {
  for (const k of keys) if (Array.isArray(raw[k])) return raw[k] as unknown[];
  // Some models wrap the list one level down, or name it something else.
  for (const v of Object.values(raw)) if (Array.isArray(v) && v.some((x) => x && typeof x === "object")) return v;
  return [];
}

/**
 * Turn a walkthrough or desk reply into clean detections. Entries without a
 * name are dropped; identical names in one photo are one entry with their
 * counts added, since two lines about "chair" in one frame are two chairs.
 */
export function normalizePhotoReading(
  raw: Record<string, unknown> | null,
  image?: { width: number | null; height: number | null } | null,
): PhotoReading | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = arrayIn(raw, ["items", "objects", "assets", "detections", "inventory"]);
  const byName = new Map<string, Detection>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const name = cleanValue(e.name ?? e.item ?? e.label ?? e.object, 120);
    if (!name) continue;
    const key = nameKey(name);
    if (!key) continue;
    const qty = Math.min(MAX_QTY, parseQty(e.qty ?? e.quantity ?? e.count) ?? 1);
    const detection: Detection = {
      name,
      category: displayCategory(cleanValue(e.category ?? e.type, 60), name),
      brand: cleanValue(e.brand ?? e.make ?? e.manufacturer, 80),
      model: cleanValue(e.model, 80),
      qty,
      bbox: normalizeBbox(e.bbox ?? e.box ?? e.boundingBox ?? e.bounding_box, image),
      confidence: confidenceValue(e.confidence),
      description: cleanValue(e.description ?? e.notes ?? e.condition, 300),
    };
    const seen = byName.get(key);
    if (seen) {
      seen.qty = Math.min(MAX_QTY, seen.qty + detection.qty);
      seen.brand ??= detection.brand;
      seen.model ??= detection.model;
      seen.bbox ??= detection.bbox;
      seen.description ??= detection.description;
      if (detection.confidence !== null) seen.confidence = Math.max(seen.confidence ?? 0, detection.confidence);
      continue;
    }
    if (byName.size >= MAX_ITEMS) continue;
    byName.set(key, detection);
  }
  return {
    room: cleanValue(raw.room ?? raw.space ?? raw.scene, 120),
    deskLabel: cleanValue(raw.deskLabel ?? raw.desk_label ?? raw.desk ?? raw.workstation, 60),
    items: [...byName.values()],
  };
}

// ---- Prompts ---------------------------------------------------------------

export const PHOTO_SYSTEM =
  "You catalogue the physical assets an organisation owns from photos of rooms, offices, warehouses and desks. " +
  "You only list what is clearly visible, never guess at hidden things, and reply with one JSON object and nothing else.";

const CATEGORY_KEYS = CATEGORIES.map((c) => c.key).join(", ");

const ITEM_SHAPE = `{
      "name": a short plain name such as "office chair", "24-inch monitor", "filing cabinet",
      "category": one of ${CATEGORY_KEYS},
      "brand": brand if a logo or label is legible, else null,
      "model": model if legible, else null,
      "qty": how many identical ones are visible,
      "bbox": [x, y, width, height] around them as fractions of the image (0 to 1, origin top left), or null,
      "confidence": 0 to 1,
      "description": one short sentence on appearance or visible condition, or null
    }`;

export function walkthroughPrompt(area: string | null): string {
  return `List every asset an organisation would track that is visible in this photo${area ? ` of ${area}` : ""}: furniture, equipment, electronics, appliances, fittings that can be moved.
Reply with:
{
  "room": a few words describing the space, or null,
  "items": [
    ${ITEM_SHAPE}
  ]
}
Put identical things in one entry and give the count in qty. Leave out walls, floors, ceilings, windows, doors, built-in fixtures, people, and small consumables such as paper, pens, cups and cables.
If you are unsure whether two things are the same kind, list them separately. If nothing qualifies, reply with "items": [].`;
}

export function deskPrompt(area: string | null, template: CaptureDeskTemplate | null): string {
  const expected = template?.items.length
    ? `A standard workstation here has: ${template.items.map((i) => `${i.qty} × ${i.label.toLowerCase()}`).join(", ")}. Report what you actually see, including when something is missing or extra.`
    : "";
  return `This photo shows one desk or workstation${area ? ` (${area})` : ""} in an office. List every asset on, under and beside it: monitors, docking stations, computers, laptops, keyboards, mice, phones, chairs, pedestals and drawer units, lamps.
${expected}
Reply with:
{
  "deskLabel": a desk or workstation number printed on a sign or label in the photo, or null,
  "items": [
    ${ITEM_SHAPE}
  ]
}
Put identical things in one entry and give the count in qty. Leave out people, papers, cups, cables and personal belongings.`;
}
