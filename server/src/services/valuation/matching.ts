import { squash } from "./parse";

/**
 * Proposing which item each receipt line is for. Pure: the candidates are
 * fetched by receipts.ts, scored here, and a person confirms or changes every
 * proposal before anything is saved.
 *
 * Evidence, strongest first: the serial printed on the line; a product code
 * that matches a SKU, UPC or the model number on file; the model number
 * appearing in the line's text; and how alike the names read.
 */

export type MatchCandidate = {
  itemId: string;
  /** Set when the evidence points at one unit (its serial). */
  unitId?: string | null;
  name: string;
  brand: string | null;
  model: string | null;
  assetCode: string;
  /** Serials on the item's identifiers. */
  serials: string[];
  /** Product codes on the item: sku and upc identifiers. */
  codes: string[];
  units: { id: string; serial: string | null; label: string | null }[];
};

export type LineForMatch = { description: string; sku: string | null; serial: string | null };

export type MatchReason = "serial" | "unit_serial" | "code" | "model" | "name";

export type ScoredMatch = {
  itemId: string;
  unitId: string | null;
  name: string;
  assetCode: string;
  score: number;
  reason: MatchReason;
  /** Why, in words, for the review screen. */
  explanation: string;
};

/** Below this, a candidate is not offered at all. */
export const MIN_SCORE = 0.3;
/** At or above this, a candidate is picked for the person to confirm. */
export const SUGGEST_SCORE = 0.45;

const STOP = new Set(["THE", "AND", "WITH", "FOR", "PCS", "PC", "EA", "EACH", "QTY", "NEW", "SET", "OF"]);

/** Words of at least two characters, uppercased, without filler. */
function words(s: string): string[] {
  return s
    .toUpperCase()
    .split(/[^0-9A-Z]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(s)) {
    const padded = `  ${w} `;
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * How alike two names read, 0 to 1: trigram overlap as pg_trgm computes it,
 * plus credit for whole words of the shorter found in the longer, since a
 * receipt abbreviates ("DELL LAT 5440") where the record spells out.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const trigram = shared / (ta.size + tb.size - shared);
  // Two-letter words ("HM", "SZ", "I7") are too often abbreviations of
  // anything to count either way.
  const wa = new Set(words(a).filter((w) => w.length >= 3));
  const wb = new Set(words(b).filter((w) => w.length >= 3));
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let found = 0;
  // An abbreviated word matches the start of a whole one ("LAT", "LATITUDE");
  // numbers only match exactly, or 5440 would match 54400.
  const alpha = (w: string) => /^[A-Z]+$/.test(w);
  for (const w of small) {
    if (large.has(w) || [...large].some((l) => alpha(w) && alpha(l) && (l.startsWith(w) || w.startsWith(l)))) found++;
  }
  // One shared word is thin evidence however it scores.
  const wordShare = small.size ? (found / small.size) * (small.size >= 2 ? 0.9 : 0.6) : 0;
  return Math.round(Math.max(trigram, wordShare) * 100) / 100;
}

/** The best evidence that `line` is `candidate`, or null when there is none worth showing. */
export function scoreMatch(line: LineForMatch, c: MatchCandidate): ScoredMatch | null {
  const base = { itemId: c.itemId, name: c.name, assetCode: c.assetCode };
  const lineSerial = squash(line.serial);
  const text = squash(`${line.description} ${line.sku ?? ""} ${line.serial ?? ""}`);

  if (lineSerial.length >= 4) {
    const unit = c.units.find((u) => squash(u.serial) === lineSerial);
    if (unit) {
      return { ...base, unitId: unit.id, score: 1, reason: "unit_serial", explanation: `Serial ${line.serial} is on unit ${unit.label ?? unit.serial}` };
    }
    if (c.serials.some((s) => squash(s) === lineSerial)) {
      return { ...base, unitId: null, score: 1, reason: "serial", explanation: `Serial ${line.serial} matches` };
    }
  }
  // A serial printed inside the description rather than in its own field.
  for (const u of c.units) {
    const s = squash(u.serial);
    if (s.length >= 6 && text.includes(s)) {
      return { ...base, unitId: u.id, score: 0.95, reason: "unit_serial", explanation: `Serial ${u.serial} appears on the line` };
    }
  }
  for (const serial of c.serials) {
    const s = squash(serial);
    if (s.length >= 6 && text.includes(s)) {
      return { ...base, unitId: null, score: 0.95, reason: "serial", explanation: `Serial ${serial} appears on the line` };
    }
  }

  const code = squash(line.sku);
  if (code.length >= 4) {
    const hit = c.codes.find((x) => squash(x) === code);
    if (hit) return { ...base, unitId: null, score: 0.9, reason: "code", explanation: `Product code ${hit} matches` };
    if (squash(c.model) === code) return { ...base, unitId: null, score: 0.85, reason: "model", explanation: `Model ${c.model} matches the product code` };
  }
  const model = squash(c.model);
  if (model.length >= 4 && text.includes(model)) {
    return { ...base, unitId: null, score: 0.8, reason: "model", explanation: `Model ${c.model} appears on the line` };
  }

  const label = [c.brand, c.name, c.model].filter(Boolean).join(" ");
  const sim = nameSimilarity(line.description, label);
  let score = sim * 0.7;
  // The brand printed on the line is weak evidence on its own, but it breaks
  // ties between similarly named things.
  if (c.brand && words(line.description).includes(c.brand.toUpperCase().split(/\s+/)[0]!)) score += 0.05;
  score = Math.round(Math.min(score, 0.75) * 100) / 100;
  if (score < MIN_SCORE) return null;
  return { ...base, unitId: null, score, reason: "name", explanation: `Name is similar (${Math.round(sim * 100)}%)` };
}

export type LineProposal = {
  /** Up to three candidates, best first. */
  candidates: ScoredMatch[];
  /** The one picked for the person to confirm, or null to leave the line unmatched. */
  suggested: ScoredMatch | null;
};

/**
 * Candidates for every line, and one suggestion each. Suggestions are handed
 * out best score first, and a record (item or unit) goes to at most one line,
 * so two lines for similar products do not both claim the same record.
 */
export function proposeMatches(lines: LineForMatch[], candidates: MatchCandidate[], preferItemId?: string | null): LineProposal[] {
  const scored = lines.map((line) =>
    candidates
      .map((c) => scoreMatch(line, c))
      .filter((m): m is ScoredMatch => m !== null)
      .map((m) =>
        // An item the person started from (receipt added on its page) wins a tie.
        preferItemId && m.itemId === preferItemId ? { ...m, score: Math.min(1, Math.round((m.score + 0.05) * 100) / 100) } : m,
      )
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
  );

  const pairs = scored
    .flatMap((list, lineIndex) => list.filter((m) => m.score >= SUGGEST_SCORE).map((m) => ({ lineIndex, m })))
    .sort((a, b) => b.m.score - a.m.score || a.lineIndex - b.lineIndex);
  const suggested: (ScoredMatch | null)[] = lines.map(() => null);
  const taken = new Set<string>();
  for (const { lineIndex, m } of pairs) {
    const key = m.unitId ? `unit:${m.unitId}` : `item:${m.itemId}`;
    if (suggested[lineIndex] || taken.has(key)) continue;
    suggested[lineIndex] = m;
    taken.add(key);
  }

  return scored.map((list, i) => {
    const pick = suggested[i] ?? null;
    const top = list.slice(0, 3);
    // The pick can sit below the top three when better ones went to other lines.
    if (pick && !top.includes(pick)) top.push(pick);
    return { candidates: top, suggested: pick };
  });
}
