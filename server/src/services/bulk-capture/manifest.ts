import { cleanValue, confidenceValue } from "../media-ai-core/dataPlate";
import { parseQty } from "./detections";

/**
 * Paper inventories and manifests: a page photo (or a rendered PDF page) in,
 * clean rows out. Mover and warehouse inventories share a vocabulary of
 * condition codes and coloured lot stickers, which is decoded here so the
 * created records carry words, not just symbols.
 */

export type Sticker = { color: string | null; lot: string | null; number: string | null };

export type ManifestRow = {
  lineNo: number | null;
  description: string;
  qty: number;
  /** As printed, upper case: ["SC-3,7", "BR"]. */
  conditionCodes: string[];
  /** The codes in words: "scratched (corner, rear); broken". Null when there were none. */
  condition: string | null;
  sticker: Sticker | null;
  room: string | null;
  notes: string | null;
  confidence: number | null;
};

export type ManifestHeader = {
  title: string | null;
  date: string | null;
  lot: string | null;
  stickerColor: string | null;
  reference: string | null;
};

export type ManifestReading = { header: ManifestHeader; rows: ManifestRow[] };

/** Descriptive symbols used on household-goods and office-move inventories. */
export const CONDITION_CODES: Record<string, string> = {
  BE: "bent",
  BR: "broken",
  BU: "burned",
  CH: "chipped",
  CP: "carrier packed",
  CU: "contents unknown",
  D: "dented",
  DBO: "disassembled by owner",
  F: "faded",
  G: "gouged",
  L: "loose",
  M: "marred",
  MI: "mildew",
  MO: "moth-eaten",
  PBO: "packed by owner",
  R: "rubbed",
  RU: "rusted",
  SC: "scratched",
  SH: "short",
  SO: "soiled",
  T: "torn",
  W: "badly worn",
  Z: "cracked",
};

/** Where on the piece, the numbers that follow a code ("SC-3,7" is scratched at the corner and rear). */
export const CONDITION_LOCATIONS: Record<number, string> = {
  1: "arm",
  2: "bottom",
  3: "corner",
  4: "front",
  5: "left",
  6: "leg",
  7: "rear",
  8: "right",
  9: "side",
  10: "top",
  11: "veneer",
  12: "edge",
  13: "center",
  14: "inside",
  15: "seat",
  16: "drawer",
  17: "door",
  18: "shelf",
  19: "hardware",
};

/**
 * Condition codes as printed ("BR SC-3,7", ["sc 3", "BR"], "BR/SC") into
 * separate codes and their meaning. Unknown codes are kept as printed.
 */
export function parseConditionCodes(v: unknown): { codes: string[]; words: string | null } {
  const pieces = (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
    .filter((p): p is string => typeof p === "string")
    .join(" ")
    .toUpperCase();
  const codes: string[] = [];
  const words: string[] = [];
  // A code is one to three letters, optionally followed by location numbers;
  // a longer word is a condition someone wrote out, kept as a word.
  const re = /\b([A-Z]{1,3})(?![A-Z])(?:[\s-]*(\d{1,2}(?:\s*[,&\s]\s*\d{1,2})*))?|\b([A-Z]{4,})\b/g;
  for (const m of pieces.replace(/[/;|]+/g, " ").matchAll(re)) {
    if (m[3]) {
      words.push(m[3].toLowerCase());
      continue;
    }
    const code = m[1]!;
    const locs = m[2] ? m[2].split(/\s*[,&\s]\s*/).filter(Boolean).map(Number) : [];
    codes.push(locs.length ? `${code}-${locs.join(",")}` : code);
    const meaning = CONDITION_CODES[code];
    if (!meaning) {
      words.push(code);
      continue;
    }
    const where = locs.map((n) => CONDITION_LOCATIONS[n]).filter(Boolean);
    words.push(where.length ? `${meaning} (${where.join(", ")})` : meaning);
    if (codes.length >= 12) break;
  }
  return { codes, words: words.length ? words.join("; ") : null };
}

const COLOURS = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "white", "black", "grey", "gray", "brown", "silver", "gold"];

const cleanNumber = (v: unknown): string | null => {
  const s = cleanValue(v, 40);
  if (!s) return null;
  const out = s.replace(/^(?:#|no\.?|number|lot|tag)\s*/i, "").trim();
  return out || null;
};

/**
 * A lot sticker as a model or a person wrote it: an object, or text such as
 * "Red 2231-045", "RED/2231/45" or "#045". Two number groups are lot then
 * number; one is the number.
 */
export function parseSticker(v: unknown): Sticker | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const s: Sticker = {
      color: cleanValue(o.color ?? o.colour, 30)?.toLowerCase() ?? null,
      lot: cleanNumber(o.lot ?? o.lotNumber ?? o.lot_number),
      number: cleanNumber(o.number ?? o.tag ?? o.tagNumber ?? o.tag_number ?? o.no),
    };
    return s.color || s.lot || s.number ? s : null;
  }
  const text = cleanValue(v, 80);
  if (!text) return null;
  const lower = text.toLowerCase();
  const color = COLOURS.find((c) => new RegExp(`\\b${c}\\b`).test(lower)) ?? null;
  const groups = text.match(/[A-Za-z]?\d[\dA-Za-z]*/g) ?? [];
  const s: Sticker = {
    color,
    lot: groups.length >= 2 ? groups[0]! : null,
    number: groups.length ? groups[groups.length - 1]! : null,
  };
  return s.color || s.lot || s.number ? s : null;
}

