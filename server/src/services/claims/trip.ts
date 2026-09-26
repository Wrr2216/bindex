/**
 * A claim line's trip, read from its manifest line's stage history, and where
 * each photo falls in it. Pure.
 *
 * "Before" and "after" is what an adjuster asks first: what did it look like
 * when it was packed, and what did it look like when it arrived. A photo says
 * so itself when it was given a stage (pack, before, delivery, after); one that
 * was not is placed by when it was taken against the line's own timestamps.
 */

export type StageStep = { toStage: string; createdAt: Date | string };

export type Trip = {
  packedAt: string | null;
  loadedAt: string | null;
  deliveredAt: string | null;
  placedAt: string | null;
  /** Exception stages the line passed through (damaged, missing, refused...). */
  exceptions: { stage: string; at: string }[];
  currentStage: string | null;
};

/** The progress ladder, as jobs define it. Anything else is an exception. */
const LADDER = ["pending", "packed", "loaded", "delivered", "placed"];

const toIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/**
 * First time the line reached each rung. Scanning straight to loaded implies
 * packed, so a rung skipped counts as reached at the same moment.
 */
export function tripFromHistory(history: readonly StageStep[]): Trip {
  const sorted = [...history].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const reached: (string | null)[] = [null, null, null, null, null];
  const exceptions: Trip["exceptions"] = [];
  for (const step of sorted) {
    const rank = LADDER.indexOf(step.toStage);
    if (rank < 0) {
      exceptions.push({ stage: step.toStage, at: toIso(step.createdAt) });
      continue;
    }
    for (let r = 1; r <= rank; r++) reached[r] ??= toIso(step.createdAt);
  }
  return {
    packedAt: reached[1] ?? null,
    loadedAt: reached[2] ?? null,
    deliveredAt: reached[3] ?? null,
    placedAt: reached[4] ?? null,
    exceptions,
    currentStage: sorted.length ? sorted[sorted.length - 1]!.toStage : null,
  };
}

export type Phase = "before" | "during" | "after" | "unknown";

const BEFORE = new Set(["before", "pack", "packed", "packing", "pre", "pre_move", "origin", "pickup", "label", "survey"]);
const DURING = new Set(["load", "loaded", "loading", "transit", "in_transit", "unload", "unloading"]);
const AFTER = new Set(["after", "delivery", "delivered", "arrival", "unpack", "post", "post_move", "destination", "placed", "damage", "claim"]);

/**
 * Where a photo falls in the trip: its own stage when it has one we know,
 * otherwise when it was taken. Before loading is "before", from loading until
 * delivery is "during", from delivery on is "after". With no trip at all (an
 * item that never travelled on a job) there is nothing to measure against.
 */
export function attachmentPhase(att: { stage: string | null; createdAt: Date | string }, trip: Trip | null): Phase {
  const stage = att.stage?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";
  if (BEFORE.has(stage)) return "before";
  if (DURING.has(stage)) return "during";
  if (AFTER.has(stage)) return "after";
  if (!trip) return "unknown";
  const at = new Date(att.createdAt).getTime();
  const firstException = trip.exceptions[0]?.at ?? null;
  const delivered = trip.deliveredAt ?? firstException;
  if (delivered && at >= new Date(delivered).getTime()) return "after";
  if (trip.loadedAt && at >= new Date(trip.loadedAt).getTime()) return "during";
  if (trip.packedAt || trip.loadedAt || delivered) return "before";
  return "unknown";
}

export type ConditionNote = {
  source: "stage" | "line" | "condition_report" | "photo" | "custody";
  at: string | null;
  /** The stage or phase it was written at, when known. */
  stage: string | null;
  text: string;
  by: string | null;
  /** The record it came from: a history row, report, attachment or transfer. */
  ref: string | null;
};

/** Oldest first; undated notes (a line's own note) first of all. */
export function sortNotes(notes: ConditionNote[]): ConditionNote[] {
  const time = (n: ConditionNote) => (n.at ? new Date(n.at).getTime() : Number.MIN_SAFE_INTEGER);
  return [...notes].sort((a, b) => time(a) - time(b));
}
