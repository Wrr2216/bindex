import type { JobStatus, ShipmentStatus } from "../../db/schema";
import {
  PROGRESS_STAGES,
  SHIPMENT_STATUSES,
  isExceptionStage,
  isProgressStage,
  isStage,
  stageLabel,
  type ProgressStage,
} from "./model";

/**
 * The rules for moving lines, shipments and jobs from one state to the next.
 * Pure functions over plain values, so they are unit-tested without a database
 * and the service layer only has to apply what they decide.
 */

/** Position on the progress ladder, or -1 for an exception stage. */
export function stageRank(stage: string): number {
  return isProgressStage(stage) ? PROGRESS_STAGES.indexOf(stage) : -1;
}

/** True when a line at `stage` has got at least as far as `target`. */
export function hasReached(stage: string, target: ProgressStage): boolean {
  return stageRank(stage) >= stageRank(target);
}

export type StageDecision =
  | { decision: "advance" }
  | { decision: "already" }
  | { decision: "blocked"; reason: string };

/**
 * Whether a line at `from` may move to `to`.
 *
 * - Same stage: already there.
 * - Up the ladder, skipping rungs if need be: advance.
 * - Down the ladder: already there (it got further). A scan at the loading dock
 *   of something already delivered is not an error, just old news.
 * - Into an exception: always allowed. Anyone can flag a line damaged.
 * - Out of an exception, to anything but pending: allowed. The missing box
 *   turned up, the wrong-shipment line was put on the right truck.
 * - Back to pending: only when forced, because it throws away progress.
 *
 * `force` allows any move except to an unknown stage.
 */
export function decideStage(from: string, to: string, force = false): StageDecision {
  if (!isStage(to)) return { decision: "blocked", reason: `Unknown stage "${to}".` };
  if (from === to) return { decision: "already" };
  if (force) return { decision: "advance" };
  if (to === "pending") {
    return { decision: "blocked", reason: "Moving a line back to pending needs force." };
  }
  if (isExceptionStage(to) || isExceptionStage(from) || !isStage(from)) return { decision: "advance" };
  return stageRank(to) > stageRank(from) ? { decision: "advance" } : { decision: "already" };
}

// --- Shipments -------------------------------------------------------------------

export function shipmentRank(status: ShipmentStatus): number {
  return SHIPMENT_STATUSES.indexOf(status);
}

/**
 * The stage every line on a shipment has to have reached before the shipment
 * can take a status. Exception lines never block: they are already accounted
 * for, just not the way anyone hoped.
 */
export function requiredStageFor(status: ShipmentStatus): ProgressStage | null {
  switch (status) {
    case "loaded":
    case "in_transit":
    case "delivered":
      // Nothing may be left behind at the dock. Delivery is when lines get
      // scanned off, so the shipment itself only needs them to have been on it.
      return "loaded";
    case "closed":
      return "delivered";
    default:
      return null;
  }
}

export type ShipmentCheck =
  | { ok: true; forced: boolean; blockers: Record<string, number> }
  | {
      ok: false;
      code: "reason_required" | "lines_not_ready" | "backward" | "same_status";
      message: string;
      blockers: Record<string, number>;
    };

/**
 * Whether a shipment may move from `from` to `to`, given the stages of the
 * lines on it. Forcing needs a reason, and the reason is what gets recorded.
 */
export function checkShipmentTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
  lineStages: string[],
  opts: { force?: boolean; reason?: string | null } = {},
): ShipmentCheck {
  const force = Boolean(opts.force);
  const reason = opts.reason?.trim() ?? "";
  const required = requiredStageFor(to);
  const blockers: Record<string, number> = {};
  if (required) {
    for (const stage of lineStages) {
      if (isExceptionStage(stage) || hasReached(stage, required)) continue;
      blockers[stage] = (blockers[stage] ?? 0) + 1;
    }
  }
  const blocked = Object.values(blockers).reduce((a, b) => a + b, 0);

  if (from === to) {
    return { ok: false, code: "same_status", message: `The shipment is already ${statusLabel(to)}.`, blockers };
  }
  const backward = shipmentRank(to) < shipmentRank(from);
  if ((backward || blocked > 0) && force && !reason) {
    return {
      ok: false,
      code: "reason_required",
      message: "Say why when forcing a shipment status, so the record explains it.",
      blockers,
    };
  }
  if (backward && !force) {
    return {
      ok: false,
      code: "backward",
      message: `The shipment is ${statusLabel(from)}. Moving it back to ${statusLabel(to)} needs force and a reason.`,
      blockers,
    };
  }
  if (blocked > 0 && !force) {
    const parts = Object.entries(blockers).map(([stage, n]) => `${n} ${stageLabel(stage).toLowerCase()}`);
    return {
      ok: false,
      code: "lines_not_ready",
      message:
        `${blocked} line${blocked === 1 ? " is" : "s are"} not ${stageLabel(required!).toLowerCase()} yet ` +
        `(${parts.join(", ")}). Scan ${blocked === 1 ? "it" : "them"}, take ${blocked === 1 ? "it" : "them"} off ` +
        `this shipment, or force the change with a reason.`,
      blockers,
    };
  }
  return { ok: true, forced: force && (backward || blocked > 0), blockers };
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/** Timestamps a shipment status sets the first time it is reached. */
export function shipmentTimestamps(
  to: ShipmentStatus,
  current: { departedAt: Date | null; arrivedAt: Date | null },
  now: Date,
): { departedAt?: Date; arrivedAt?: Date } {
  const out: { departedAt?: Date; arrivedAt?: Date } = {};
  if (shipmentRank(to) >= shipmentRank("in_transit") && !current.departedAt) out.departedAt = now;
  if (shipmentRank(to) >= shipmentRank("delivered") && !current.arrivedAt) out.arrivedAt = now;
  return out;
}

// --- Jobs ---------------------------------------------------------------------

/** Timestamps a job status sets or clears. */
export function jobTimestamps(
  to: JobStatus,
  current: { startedAt: Date | null; completedAt: Date | null },
  now: Date,
): { startedAt?: Date; completedAt?: Date | null } {
  const out: { startedAt?: Date; completedAt?: Date | null } = {};
  if ((to === "in_progress" || to === "completed") && !current.startedAt) out.startedAt = now;
  if (to === "completed" && !current.completedAt) out.completedAt = now;
  if (to === "planned" || to === "in_progress") out.completedAt = null;
  return out;
}
