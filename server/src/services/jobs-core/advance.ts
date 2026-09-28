import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../../db/client";
import {
  itemEvents,
  itemUnits,
  items,
  jobItemStageHistory,
  jobItems,
  jobs,
  shipments,
  type Job,
} from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import {
  emitJobChanged,
  emitStageChanged,
  emitTaskStatus,
  runStageGuards,
  type ChangeContext,
  type StageChange,
  type TaskEvent,
} from "./hooks";
import { syncStageTasks } from "./jobs";
import { selectLines, type ManifestLine } from "./manifest";
import { planAdvance, uniqueCodes, type MatchLine, type ScanPlan, type ScanRef } from "./match";
import { OPEN_JOB_STATUSES, VIA_PATTERN, isProgressStage, isStage, type StageVia } from "./model";
import { resolveScanCodes } from "./resolve";
import { decideStage } from "./rules";
import { assertJobOpen, loadShipmentOnJob, type Executor } from "./shared";

/**
 * Moving manifest lines up the stage ladder. `advanceStage` takes scanned codes
 * (what a reader or a camera produces); `setLineStage` takes line ids (what a
 * person ticking rows in the manifest table produces). Both go through the same
 * plan, guards, write and hooks, so a stage change looks the same in the
 * history however it was made.
 */

/** The largest batch one call accepts; a dock-door reader sends far fewer per post. */
export const MAX_BATCH = 5000;

export type AdvanceOptions = {
  /** The shipment being worked. Lines not yet on one join it. */
  shipmentId?: string | null;
  via: StageVia;
  /** The reader or device that made the read, when there is one. */
  deviceId?: string | null;
  userOid?: string | null;
  /** Display name for the history (a person, or an external party). */
  actor?: string | null;
  /** Allow moving back down the ladder, and off another shipment onto this one. */
  force?: boolean;
  note?: string | null;
};

/** A manifest line in a result, with what the scanning screen needs to show. */
export type LineOutcome = {
  /** The code that matched it, or null for a change made by line id. */
  code: string | null;
  jobItemId: string;
  itemId: string;
  unitId: string | null;
  itemName: string;
  assetCode: string;
  unitCode: string | null;
  /** Stage before this call. */
  from: string;
  /** Stage after this call. */
  stage: string;
  shipmentId: string | null;
  shipmentCode: string | null;
  destinationLocationId: string | null;
  destinationName: string | null;
  destinationLabel: string | null;
  floor: string | null;
  department: string | null;
  crateNo: string | null;
};

export type NotOnJobOutcome = {
  code: string;
  itemId: string;
  unitId: string | null;
  itemName: string;
  assetCode: string;
  /** Open jobs this item is on instead, so a crew can say where it belongs. */
  otherJobs: { id: string; code: string; name: string }[];
};

export type AdvanceResult = {
  jobId: string;
  stage: string;
  shipmentId: string | null;
  advanced: LineOutcome[];
  alreadyAt: LineOutcome[];
  /** On this job but another shipment; `shipmentCode` names the one it is on. */
  wrongShipment: LineOutcome[];
  notOnJob: NotOnJobOutcome[];
  unknown: string[];
  blocked: (LineOutcome & { reason: string })[];
};

function validate(stage: string, opts: AdvanceOptions): void {
  if (!isStage(stage)) throw badRequest(`Unknown stage "${stage}".`);
  if (!VIA_PATTERN.test(opts.via)) throw badRequest(`"${opts.via}" is not a valid way of recording a change.`);
}

function outcome(line: ManifestLine, code: string | null, from: string): LineOutcome {
  return {
    code,
    jobItemId: line.id,
    itemId: line.itemId,
    unitId: line.unitId,
    itemName: line.itemName,
    assetCode: line.assetCode,
    unitCode: line.unitCode,
    from,
    stage: line.stage,
    shipmentId: line.shipmentId,
    shipmentCode: line.shipmentCode,
    destinationLocationId: line.destinationLocationId,
    destinationName: line.destinationName,
    destinationLabel: line.destinationLabel,
    floor: line.floor,
    department: line.department,
    crateNo: line.crateNo,
  };
}

async function lockJob(ex: Executor, jobId: string): Promise<Job> {
  // Serialises stage changes per job, so two scanners on the same job cannot
  // both advance a line from the same starting stage.
  const [job] = await ex.select().from(jobs).where(eq(jobs.id, jobId)).for("update").limit(1);
  if (!job) throw notFound("Job not found");
  assertJobOpen(job);
  return job;
}

type Applied = {
  plan: ScanPlan;
  from: Map<string, string>;
  vetoes: Map<string, string>;
  changes: StageChange[];
  taskEvents: TaskEvent[];
  job: Job;
  startedJob: Job | null;
  ctx: ChangeContext;
};

