import { hasReached, isExceptionStage } from "../jobs-core";
import "./model";

/**
 * Placement progress: of the lines going somewhere, how many are in their
 * room. Pure arithmetic over stages, so the bars on the job page, the kiosk
 * and a sweep all agree.
 */

export type Tally = {
  total: number;
  placed: number;
  /** Not placed yet, exceptions included. */
  remaining: number;
  /** Lines at each exception stage (misplaced, missing, wrong_shipment...). */
  exceptions: Record<string, number>;
  /** Whole percent placed. */
  percent: number;
};

export type TallyLine = { stage: string };

export function tally(lines: readonly TallyLine[]): Tally {
  const counts: Record<string, number> = {};
  for (const { stage } of lines) counts[stage] = (counts[stage] ?? 0) + 1;
  return tallyCounts(counts);
}

/** The same tally from stage counts, as a GROUP BY stage query returns them. */
export function tallyCounts(counts: Readonly<Record<string, number>>): Tally {
  const exceptions: Record<string, number> = {};
  let placed = 0;
  let total = 0;
  for (const [stage, n] of Object.entries(counts)) {
    if (!n) continue;
    total += n;
    if (stage === "placed") placed += n;
    else if (isExceptionStage(stage)) exceptions[stage] = (exceptions[stage] ?? 0) + n;
  }
  return {
    total,
    placed,
    remaining: total - placed,
    exceptions,
    percent: total ? Math.floor((placed / total) * 100) : 0,
  };
}

/** Group lines and tally each group. A null key (no floor, no destination) sorts last. */
export function tallyBy<L extends TallyLine>(
  lines: readonly L[],
  keyOf: (l: L) => string | null,
): { key: string | null; tally: Tally }[] {
  const groups = new Map<string | null, L[]>();
  for (const l of lines) {
    const k = keyOf(l) || null;
    const list = groups.get(k);
    if (list) list.push(l);
    else groups.set(k, [l]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    })
    .map(([key, list]) => ({ key, tally: tally(list) }));
}

export type AfterDeliveryReason =
  /** The truck is delivered, and the line was never scanned off it. */
  | "not_unloaded"
  /** Someone already flagged it missing. */
  | "flagged_missing"
  /** Scanned off the truck, but not in its room. */
  | "not_placed";

/**
 * Lines at risk once their shipment is delivered: never unloaded, flagged
 * missing, or unloaded and not yet in their room. Lines on shipments still on
 * the road, and lines on no shipment, are not listed: nothing says they
 * should have arrived.
 */
export function afterDeliveryReason(line: { stage: string; shipmentStatus: string | null }): AfterDeliveryReason | null {
  if (line.shipmentStatus !== "delivered" && line.shipmentStatus !== "closed") return null;
  if (line.stage === "missing") return "flagged_missing";
  if (isExceptionStage(line.stage)) return null;
  if (!hasReached(line.stage, "delivered")) return "not_unloaded";
  return line.stage === "placed" ? null : "not_placed";
}
