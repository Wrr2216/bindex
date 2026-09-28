import type { ClaimResolution } from "../../db/schema";

/**
 * A claim's money. Pure, so the arithmetic is tested on its own.
 *
 * With lines, the claim's totals are the sums of its lines and cannot be typed
 * in: what the claim asks for is exactly what its lines ask for. Without lines
 * (a delay, damage to a building) the totals are entered on the claim itself.
 *
 * Amounts are integer cents throughout; nothing here divides.
 */

export type TotalsLine = {
  estimatedCents: number | null;
  approvedCents: number | null;
  resolution: ClaimResolution | null;
};

export type ClaimTotals = {
  /** True when the totals come from the lines. */
  fromLines: boolean;
  lineCount: number;
  estimatedTotalCents: number | null;
  /** Null until something has been decided. */
  approvedTotalCents: number | null;
  /** Lines with a resolution, and an approved amount unless denied. */
  decidedLines: number;
  undecidedLines: number;
  deniedLines: number;
  /** Lines nobody has put an estimate on yet. */
  unestimatedLines: number;
  /** Approved cents by resolution, for the adjuster's summary. */
  approvedByResolution: Record<Exclude<ClaimResolution, "deny">, number>;
};

/** A denied line pays nothing, whatever amount was typed against it. */
export function lineApprovedCents(line: TotalsLine): number | null {
  if (line.resolution === "deny") return 0;
  return line.approvedCents;
}

export function isLineDecided(line: TotalsLine): boolean {
  if (!line.resolution) return false;
  return line.resolution === "deny" || line.approvedCents !== null;
}

export function claimTotals(
  lines: readonly TotalsLine[],
  manual: { estimatedTotalCents: number | null; approvedTotalCents: number | null },
): ClaimTotals {
  const approvedByResolution = { repair: 0, replace: 0, cash: 0 };
  if (lines.length === 0) {
    return {
      fromLines: false,
      lineCount: 0,
      estimatedTotalCents: manual.estimatedTotalCents,
      approvedTotalCents: manual.approvedTotalCents,
      decidedLines: 0,
      undecidedLines: 0,
      deniedLines: 0,
      unestimatedLines: 0,
      approvedByResolution,
    };
  }

  let estimated = 0;
  let approved = 0;
  let decided = 0;
  let denied = 0;
  let unestimated = 0;
  let anyApproved = false;
  for (const line of lines) {
    if (line.estimatedCents === null) unestimated++;
    else estimated += line.estimatedCents;

    if (line.resolution === "deny") denied++;
    if (isLineDecided(line)) decided++;

    const cents = lineApprovedCents(line);
    if (cents !== null) {
      anyApproved = true;
      approved += cents;
      if (line.resolution && line.resolution !== "deny") approvedByResolution[line.resolution] += cents;
    }
  }

  return {
    fromLines: true,
    lineCount: lines.length,
    // Every line unestimated means nobody has priced the claim yet, which is
    // not the same as a claim for nothing.
    estimatedTotalCents: unestimated === lines.length ? null : estimated,
    approvedTotalCents: anyApproved ? approved : null,
    decidedLines: decided,
    undecidedLines: lines.length - decided,
    deniedLines: denied,
    unestimatedLines: unestimated,
    approvedByResolution,
  };
}

/**
 * What a line looks like after a patch, applying the one rule that ties the
 * fields together: denying a line approves nothing.
 */
export function normalizeLineDecision<T extends TotalsLine>(line: T): T {
  if (line.resolution === "deny" && line.approvedCents !== 0) return { ...line, approvedCents: 0 };
  return line;
}
