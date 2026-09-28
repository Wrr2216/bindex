import { registerExceptionStage } from "../jobs-core";

/**
 * Placement's vocabulary. Importing this module registers the "misplaced"
 * exception stage with the jobs core, so every placement module imports it
 * (directly or through match.ts) before it moves a line.
 */

/** A line found in a room that is not its destination. */
export const MISPLACED = "misplaced";

registerExceptionStage(MISPLACED, { label: "Misplaced", color: "#f97316" });

/**
 * How a placement change was made, as written to the stage history. "reader"
 * and "ble" come from the reader worker, "sweep" from a handheld room sweep,
 * "scan" from the where-does-this-go card.
 */
export const VIA = {
  reader: "reader",
  ble: "ble",
  sweep: "sweep",
  scan: "scan",
  manual: "manual",
} as const;

/**
 * Stages a reader may move to "misplaced". Earlier stages are still at the
 * origin, where a reader in a room that happens to be another line's
 * destination (a desk reshuffle on one floor) would otherwise flag everything.
 * A placed line stays placed for readers: a tag read through a wall from the
 * next room is more likely than a desk moving by itself. A person sweeping the
 * room can still flag it.
 */
export const READER_MISPLACEABLE: ReadonlySet<string> = new Set(["loaded", "delivered", "missing", MISPLACED]);

/**
 * Stages nothing automatic moves a line out of. A damaged line keeps its flag
 * until a person decides; placing it hides the damage from the claim list.
 */
export const HELD_STAGES: ReadonlySet<string> = new Set(["damaged"]);