/**
 * Plan, guard and write one batch inside a transaction. `buildPlan` sees the
 * locked job's candidate lines.
 */
async function apply(
  jobId: string,
  stage: string,
  opts: AdvanceOptions,
  loadCandidates: (ex: Executor) => Promise<MatchLine[]>,
  buildPlan: (lines: MatchLine[]) => ScanPlan,
): Promise<Applied> {
  const at = new Date();
  const actor = opts.actor?.trim() || opts.userOid || null;
  const ctx: ChangeContext = {
    via: opts.via,
    deviceId: opts.deviceId ?? null,
    userOid: opts.userOid ?? null,
    actor,
    note: opts.note?.trim() || null,
    at,
  };

  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (opts.shipmentId) {
      const shipment = await loadShipmentOnJob(jobId, opts.shipmentId, tx);
      if (shipment.status === "closed") {
        throw badRequest(`${shipment.code} is closed. Reopen it, or pick another shipment.`);
      }
    }
    const plan = buildPlan(await loadCandidates(tx));
    const from = new Map(plan.advance.map((p) => [p.line.id, p.line.stage]));

    const vetoes = await runStageGuards({
      ...ctx,
      jobId,
      stage,
      force: Boolean(opts.force),
      lines: plan.advance.map((p) => ({
        jobItemId: p.line.id,
        itemId: p.line.itemId,
        unitId: p.line.unitId,
        shipmentId: p.assignShipment ?? p.line.shipmentId,
        from: p.line.stage,
      })),
    });
    if (vetoes.size) {
      for (const p of plan.advance) {
        const reason = vetoes.get(p.line.id);
        if (reason) plan.blocked.push({ code: p.code, line: p.line, reason });
      }
      plan.advance = plan.advance.filter((p) => !vetoes.has(p.line.id));
    }

    const moving = plan.advance;
    const changes: StageChange[] = moving.map((p) => ({
      jobId,
      jobItemId: p.line.id,
      itemId: p.line.itemId,
      unitId: p.line.unitId,
      shipmentId: p.assignShipment ?? p.line.shipmentId,
      from: p.line.stage,
      to: stage,
    }));
    let taskEvents: TaskEvent[] = [];
    let startedJob: Job | null = null;

    if (moving.length) {
      const joining = moving.filter((p) => p.assignShipment).map((p) => p.line.id);
      const staying = moving.filter((p) => !p.assignShipment).map((p) => p.line.id);
      const set = { stage, stageAt: at, stageBy: actor, updatedAt: at };
      for (let i = 0; i < joining.length; i += 1000) {
        await tx
          .update(jobItems)
          .set({ ...set, shipmentId: opts.shipmentId! })
          .where(inArray(jobItems.id, joining.slice(i, i + 1000)));
      }
      for (let i = 0; i < staying.length; i += 1000) {
        await tx.update(jobItems).set(set).where(inArray(jobItems.id, staying.slice(i, i + 1000)));
      }

      for (let i = 0; i < changes.length; i += 500) {
        const part = changes.slice(i, i + 500);
        await tx.insert(jobItemStageHistory).values(
          part.map((c) => ({
            jobItemId: c.jobItemId,
            jobId,
            itemId: c.itemId,
            unitId: c.unitId,
            shipmentId: c.shipmentId,
            fromStage: c.from,
            toStage: stage,
            via: ctx.via,
            deviceId: ctx.deviceId,
            userOid: ctx.userOid,
            actor,
            note: ctx.note,
            createdAt: at,
          })),
        );
        // One item event per line per change, so an item's own history shows
        // its trip. "updated" because item_events.action is a fixed set; the
        // detail says what happened.
        await tx.insert(itemEvents).values(
          part.map((c) => ({
            itemId: c.itemId,
            userOid: ctx.userOid,
            action: "updated" as const,
            detail: {
              source: "job",
              jobId,
              jobCode: job.code,
              stage,
              from: c.from,
              jobItemId: c.jobItemId,
              unitId: c.unitId,
              shipmentId: c.shipmentId,
              via: ctx.via,
            },
            createdAt: at,
          })),
        );
      }

      // The first real movement starts a planned job.
      if (job.status === "planned") {
        const [row] = await tx
          .update(jobs)
          .set({ status: "in_progress", startedAt: job.startedAt ?? at, updatedAt: at })
          .where(eq(jobs.id, jobId))
          .returning();
        startedJob = row!;
      }
      if (isProgressStage(stage)) taskEvents = await syncStageTasks(tx, jobId, stage, actor);
    }
    return { plan, from, vetoes, changes, taskEvents, job, startedJob, ctx };
  });
}

