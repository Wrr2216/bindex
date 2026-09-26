import { candidatesFor, uniqueCodes, type ScanRef } from "../jobs-core";
import { HELD_STAGES, MISPLACED, READER_MISPLACEABLE } from "./model";
import { relation, within, type Tree } from "./tree";

/**
 * Deciding what a read or a scan means for placement, without touching the
 * database. Three callers, three rules, one notion of "belongs here":
 *
 * - the reader worker: a fixed reader (or BLE room presence) saw a tag in its
 *   zone, so the line is placed, misplaced, or nothing yet;
 * - a handheld sweep: a person picked the room and swept it;
 * - the where-does-this-go card: a crew member scanned one label.
 *
 * A line belongs in a place when the place is its destination or lies within
 * it (a reader covering one wall of the destination room). A destination
 * inside the place (a room on the floor a reader covers) is only "nearby":
 * the reader cannot say which room it went to. With `nested`, destinations
 * inside the place count too, for a plan that names desks and a reader or a
 * sweep that covers the room.
 */

/** The parts of a manifest line placement matching needs. */
export type PlacementLine = {
  id: string;
  jobId: string;
  itemId: string;
  unitId: string | null;
  stage: string;
  shipmentId: string | null;
  destinationLocationId: string | null;
  /** The room it was last found in out of place, when it was. */
  lastActualId: string | null;
};

export function belongsIn(place: string, line: Pick<PlacementLine, "destinationLocationId">, tree: Tree, nested = false): boolean {
  if (!line.destinationLocationId) return false;
  const rel = relation(place, line.destinationLocationId, tree);
  return rel === "same" || rel === "inside" || (nested && rel === "contains");
}

// --- Readers ------------------------------------------------------------------------

export type ReaderRead = {
  deviceId: string | null;
  itemId: string;
  unitId: string | null;
  /** The zone the tracking core put the read in. */
  zoneId: string;
  observedAt: number;
  /** The device counts places inside its zone as its zone. */
  nested?: boolean;
};

export type ReaderDecision<R extends ReaderRead = ReaderRead> = {
  line: PlacementLine;
  read: R;
  outcome: "placed" | "misplaced";
};

/**
 * What a batch of reads from room readers does to the lines they name.
 *
 * - A read in the line's destination places it (from any stage but placed or
 *   damaged: a pending line already sitting in its room is placed).
 * - A read somewhere else marks it misplaced, but only in a room this job is
 *   delivering to (a reader at the dock or in a corridor is not a verdict) and
 *   only once the line has left the origin (see READER_MISPLACEABLE).
 * - A tag on the item matches the item's own line; a tag on a unit matches
 *   the unit's line, or the item's when the job moves the item whole. An item
 *   tag never stands in for one of several unit lines: a reader cannot say
 *   which unit it saw.
 *
 * Per line, a placing read wins over any number of misplacing ones in the
 * batch, and of several misplacing reads the latest decides the room. A line
 * already misplaced in the room it was read in again changes nothing.
 *
 * `areasByJob` lists each job's destinations; a zone within one of them is a
 * room the job delivers to.
 */
export function planReaderReads<R extends ReaderRead>(
  reads: readonly R[],
  lines: readonly PlacementLine[],
  tree: Tree,
  areasByJob: ReadonlyMap<string, readonly string[]>,
): ReaderDecision<R>[] {
  const byItem = new Map<string, PlacementLine[]>();
  for (const l of lines) {
    const list = byItem.get(l.itemId);
    if (list) list.push(l);
    else byItem.set(l.itemId, [l]);
  }
  const inArea = new Map<string, boolean>();
  const deliveredTo = (jobId: string, zone: string) => {
    const key = `${jobId}|${zone}`;
    let hit = inArea.get(key);
    if (hit === undefined) {
      hit = (areasByJob.get(jobId) ?? []).some((a) => within(zone, a, tree));
      inArea.set(key, hit);
    }
    return hit;
  };

  const decided = new Map<string, ReaderDecision<R>>();
  const ordered = [...reads].sort((a, b) => a.observedAt - b.observedAt);
  for (const read of ordered) {
    const candidates = (byItem.get(read.itemId) ?? []).filter((l) =>
      read.unitId ? l.unitId === read.unitId || l.unitId === null : l.unitId === null,
    );
    for (const line of candidates) {
      if (!line.destinationLocationId || line.stage === "placed" || HELD_STAGES.has(line.stage)) continue;
      const prior = decided.get(line.id);
      if (prior?.outcome === "placed") continue;
      if (belongsIn(read.zoneId, line, tree, Boolean(read.nested))) {
        decided.set(line.id, { line, read, outcome: "placed" });
        continue;
      }
      if (relation(read.zoneId, line.destinationLocationId, tree) === "contains") continue;
      if (!READER_MISPLACEABLE.has(line.stage) || !deliveredTo(line.jobId, read.zoneId)) continue;
      decided.set(line.id, { line, read, outcome: "misplaced" });
    }
  }
  return [...decided.values()].filter(
    (d) => !(d.outcome === "misplaced" && d.line.stage === MISPLACED && d.line.lastActualId === d.read.zoneId),
  );
}

