import type { ConditionRating, Defect } from "../../db/tables/ai-condition";
import { RATING_RANK, SEVERITY_RANK } from "./vocab";

/**
 * The deterministic half of a before/after comparison: which recorded defects
 * are new, gone, worse, better or the same. It works on the defect lists
 * people confirmed, so it gives the same answer every time and never needs a
 * model; the AI comparison of the photos is shown next to it, not instead.
 *
 * Two defects are the same one when they have the same type and their areas
 * name the same place. Areas are free text, so "Top-left corner of the lid"
 * and "lid, top left corner" are reduced to the same set of words first.
 */

export type DefectPair = { before: Defect; after: Defect };

export type DefectDiff = {
  /** In the after report with nothing like it before: new damage. */
  added: Defect[];
  /** Recorded before and not after: repaired, or not visible any more. */
  resolved: Defect[];
  /** The same defect, more severe now. */
  worsened: DefectPair[];
  improved: DefectPair[];
  unchanged: DefectPair[];
  /** Per defect of the after list, in its order, for marking a list on screen. */
  afterStatus: ("new" | "worse" | "better" | "same")[];
  /** Per defect of the before list: gone, or still there in some form. */
  beforeStatus: ("gone" | "matched")[];
};

const SYNONYMS: Record<string, string> = {
  rear: "back",
  behind: "back",
  lhs: "left",
  rhs: "right",
  upper: "top",
  lower: "bottom",
  underside: "bottom",
  beneath: "bottom",
  underneath: "bottom",
  foot: "leg",
  feet: "leg",
  cover: "lid",
  topside: "top",
  frontside: "front",
};

// Words that say nothing about where: "left side" and "left" are one place.
const STOP = new Set([
  "the", "a", "an", "of", "on", "at", "in", "near", "by", "to", "and", "with", "from",
  "side", "panel", "area", "surface", "section", "part", "piece", "item", "general",
  "whole", "overall", "entire", "edge", "face",
]);

/** The words of an area that locate it, normalized and sorted. */
export function areaTokens(area: string): string[] {
  const words = area
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => SYNONYMS[w] ?? w)
    // Plurals: "corners" and "corner" are the same place.
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .map((w) => SYNONYMS[w] ?? w)
    .filter((w) => !STOP.has(w));
  return [...new Set(words)].sort();
}

/** How alike two areas are, 0 to 1. Below 0.5 they are different places. */
export function areaSimilarity(a: string, b: string): number {
  const x = areaTokens(a);
  const y = areaTokens(b);
  if (!x.length || !y.length) return x.length === y.length ? 1 : 0;
  const ys = new Set(y);
  const shared = x.filter((w) => ys.has(w)).length;
  if (shared === x.length && shared === y.length) return 1;
  // "lid" and "lid top left": the less specific one is inside the other.
  if (shared === Math.min(x.length, y.length)) return 0.75;
  return shared / new Set([...x, ...y]).size;
}

const MATCH = 0.5;

export function diffDefects(before: Defect[], after: Defect[]): DefectDiff {
  const candidates: { b: number; a: number; score: number; gap: number }[] = [];
  before.forEach((bd, b) => {
    after.forEach((ad, a) => {
      if (bd.type !== ad.type) return;
      const score = areaSimilarity(bd.area, ad.area);
      if (score >= MATCH) {
        candidates.push({ b, a, score, gap: Math.abs(SEVERITY_RANK[bd.severity] - SEVERITY_RANK[ad.severity]) });
      }
    });
  });
  // Best matches first; ties go to the closer severity, then to list order, so
  // the same input always pairs the same way.
  candidates.sort((p, q) => q.score - p.score || p.gap - q.gap || p.b - q.b || p.a - q.a);

  const usedB = new Set<number>();
  const usedA = new Set<number>();
  const diff: DefectDiff = {
    added: [],
    resolved: [],
    worsened: [],
    improved: [],
    unchanged: [],
    afterStatus: after.map(() => "new"),
    beforeStatus: before.map(() => "gone"),
  };
  const pairs: { b: number; a: number }[] = [];
  for (const c of candidates) {
    if (usedB.has(c.b) || usedA.has(c.a)) continue;
    usedB.add(c.b);
    usedA.add(c.a);
    pairs.push(c);
  }
  pairs.sort((p, q) => p.a - q.a);
  for (const { b, a } of pairs) {
    const pair = { before: before[b]!, after: after[a]! };
    const delta = SEVERITY_RANK[pair.after.severity] - SEVERITY_RANK[pair.before.severity];
    if (delta > 0) diff.worsened.push(pair);
    else if (delta < 0) diff.improved.push(pair);
    else diff.unchanged.push(pair);
    diff.afterStatus[a] = delta > 0 ? "worse" : delta < 0 ? "better" : "same";
    diff.beforeStatus[b] = "matched";
  }
  after.forEach((d, a) => {
    if (!usedA.has(a)) diff.added.push(d);
  });
  before.forEach((d, b) => {
    if (!usedB.has(b)) diff.resolved.push(d);
  });
  return diff;
}

/** Whether the second rating is worse than the first; null when either is missing. */
export function ratingChange(
  before: ConditionRating | null,
  after: ConditionRating | null,
): "worse" | "better" | "same" | null {
  if (!before || !after) return null;
  const d = RATING_RANK[after] - RATING_RANK[before];
  return d > 0 ? "worse" : d < 0 ? "better" : "same";
}