async function describe(jobId: string, stage: string, opts: AdvanceOptions, applied: Applied): Promise<AdvanceResult> {
  const { plan, from } = applied;
  const lineIds = [
    ...plan.advance.map((p) => p.line.id),
    ...plan.already.map((p) => p.line.id),
    ...plan.wrongShipment.map((p) => p.line.id),
    ...plan.blocked.map((p) => p.line.id),
  ];
  const lines = lineIds.length ? await selectLines(inArray(jobItems.id, [...new Set(lineIds)])) : [];
  const byId = new Map(lines.map((l) => [l.id, l]));
  const show = (p: { code: string; line: MatchLine }, prior?: string) => {
    const line = byId.get(p.line.id);
    return line ? outcome(line, p.code || null, prior ?? p.line.stage) : null;
  };
  const present = <T>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null);

  const notOnJobRefs = plan.notOnJob.map((n) => ({ code: n.code, ref: n.refs[0]! }));
  const notOnJob: NotOnJobOutcome[] = [];
  if (notOnJobRefs.length) {
    const itemIds = [...new Set(notOnJobRefs.map((n) => n.ref.itemId))];
    const [names, elsewhere] = await Promise.all([
      db
        .select({ id: items.id, name: items.name, assetCode: items.assetCode })
        .from(items)
        .where(inArray(items.id, itemIds)),
      db
        .selectDistinct({ itemId: jobItems.itemId, id: jobs.id, code: jobs.code, name: jobs.name })
        .from(jobItems)
        .innerJoin(jobs, eq(jobItems.jobId, jobs.id))
        .where(
          and(
            inArray(jobItems.itemId, itemIds),
            inArray(jobs.status, [...OPEN_JOB_STATUSES]),
            notInArray(jobs.id, [jobId]),
          ),
        ),
    ]);
    const nameOf = new Map(names.map((n) => [n.id, n]));
    for (const { code, ref } of notOnJobRefs) {
      const item = nameOf.get(ref.itemId);
      notOnJob.push({
        code,
        itemId: ref.itemId,
        unitId: ref.unitId,
        itemName: item?.name ?? "",
        assetCode: item?.assetCode ?? "",
        otherJobs: elsewhere
          .filter((e) => e.itemId === ref.itemId)
          .map((e) => ({ id: e.id, code: e.code, name: e.name })),
      });
    }
  }

  return {
    jobId,
    stage,
    shipmentId: opts.shipmentId ?? null,
    advanced: present(plan.advance.map((p) => show(p, from.get(p.line.id)))),
    alreadyAt: present(plan.already.map((p) => show(p))),
    wrongShipment: present(plan.wrongShipment.map((p) => show(p))),
    notOnJob,
    unknown: plan.unknown,
    blocked: present(
      plan.blocked.map((p) => {
        const o = show(p);
        return o ? { ...o, reason: p.reason } : null;
      }),
    ),
  };
}

async function finish(jobId: string, stage: string, opts: AdvanceOptions, applied: Applied): Promise<AdvanceResult> {
  const { plan } = applied;
  logger.info("jobs.stage.advance", {
    jobId,
    stage,
    via: opts.via,
    advanced: plan.advance.length,
    already: plan.already.length,
    wrongShipment: plan.wrongShipment.length,
    notOnJob: plan.notOnJob.length,
    unknown: plan.unknown.length,
    blocked: plan.blocked.length,
  });
  await emitStageChanged(applied.changes, { ...applied.ctx, jobId });
  for (const e of applied.taskEvents) await emitTaskStatus(e);
  if (applied.startedJob) {
    await emitJobChanged({ job: applied.startedJob, previous: applied.job, userOid: opts.userOid ?? null });
  }
  return describe(jobId, stage, opts, applied);
}

/**
 * Move the lines a batch of scanned codes names to `stage`.
 *
 * Each code is resolved to an item or unit (asset code, unit code or serial,
 * any identifier, or an item page link from a label QR) and matched to this
 * job's lines. The result sorts every code into exactly one bucket:
 *
 * - advanced: moved to `stage` (and onto `shipmentId` when it had none)
 * - alreadyAt: at `stage` or past it; nothing changed
 * - wrongShipment: on this job, but on another shipment; nothing changed
 *   unless `force`, which moves it onto this one
 * - notOnJob: a known item that this job does not include, with the open jobs
 *   it is on instead
 * - unknown: resolves to nothing
 * - blocked: refused by a rule or a registered guard, with the reason
 *
 * Duplicate codes in a batch count once, and two codes for the same line (an
 * RFID tag and a barcode) advance it once.
 */