/** "12", "12.", "#12", "No. 12", 12 → 12. */
export function parseLineNo(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : null;
  if (typeof v !== "string") return null;
  const m = /^\s*(?:#|no\.?|line)?\s*(\d{1,6})\s*[.)]?\s*$/i.exec(v);
  return m ? Number(m[1]) : null;
}

function arrayIn(raw: Record<string, unknown>, keys: string[]): unknown[] {
  for (const k of keys) if (Array.isArray(raw[k])) return raw[k] as unknown[];
  for (const v of Object.values(raw)) if (Array.isArray(v) && v.some((x) => x && typeof x === "object")) return v;
  return [];
}

const MAX_ROWS = 200;

/**
 * Turn a manifest reply into rows. A row needs a description; everything else
 * is optional. The page header's lot and sticker colour fill rows that leave
 * them out, which is how coloured-lot inventories are written.
 */
export function normalizeManifest(raw: Record<string, unknown> | null): ManifestReading | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const h = (raw.header && typeof raw.header === "object" && !Array.isArray(raw.header) ? raw.header : {}) as Record<string, unknown>;
  const headerSticker = parseSticker(h.sticker ?? null);
  const header: ManifestHeader = {
    title: cleanValue(h.title ?? raw.title, 120),
    date: cleanValue(h.date ?? raw.date, 40),
    lot: cleanNumber(h.lot ?? h.lotNumber ?? headerSticker?.lot ?? null),
    stickerColor: cleanValue(h.stickerColor ?? h.sticker_color ?? h.color ?? headerSticker?.color ?? null, 30)?.toLowerCase() ?? null,
    reference: cleanValue(h.reference ?? h.orderNumber ?? h.order ?? h.customer, 80),
  };

  const rows: ManifestRow[] = [];
  for (const entry of arrayIn(raw, ["rows", "lines", "items", "entries"])) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const description = cleanValue(e.description ?? e.item ?? e.article ?? e.name, 200);
    // A bare number is a line or tag number read into the wrong column.
    if (!description || !/\p{L}/u.test(description)) continue;
    const { codes, words } = parseConditionCodes(e.conditionCodes ?? e.condition_codes ?? e.codes ?? e.exceptions);
    const conditionText = cleanValue(e.condition, 200);
    let sticker =
      parseSticker(e.sticker ?? null) ??
      parseSticker({ color: e.stickerColor ?? e.color, lot: e.lot, number: e.tagNumber ?? e.tag ?? e.stickerNumber });
    if (header.lot || header.stickerColor) {
      sticker = {
        color: sticker?.color ?? header.stickerColor,
        lot: sticker?.lot ?? header.lot,
        number: sticker?.number ?? null,
      };
    }
    rows.push({
      lineNo: parseLineNo(e.lineNo ?? e.line ?? e.no ?? e.number),
      description,
      qty: Math.min(100_000, parseQty(e.qty ?? e.quantity ?? e.count) ?? 1),
      conditionCodes: codes,
      condition: [words, conditionText && conditionText.toUpperCase() !== codes.join(" ") ? conditionText : null].filter(Boolean).join("; ") || null,
      sticker,
      room: cleanValue(e.room ?? e.area ?? e.location, 80),
      notes: cleanValue(e.notes ?? e.remarks ?? e.comment, 300),
      confidence: confidenceValue(e.confidence),
    });
    if (rows.length >= MAX_ROWS) break;
  }
  return { header, rows };
}

export const MANIFEST_SYSTEM =
  "You transcribe paper inventories, packing lists and moving manifests, printed or handwritten, into structured rows. " +
  "You copy what is written without correcting or inventing it, and reply with one JSON object and nothing else.";

export const MANIFEST_PROMPT = `This image is one page of a paper inventory or manifest. Transcribe every line item on it and reply with:
{
  "header": {
    "title": the form's title, or null,
    "date": the date written on it, or null,
    "reference": an order, job or customer reference, or null,
    "lot": a lot number that applies to the whole page, or null,
    "stickerColor": a sticker or tag colour that applies to the whole page, or null
  },
  "rows": [
    {
      "lineNo": the line or item number as written, or null,
      "description": the article as written, such as "Sofa 3 seat" or "Carton, books",
      "qty": the quantity, 1 when none is written,
      "conditionCodes": condition or exception symbols exactly as written, such as ["SC-3,7", "BR"], or [],
      "condition": any condition written in words, or null,
      "sticker": { "color": sticker or tag colour, "lot": lot number, "number": tag or sticker number } when the line has one, else null,
      "room": the room or destination written for the line, or null,
      "notes": anything else written on the line, or null,
      "confidence": 0 to 1, lower where the handwriting is hard to read
    }
  ]
}
Keep the rows in the order they appear. Do not add rows for headings, totals or blank lines. If the page has no line items, reply with "rows": [].`;
