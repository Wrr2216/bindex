import type { OpsSettings } from "./model";
import { median } from "./storage";
import type { StorageItem } from "./storage";
import { formatDistance } from "./text";

/**
 * Slotting: fast movers should live near the dock, slow movers can live at
 * the back. The rule, in full:
 *
 * 1. Only places with a distance to the dock (set on the place or a place
 *    above it) take part.
 * 2. The cut-off is the median distance over the assets that take part.
 * 3. Fast movers (class A) further out than the cut-off are taken furthest
 *    first; slow movers (class C) at or inside the cut-off, nearest first.
 * 4. Each fast mover is paired with the first unused slow mover whose place
 *    is at least `minGainM` nearer the dock. That pair is a suggested swap.
 * 5. A far fast mover with no partner left is listed as "move closer", with
 *    no target.
 *
 * Every suggestion carries a sentence that states the facts it rests on.
 */

export type SlotCandidate = StorageItem & { distanceToDockM: number };

export type SlottingSuggestion = {
  kind: "swap" | "move_closer";
  fast: SlotCandidate;
  slow: SlotCandidate | null;
  /** How much nearer the dock the fast mover would be. */
  gainM: number | null;
  /** Walking saved over a month, counting the way there and back for each movement. */
  savedMPerMonth: number | null;
  explanation: string;
};

export type SlottingResult = {
  cutoffM: number | null;
  considered: number;
  /** Assets whose place has no distance to the dock, so were left out. */
  withoutDistance: number;
  suggestions: SlottingSuggestion[];
  rule: string;
};

export const SLOTTING_RULE =
  "Fast movers (class A) stored further from the dock than the median are paired with slow movers (class C) stored nearer, when the swap brings the fast mover at least the minimum gain closer. Distances come from each place's distance to the dock, or the nearest place above it that has one.";

const label = (i: StorageItem) => (i.code ? `${i.name} (${i.code})` : i.name);

export function suggestSlotting(
  items: StorageItem[],
  distanceOf: (locationId: string | null) => number | null,
  settings: OpsSettings,
): SlottingResult {
  const { minGainM, maxSuggestions } = settings.slotting;
  const withDistance: SlotCandidate[] = [];
  let withoutDistance = 0;
  for (const i of items) {
    const d = i.locationId ? distanceOf(i.locationId) : null;
    if (d === null) withoutDistance += 1;
    else withDistance.push({ ...i, distanceToDockM: d });
  }
  const cutoff = median(withDistance.map((c) => c.distanceToDockM));
  if (cutoff === null) {
    return { cutoffM: null, considered: 0, withoutDistance, suggestions: [], rule: SLOTTING_RULE };
  }

  const fast = withDistance
    .filter((c) => c.abc === "A" && c.distanceToDockM > cutoff)
    .sort((x, y) => y.distanceToDockM - x.distanceToDockM || y.movements - x.movements || x.itemId.localeCompare(y.itemId));
  const slow = withDistance
    .filter((c) => c.abc === "C" && c.distanceToDockM <= cutoff)
    .sort((x, y) => x.distanceToDockM - y.distanceToDockM || x.movements - y.movements || x.itemId.localeCompare(y.itemId));

  const used = new Set<string>();
  const suggestions: SlottingSuggestion[] = [];
  for (const f of fast) {
    if (suggestions.length >= maxSuggestions) break;
    const partner = slow.find((s) => !used.has(s.itemId) && f.distanceToDockM - s.distanceToDockM >= minGainM);
    if (partner) {
      used.add(partner.itemId);
      const gain = f.distanceToDockM - partner.distanceToDockM;
      const saved = Math.round(gain * 2 * f.movesPerMonth);
      suggestions.push({
        kind: "swap",
        fast: f,
        slow: partner,
        gainM: gain,
        savedMPerMonth: saved,
        explanation:
          `${label(f)} moved ${f.movements} times in the window (class A) but sits in ${f.locationPath ?? "a place"}, ` +
          `${formatDistance(f.distanceToDockM)} from the dock. ${label(partner)} moved ${partner.movements} times (class C) ` +
          `and sits in ${partner.locationPath ?? "a place"}, ${formatDistance(partner.distanceToDockM)} from the dock. ` +
          `Swapping them brings the fast mover ${formatDistance(gain)} closer, about ${formatDistance(saved)} of walking a month.`,
      });
    } else {
      suggestions.push({
        kind: "move_closer",
        fast: f,
        slow: null,
        gainM: null,
        savedMPerMonth: null,
        explanation:
          `${label(f)} moved ${f.movements} times in the window (class A) but sits in ${f.locationPath ?? "a place"}, ` +
          `${formatDistance(f.distanceToDockM)} from the dock, beyond the median of ${formatDistance(cutoff)}. ` +
          `No slow mover near the dock is left to swap with; find it a closer spot.`,
      });
    }
  }
  return { cutoffM: cutoff, considered: withDistance.length, withoutDistance, suggestions, rule: SLOTTING_RULE };
}
