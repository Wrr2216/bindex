import type { Job, JobTask, Shipment, ShipmentStatus } from "../../db/schema";
import { logger } from "../../lib/logger";
import { describeError } from "../../lib/errors";
import type { StageVia } from "./model";

/**
 * Extension points for features built on jobs. A feature registers at module
 * load (from its own router or service file) and never edits this module:
 *
 *   registerStageGuard("custody", async (ctx) => [...vetoes])
 *   onStageChanged((changes, ctx) => publish("job.stage_changed", ...))
 *
 * Guards run before a stage change is written and may veto individual lines;
 * a vetoed line is reported back as blocked with the guard's reason. A guard
 * that throws aborts the whole batch, because a guard is how a feature enforces
 * a rule (custody, credentials) and failing open would defeat it.
 *
 * Listeners run after the change is committed. They cannot undo it, and an
 * error in one is logged and does not reach the person scanning.
 */

/** Who made a change and how. Shared by every hook. */
export type ChangeContext = {
  via: StageVia;
  deviceId: string | null;
  userOid: string | null;
  /** Display name: a person, or an external party with no account. */
  actor: string | null;
  note: string | null;
  at: Date;
};

export type GuardLine = {
  jobItemId: string;
  itemId: string;
  unitId: string | null;
  shipmentId: string | null;
  from: string;
};

export type StageGuardContext = ChangeContext & {
  jobId: string;
  stage: string;
  force: boolean;
  lines: GuardLine[];
};

export type StageVeto = { jobItemId: string; reason: string };
export type StageGuard = (ctx: StageGuardContext) => StageVeto[] | Promise<StageVeto[]>;

export type StageChange = {
  jobId: string;
  jobItemId: string;
  itemId: string;
  unitId: string | null;
  shipmentId: string | null;
  from: string;
  to: string;
};
export type StageListener = (changes: StageChange[], ctx: ChangeContext & { jobId: string }) => unknown;

export type ShipmentStatusEvent = {
  shipment: Shipment;
  from: ShipmentStatus;
  to: ShipmentStatus;
  forced: boolean;
  reason: string | null;
  userOid: string | null;
  actor: string | null;
};
export type ShipmentStatusListener = (event: ShipmentStatusEvent) => unknown;

/** A job was created (`previous` null) or changed. */
export type JobEvent = { job: Job; previous: Job | null; userOid: string | null };
export type JobListener = (event: JobEvent) => unknown;

/** A task changed status, by hand or because the lines it follows moved. */
export type TaskEvent = { task: JobTask; previousStatus: JobTask["status"]; userOid: string | null };
export type TaskListener = (event: TaskEvent) => unknown;

const guards = new Map<string, StageGuard>();
const stageListeners = new Set<StageListener>();
const shipmentListeners = new Set<ShipmentStatusListener>();
const jobListeners = new Set<JobListener>();
const taskListeners = new Set<TaskListener>();

/** Register (or replace) a named guard. Returns a function that removes it. */
export function registerStageGuard(name: string, guard: StageGuard): () => void {
  guards.set(name, guard);
  return () => {
    if (guards.get(name) === guard) guards.delete(name);
  };
}

const subscribe = <T>(set: Set<T>, fn: T) => {
  set.add(fn);
  return () => {
    set.delete(fn);
  };
};

export const onStageChanged = (fn: StageListener) => subscribe(stageListeners, fn);
export const onShipmentStatusChanged = (fn: ShipmentStatusListener) => subscribe(shipmentListeners, fn);
export const onJobChanged = (fn: JobListener) => subscribe(jobListeners, fn);
export const onTaskStatusChanged = (fn: TaskListener) => subscribe(taskListeners, fn);

/** Ask every guard about a batch. Vetoes are merged; the first reason per line wins. */
export async function runStageGuards(ctx: StageGuardContext): Promise<Map<string, string>> {
  const vetoes = new Map<string, string>();
  if (ctx.lines.length === 0) return vetoes;
  for (const [name, guard] of guards) {
    const result = await guard(ctx);
    for (const v of result) {
      if (!vetoes.has(v.jobItemId)) vetoes.set(v.jobItemId, v.reason);
    }
    if (result.length) logger.info("jobs.stage.vetoed", { guard: name, jobId: ctx.jobId, lines: result.length });
  }
  return vetoes;
}

async function notify<A extends unknown[]>(
  event: string,
  listeners: Set<(...args: A) => unknown>,
  ...args: A
): Promise<void> {
  for (const fn of listeners) {
    try {
      await fn(...args);
    } catch (err) {
      logger.warn("jobs.hook.failed", { event, err: describeError(err) });
    }
  }
}

export const emitStageChanged = (changes: StageChange[], ctx: ChangeContext & { jobId: string }) =>
  changes.length ? notify("stage", stageListeners, changes, ctx) : Promise.resolve();
export const emitShipmentStatus = (event: ShipmentStatusEvent) => notify("shipment", shipmentListeners, event);
export const emitJobChanged = (event: JobEvent) => notify("job", jobListeners, event);
export const emitTaskStatus = (event: TaskEvent) => notify("task", taskListeners, event);
