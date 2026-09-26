import { decideStage } from "./rules";

/**
 * Deciding what a batch of scans does to a job's manifest, without touching
 * the database. The service resolves codes to items and loads the candidate
 * lines; this works out, code by code, which line each scan is about and what
 * should happen to it.
 */

/** What a scanned code resolved to. A unit code or serial names the unit. */
export type ScanRef = { itemId: string; unitId: string | null };

/** The parts of a manifest line matching needs. */
export type MatchLine = {
  id: string;
  itemId: string;
  unitId: string | null;
  stage: string;
  shipmentId: string | null;
};

export type PlannedLine = { code: string; line: MatchLine };

export type ScanPlan = {
  /** Lines to move to the target stage. `assignShipment` is set when the line joins the scanned shipment. */
  advance: (PlannedLine & { assignShipment: string | null })[];
  /** Already at the target, or past it. */
  already: PlannedLine[];
  /** On this job, but on a different shipment from the one being worked. */
  wrongShipment: PlannedLine[];
  /** Resolved to an item, but nothing on this job matches it. */
  notOnJob: { code: string; refs: ScanRef[] }[];
  /** Resolved to nothing at all. */
  unknown: string[];
  /** A rule refused the move (for example, back to pending without force). */
  blocked: (PlannedLine & { reason: string })[];
};

export type PlanOptions = {
  /** The shipment being loaded or unloaded. Lines without one join it. */
  shipmentId?: string | null;
  /** Allow any move, including onto this shipment from another. */
  force?: boolean;
};

/** Trimmed, de-duplicated, in first-seen order. Readers repeat themselves. */
export function uniqueCodes(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of codes) {
    const code = raw.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * The lines a reference could mean, best first. A unit reference prefers that
 * unit's own line and falls back to a whole-item line. An item reference
 * prefers the whole-item line, then any unit line of that item, which lets a
 * label on the item stand in for its units one scan at a time.
 */
export function candidatesFor(ref: ScanRef, lines: readonly MatchLine[]): MatchLine[] {
  const ofItem = lines.filter((l) => l.itemId === ref.itemId);
  if (ref.unitId) {
    const exact = ofItem.filter((l) => l.unitId === ref.unitId);
    return exact.length ? exact : ofItem.filter((l) => l.unitId === null);
  }
  return [...ofItem.filter((l) => l.unitId === null), ...ofItem.filter((l) => l.unitId !== null)];
}

export function planAdvance(
  codes: readonly string[],
  resolved: ReadonlyMap<string, readonly ScanRef[]>,
  lines: readonly MatchLine[],
  target: string,
  opts: PlanOptions = {},
): ScanPlan {
  const plan: ScanPlan = { advance: [], already: [], wrongShipment: [], notOnJob: [], unknown: [], blocked: [] };
  const shipmentId = opts.shipmentId ?? null;
  const force = Boolean(opts.force);
  // A line is claimed by the first code in the batch that reaches it, so an
  // RFID read and a barcode scan of the same box count once.
  const claimed = new Set<string>();

  for (const code of uniqueCodes(codes)) {
    const refs = resolved.get(code) ?? [];
    if (refs.length === 0) {
      plan.unknown.push(code);
      continue;
    }

    const seen = new Set<string>();
    const candidates: MatchLine[] = [];
    for (const ref of refs) {
      for (const line of candidatesFor(ref, lines)) {
        if (seen.has(line.id)) continue;
        seen.add(line.id);
        candidates.push(line);
      }
    }
    if (candidates.length === 0) {
      plan.notOnJob.push({ code, refs: [...refs] });
      continue;
    }

    const open = candidates.filter((l) => !claimed.has(l.id));
    if (open.length === 0) {
      plan.already.push({ code, line: candidates[0]! });
      continue;
    }

    const fits = (l: MatchLine) => !shipmentId || l.shipmentId === null || l.shipmentId === shipmentId;
    const onShipment = open.filter(fits);
    const elsewhere = open.filter((l) => !fits(l));

    const pick = (pool: MatchLine[]) => {
      for (const line of pool) {
        const d = decideStage(line.stage, target, force);
        if (d.decision === "advance") return { line, d };
      }
      return null;
    };

    const movable = pick(onShipment) ?? (force ? pick(elsewhere) : null);
    if (movable) {
      claimed.add(movable.line.id);
      plan.advance.push({
        code,
        line: movable.line,
        assignShipment: shipmentId && movable.line.shipmentId !== shipmentId ? shipmentId : null,
      });
      continue;
    }

    if (onShipment.length > 0) {
      const line = onShipment[0]!;
      claimed.add(line.id);
      const d = decideStage(line.stage, target, force);
      if (d.decision === "blocked") plan.blocked.push({ code, line, reason: d.reason });
      else plan.already.push({ code, line });
      continue;
    }

    const line = elsewhere[0]!;
    claimed.add(line.id);
    plan.wrongShipment.push({ code, line });
  }
  return plan;
}
