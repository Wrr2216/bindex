import { haversineM } from "./geo";

/**
 * Which fixes to believe. GPS receivers occasionally report a point kilometres
 * away (a cold start, a multipath bounce in a city, a cell-tower fallback), and
 * uplinks deliver batches late or out of order. A bad point must not move an
 * asset or fire a fence, but it is still kept as history, flagged.
 *
 * Pure: the caller keeps the state between batches.
 */

export type FixPoint = { lat: number; lng: number; at: number; accuracyM: number | null };

export type FilterState = {
  /** The last fix accepted. */
  last: FixPoint | null;
  /** Rejected fixes in a row that agree with each other. */
  rejectStreak: number;
  lastRejected: FixPoint | null;
};

export const EMPTY_FILTER: FilterState = { last: null, rejectStreak: 0, lastRejected: null };

/**
 * Rejected fixes in a row, each consistent with the one before, after which the
 * tracker is believed to really be there. Without this, one bad fix accepted as
 * the very first would make every true fix after it look like a jump.
 */
export const REANCHOR_AFTER = 3;

/** Accuracy counted in a jump's favour at most this far, so a vague fix cannot excuse anything. */
const MAX_ACCURACY_CREDIT_M = 100;

export type Verdict =
  | { verdict: "accept"; reanchored: boolean; impliedSpeedMps: number | null }
  | { verdict: "out_of_order" }
  | { verdict: "jump"; impliedSpeedMps: number };

/**
 * Speed needed to get from a to b, allowing for both fixes' stated accuracy.
 * Time differences under a second count as a second.
 */
export function impliedSpeedMps(a: FixPoint, b: FixPoint): number {
  const credit =
    Math.min(a.accuracyM ?? 0, MAX_ACCURACY_CREDIT_M) + Math.min(b.accuracyM ?? 0, MAX_ACCURACY_CREDIT_M);
  const d = Math.max(0, haversineM(a, b) - credit);
  const dt = Math.max(1, Math.abs(b.at - a.at) / 1000);
  return d / dt;
}

/**
 * Judge one fix against what came before.
 *
 * - Not newer than the last accepted fix: out of order. Kept as history; it
 *   cannot move anything or fire a fence after the fact.
 * - Needs more than `maxSpeedMps` to reach from the last accepted fix: a jump.
 *   After REANCHOR_AFTER such fixes that agree with each other, the latest is
 *   accepted and becomes the new reference.
 * - Otherwise accepted.
 */
export function screenFix(
  state: FilterState,
  fix: FixPoint,
  maxSpeedMps: number,
): { result: Verdict; state: FilterState } {
  const last = state.last;
  if (last && fix.at <= last.at) return { result: { verdict: "out_of_order" }, state };
  if (!last) {
    return {
      result: { verdict: "accept", reanchored: false, impliedSpeedMps: null },
      state: { last: fix, rejectStreak: 0, lastRejected: null },
    };
  }
  const speed = impliedSpeedMps(last, fix);
  if (speed <= maxSpeedMps) {
    return {
      result: { verdict: "accept", reanchored: false, impliedSpeedMps: speed },
      state: { last: fix, rejectStreak: 0, lastRejected: null },
    };
  }
  const prev = state.lastRejected;
  const agrees = prev !== null && fix.at > prev.at && impliedSpeedMps(prev, fix) <= maxSpeedMps;
  const streak = agrees ? state.rejectStreak + 1 : 1;
  if (streak >= REANCHOR_AFTER) {
    return {
      result: { verdict: "accept", reanchored: true, impliedSpeedMps: speed },
      state: { last: fix, rejectStreak: 0, lastRejected: null },
    };
  }
  return {
    result: { verdict: "jump", impliedSpeedMps: speed },
    state: { last, rejectStreak: streak, lastRejected: fix },
  };
}
