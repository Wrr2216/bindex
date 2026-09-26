import { PROGRESS_STAGES, isExceptionStage, type ProgressStage } from "./model";
import { hasReached, stageRank } from "./rules";

/**
 * Progress rollups: how far a set of manifest lines has got. Pure, so the same
 * numbers come out for a job, a shipment, a floor or a department, and tests
 * can pin them down.
 */

export type RollupLine = {
  stage: string;
  shipmentId?: string | null;
  floor?: string | null;
  department?: string | null;
};

type Step = Exclude<ProgressStage, "pending">;
const STEPS: Step[] = ["packed", "loaded", "delivered", "placed"];

export type Progress = {
  total: number;
  /** Lines currently at each stage, exceptions included. */
  byStage: Record<string, number>;
  /** Lines that have reached each step or gone past it. */
  reached: Record<Step, number>;
  /** Whole percentages of `reached` over `total`. */
  percent: Record<Step, number>;
  /** Lines in an exception stage (missing, damaged, ...). */
  exceptions: number;
  /**
   * One number for one progress bar: each line scores its rung on the ladder
   * (placed is 100, pending 0, an exception 0), averaged. 100 only when every
   * line is placed.
   */
  overall: number;
  /** Every line placed, and there is at least one. */
  complete: boolean;
};

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.floor((n / d) * 100));

export function rollup(lines: readonly RollupLine[]): Progress {
  const counts: Record<string, number> = {};
  for (const { stage } of lines) counts[stage] = (counts[stage] ?? 0) + 1;
  return rollupCounts(counts);
}

/** The same rollup from stage counts, as a GROUP BY stage query returns them. */
export function rollupCounts(counts: Readonly<Record<string, number>>): Progress {
  const byStage: Record<string, number> = {};
  const reached = { packed: 0, loaded: 0, delivered: 0, placed: 0 } as Record<Step, number>;
  let exceptions = 0;
  let score = 0;
  let total = 0;
  const top = PROGRESS_STAGES.length - 1;

  for (const [stage, n] of Object.entries(counts)) {
    if (!n) continue;
    byStage[stage] = n;
    total += n;
    if (isExceptionStage(stage)) {
      exceptions += n;
      continue;
    }
    for (const step of STEPS) if (hasReached(stage, step)) reached[step] += n;
    score += Math.max(0, stageRank(stage)) * n;
  }

  return {
    total,
    byStage,
    reached,
    percent: {
      packed: pct(reached.packed, total),
      loaded: pct(reached.loaded, total),
      delivered: pct(reached.delivered, total),
      placed: pct(reached.placed, total),
    },
    exceptions,
    overall: total === 0 ? 0 : Math.floor((score / (top * total)) * 100),
    complete: total > 0 && reached.placed === total,
  };
}

export type GroupProgress = { key: string | null; progress: Progress };

/**
 * Roll up per group. Lines with no value for the key form their own group
 * (key null), listed last, so nothing silently drops out of the totals.
 */
export function rollupBy(
  lines: readonly RollupLine[],
  keyOf: (line: RollupLine) => string | null | undefined,
): GroupProgress[] {
  const groups = new Map<string | null, RollupLine[]>();
  for (const line of lines) {
    const raw = keyOf(line);
    const key = raw == null || raw === "" ? null : raw;
    const list = groups.get(key);
    if (list) list.push(line);
    else groups.set(key, [line]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    })
    .map(([key, list]) => ({ key, progress: rollup(list) }));
}

export type JobProgress = {
  overall: Progress;
  byShipment: GroupProgress[];
  byFloor: GroupProgress[];
  byDepartment: GroupProgress[];
};

export function jobProgress(lines: readonly RollupLine[]): JobProgress {
  return {
    overall: rollup(lines),
    byShipment: rollupBy(lines, (l) => l.shipmentId),
    byFloor: rollupBy(lines, (l) => l.floor),
    byDepartment: rollupBy(lines, (l) => l.department),
  };
}