// --- Sweeps --------------------------------------------------------------------------

export type SweepOutcome =
  /** Belongs here; moving it to placed. */
  | "placed"
  /** Belongs here and was already placed (or read twice in this batch). */
  | "already"
  /** Belongs somewhere else; flagging it misplaced, found here. */
  | "misplaced"
  /** Its destination is inside this place; the sweep cannot confirm which room. */
  | "nearby"
  /** On this job, but the plan gives it no destination. */
  | "no_destination"
  /** Damaged: left for a person to decide. */
  | "held"
  /** A known item this job does not move. */
  | "not_on_job"
  /** Resolves to nothing. */
  | "unknown";

export type SweepEntry = { code: string; outcome: SweepOutcome; line: PlacementLine | null; refs: ScanRef[] };

/**
 * What each code in a room sweep means. The room is authoritative, because a
 * person chose it and is standing in it: anything found here that belongs
 * elsewhere is misplaced whatever its stage, even if it was placed before.
 *
 * Codes resolve the way scanning to a stage does (an item label can stand in
 * for its units one scan at a time), and a line is claimed by the first code
 * in the batch that reaches it.
 */
export function planSweep(
  roomId: string,
  codes: readonly string[],
  resolved: ReadonlyMap<string, readonly ScanRef[]>,
  lines: readonly PlacementLine[],
  tree: Tree,
  opts: { nested?: boolean } = {},
): SweepEntry[] {
  const nested = Boolean(opts.nested);
  const claimed = new Set<string>();
  const out: SweepEntry[] = [];
  const priority = (l: PlacementLine) => {
    const here = belongsIn(roomId, l, tree, nested);
    const open = l.stage !== "placed" && !HELD_STAGES.has(l.stage);
    if (here && open) return 0;
    if (here) return 1;
    return l.stage !== "placed" ? 2 : 3;
  };

  for (const code of uniqueCodes(codes)) {
    const refs = [...(resolved.get(code) ?? [])];
    if (!refs.length) {
      out.push({ code, outcome: "unknown", line: null, refs });
      continue;
    }
    const seen = new Set<string>();
    const candidates: PlacementLine[] = [];
    for (const ref of refs) {
      for (const l of candidatesFor(ref, lines)) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        candidates.push(l as PlacementLine);
      }
    }
    if (!candidates.length) {
      out.push({ code, outcome: "not_on_job", line: null, refs });
      continue;
    }
    const open = candidates.filter((l) => !claimed.has(l.id));
    if (!open.length) {
      out.push({ code, outcome: "already", line: candidates[0]!, refs });
      continue;
    }
    // Stable sort: equal priorities keep candidatesFor's order.
    const line = open.map((l, i) => ({ l, i, p: priority(l) })).sort((a, b) => a.p - b.p || a.i - b.i)[0]!.l;
    claimed.add(line.id);

    let outcome: SweepOutcome;
    if (!line.destinationLocationId) outcome = "no_destination";
    else if (belongsIn(roomId, line, tree, nested)) {
      outcome = line.stage === "placed" ? "already" : HELD_STAGES.has(line.stage) ? "held" : "placed";
    } else if (relation(roomId, line.destinationLocationId, tree) === "contains") outcome = "nearby";
    else outcome = HELD_STAGES.has(line.stage) ? "held" : "misplaced";
    out.push({ code, outcome, line, refs });
  }
  return out;
}

// --- The where-does-this-go card ----------------------------------------------------------

export type CardOutcome =
  /** On this job and this shipment (or no shipment is being checked): take it to its destination. */
  | "ok"
  /** On this job, with no destination on the plan. */
  | "no_destination"
  /** Already placed. */
  | "already_placed"
  /** On this job, but planned for another shipment than the one being unloaded. */
  | "wrong_shipment"
  /** A known item this job does not move. */
  | "not_on_job"
  | "unknown";

/**
 * Which line one scanned label means, and what the card should say. A line
 * not yet placed wins over a placed one, and among those, one that fits the
 * shipment being unloaded (on it, or on none) wins over one on another truck.
 */
export function decideCard(
  refs: readonly ScanRef[],
  lines: readonly PlacementLine[],
  shipmentId: string | null,
): { outcome: CardOutcome; line: PlacementLine | null } {
  if (!refs.length) return { outcome: "unknown", line: null };
  const seen = new Set<string>();
  const candidates: PlacementLine[] = [];
  for (const ref of refs) {
    for (const l of candidatesFor(ref, lines)) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      candidates.push(l as PlacementLine);
    }
  }
  if (!candidates.length) return { outcome: "not_on_job", line: null };
  const fits = (l: PlacementLine) => !shipmentId || l.shipmentId === null || l.shipmentId === shipmentId;
  const open = candidates.filter((l) => l.stage !== "placed");
  const good = open.find(fits);
  if (good) return { outcome: good.destinationLocationId ? "ok" : "no_destination", line: good };
  if (open.length) return { outcome: "wrong_shipment", line: open[0]! };
  return { outcome: "already_placed", line: candidates[0]! };
}