export async function advanceStage(
  jobId: string,
  codes: string[],
  stage: string,
  opts: AdvanceOptions,
): Promise<AdvanceResult> {
  validate(stage, opts);
  const unique = uniqueCodes(codes);
  if (unique.length > MAX_BATCH) throw badRequest(`Send at most ${MAX_BATCH} codes at a time.`);
  const resolved = await resolveScanCodes(unique);
  const itemIds = [...new Set([...resolved.values()].flat().map((r: ScanRef) => r.itemId))];

  const applied = await apply(
    jobId,
    stage,
    opts,
    (ex) =>
      itemIds.length
        ? ex
            .select({
              id: jobItems.id,
              itemId: jobItems.itemId,
              unitId: jobItems.unitId,
              stage: jobItems.stage,
              shipmentId: jobItems.shipmentId,
            })
            .from(jobItems)
            .where(and(eq(jobItems.jobId, jobId), inArray(jobItems.itemId, itemIds)))
        : Promise.resolve([]),
    (lines) => planAdvance(unique, resolved, lines, stage, { shipmentId: opts.shipmentId, force: opts.force }),
  );
  return finish(jobId, stage, opts, applied);
}

/**
 * Move specific lines to `stage` by id: flagging a line damaged or missing
 * from the manifest table, or ticking rows off by hand. Ids not on this job
 * are ignored. Lines on another shipment are only moved when `shipmentId` is
 * not given, or with force.
 */
export async function setLineStage(
  jobId: string,
  jobItemIds: string[],
  stage: string,
  opts: AdvanceOptions,
): Promise<AdvanceResult> {
  validate(stage, opts);
  const ids = [...new Set(jobItemIds)];
  if (ids.length > MAX_BATCH) throw badRequest(`Send at most ${MAX_BATCH} lines at a time.`);
  const applied = await apply(
    jobId,
    stage,
    opts,
    (ex) =>
      ids.length
        ? ex
            .select({
              id: jobItems.id,
              itemId: jobItems.itemId,
              unitId: jobItems.unitId,
              stage: jobItems.stage,
              shipmentId: jobItems.shipmentId,
            })
            .from(jobItems)
            .where(and(eq(jobItems.jobId, jobId), inArray(jobItems.id, ids)))
        : Promise.resolve([]),
    (lines) => {
      // Each line is its own "code": plan by line id, so the same rules apply.
      const resolved = new Map(lines.map((l) => [l.id, [{ itemId: l.itemId, unitId: l.unitId }]]));
      const plan = planAdvance([], new Map(), [], stage);
      for (const line of lines) {
        const one = planAdvance([line.id], resolved, [line], stage, {
          shipmentId: opts.shipmentId,
          force: opts.force,
        });
        plan.advance.push(...one.advance.map((p) => ({ ...p, code: "" })));
        plan.already.push(...one.already.map((p) => ({ ...p, code: "" })));
        plan.wrongShipment.push(...one.wrongShipment.map((p) => ({ ...p, code: "" })));
        plan.blocked.push(...one.blocked.map((p) => ({ ...p, code: "" })));
      }
      return plan;
    },
  );
  return finish(jobId, stage, opts, applied);
}

/** The rule itself, for a screen that wants to grey out moves before trying them. */
export const canMove = (from: string, to: string, force = false) => decideStage(from, to, force);

function historyQuery() {
  return db
    .select({
      id: jobItemStageHistory.id,
      jobItemId: jobItemStageHistory.jobItemId,
      jobId: jobItemStageHistory.jobId,
      itemId: jobItemStageHistory.itemId,
      unitId: jobItemStageHistory.unitId,
      shipmentId: jobItemStageHistory.shipmentId,
      fromStage: jobItemStageHistory.fromStage,
      toStage: jobItemStageHistory.toStage,
      via: jobItemStageHistory.via,
      deviceId: jobItemStageHistory.deviceId,
      userOid: jobItemStageHistory.userOid,
      actor: jobItemStageHistory.actor,
      note: jobItemStageHistory.note,
      createdAt: jobItemStageHistory.createdAt,
      itemName: items.name,
      assetCode: items.assetCode,
      unitCode: itemUnits.assetCode,
      shipmentCode: shipments.code,
    })
    .from(jobItemStageHistory)
    .innerJoin(items, eq(jobItemStageHistory.itemId, items.id))
    .leftJoin(itemUnits, eq(jobItemStageHistory.unitId, itemUnits.id))
    .leftJoin(shipments, eq(jobItemStageHistory.shipmentId, shipments.id));
}

/** A job's most recent stage changes, newest first. */
export function stageHistory(jobId: string, limit = 100) {
  return historyQuery()
    .where(eq(jobItemStageHistory.jobId, jobId))
    .orderBy(desc(jobItemStageHistory.createdAt))
    .limit(limit);
}

/** Every stage change of one line, oldest first: its trip, for a claim or a custody record. */
export function lineHistory(jobItemId: string) {
  return historyQuery()
    .where(eq(jobItemStageHistory.jobItemId, jobItemId))
    .orderBy(asc(jobItemStageHistory.createdAt));
}
