import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { teardownGuides, type TeardownGuideRow } from "../../db/schema";
import { badRequest, conflict, describeError, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { publish } from "../event-backbone";
import { getGuideRow, sweepOrphanGuides, type JobNote } from "./guides";
import { JobFailure, LeaseLost, jobContext, processGuide, workRoot } from "./pipeline";

/**
 * The in-process queue behind teardown processing. The queue is the table:
 * a guide waiting to be processed has job_status 'queued', so nothing is lost
 * on a restart. Each server process runs one job at a time (ffmpeg and
 * transcription are heavy), claiming it with SELECT … FOR UPDATE SKIP LOCKED so
 * replicas never take the same guide, and holding it with a heartbeat. A job
 * whose heartbeat stops (the process died) is claimed again after
 * STALE_AFTER_MS and resumes from what its stages stored.
 */

const HEARTBEAT_MS = 20_000;
export const STALE_AFTER_MS = 3 * 60_000;
const POLL_MS = 30_000;
const MAX_ATTEMPTS = 3;
const HOUR = 60 * 60_000;

export type ProcessMode = "continue" | "steps" | "all";

/**
 * Queue a guide. `continue` does whatever is still missing (the next stage
 * after a failure, pictures for new steps); `steps` reads the steps again from
 * the transcript already held; `all` transcribes again as well.
 */
export async function enqueueGuide(guideId: string, mode: ProcessMode = "continue"): Promise<void> {
  const row = await getGuideRow(guideId);
  if (!row) throw notFound("That teardown guide does not exist. It may have been deleted.");
  if (!row.videoAttachmentId) throw badRequest("Attach a video to the guide first.");
  if (isRunning(row)) throw conflict("This guide is being processed now. Wait for it to finish, or stop it first.");
  const set: Partial<TeardownGuideRow> = {
    jobStatus: "queued",
    jobQueuedAt: new Date(),
    jobStartedAt: null,
    jobFinishedAt: null,
    jobHeartbeatAt: null,
    jobAttempts: 0,
    jobError: null,
    jobNotes: [],
    jobToken: null,
    jobStage: null,
    jobProgress: null,
    updatedAt: new Date(),
  };
  if (mode === "all") {
    set.transcript = null;
    set.durationSec = null;
  }
  if (mode === "all" || mode === "steps") {
    set.draft = null;
    set.refinedAt = null;
    if (mode === "steps" && row.transcript) set.transcript = { ...row.transcript, stepsRead: false };
  }
  await db.update(teardownGuides).set(set).where(eq(teardownGuides.id, guideId));
  logger.info("teardown.job.queued", { guideId, mode });
  kickTeardownWorker();
}

const isRunning = (row: TeardownGuideRow) =>
  row.jobStatus === "running" &&
  !!row.jobHeartbeatAt &&
  Date.now() - row.jobHeartbeatAt.getTime() < STALE_AFTER_MS;

/**
 * Stop a queued or running job. What its stages already stored (the
 * transcript so far, steps read so far) is kept for "continue".
 */
export async function cancelGuideJob(guideId: string): Promise<void> {
  const row = await getGuideRow(guideId);
  if (!row) throw notFound("That teardown guide does not exist. It may have been deleted.");
  if (row.jobStatus !== "queued" && row.jobStatus !== "running") return;
  const notes: JobNote[] = [
    ...(Array.isArray(row.jobNotes) ? row.jobNotes : []),
    { code: "stopped", message: "Stopped before it finished. Continue to pick up where it left off." },
  ];
  await db
    .update(teardownGuides)
    .set({ jobStatus: "idle", jobToken: null, jobStage: null, jobProgress: null, jobNotes: notes, updatedAt: new Date() })
    .where(eq(teardownGuides.id, guideId));
  logger.info("teardown.job.cancelled", { guideId });
}

type Claimed = { id: string; token: string; attempts: number; notes: JobNote[] };

export async function claimNext(): Promise<Claimed | null> {
  const token = randomUUID();
  const { rows } = await pool.query<{ id: string; job_attempts: number; job_notes: JobNote[] }>(
    `WITH next AS (
       SELECT id FROM teardown_guides
        WHERE job_status = 'queued'
           OR (job_status = 'running' AND (job_heartbeat_at IS NULL OR job_heartbeat_at < now() - $2::interval))
        ORDER BY job_queued_at NULLS LAST, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
     UPDATE teardown_guides g
        SET job_status = 'running', job_token = $1, job_attempts = g.job_attempts + 1,
            job_started_at = now(), job_heartbeat_at = now(), job_error = NULL, updated_at = now()
       FROM next WHERE g.id = next.id
     RETURNING g.id, g.job_attempts, g.job_notes`,
    [token, `${STALE_AFTER_MS / 1000} seconds`],
  );
  const row = rows[0];
  return row ? { id: row.id, token, attempts: row.job_attempts, notes: row.job_notes ?? [] } : null;
}

/** Close the job, only if this process still holds it. */
async function finish(id: string, token: string, set: Partial<TeardownGuideRow>): Promise<boolean> {
  const done = await db
    .update(teardownGuides)
    .set({ ...set, jobToken: null, jobStage: null, jobProgress: null, jobFinishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(teardownGuides.id, id), eq(teardownGuides.jobToken, token)))
    .returning({ id: teardownGuides.id });
  return done.length > 0;
}

/** Run one claimed job to the end. Exported for tests, which drive jobs directly. */
export async function runJob(job: Claimed): Promise<void> {
  const { id, token } = job;
  if (job.attempts > MAX_ATTEMPTS) {
    await finish(id, token, {
      jobStatus: "failed",
      jobError: `Processing stopped ${MAX_ATTEMPTS} times without finishing, most likely because the server restarted or ran out of memory. Try again, or write the steps by hand.`,
    });
    logger.warn("teardown.job.gave_up", { guideId: id, attempts: job.attempts });
    return;
  }
  logger.info("teardown.job.started", { guideId: id, attempt: job.attempts });
  const ctx = jobContext(id, token, job.notes);
  const beat = setInterval(() => {
    pool
      .query(`UPDATE teardown_guides SET job_heartbeat_at = now() WHERE id = $1 AND job_token = $2`, [id, token])
      .catch((err) => logger.warn("teardown.job.heartbeat_failed", { guideId: id, err: describeError(err) }));
  }, HEARTBEAT_MS);
  beat.unref();
  try {
    const outcome = await processGuide(ctx);
    if (!(await finish(id, token, { jobStatus: "done", jobError: null, jobNotes: ctx.notes }))) throw new LeaseLost();
    const guide = await getGuideRow(id);
    await publish(
      "teardown.guide_processed",
      {
        guideId: id,
        itemId: guide?.itemId,
        unitId: guide?.unitId,
        title: guide?.title,
        transcribed: outcome.transcribed,
        steps: outcome.steps,
        parts: outcome.parts,
        draftPending: Boolean((guide?.draft as { complete?: boolean } | null)?.complete),
        notes: outcome.notes.map((n) => n.code),
      },
      { subject: { type: "teardown_guide", id } },
    );
  } catch (err) {
    if (err instanceof LeaseLost) {
      logger.info("teardown.job.released", { guideId: id });
      return;
    }
    const message =
      err instanceof JobFailure ? err.message : "Processing failed unexpectedly. The server log has the details; try again.";
    logger.warn("teardown.job.failed", { guideId: id, err: describeError(err), detail: (err as { detail?: string }).detail });
    await finish(id, token, { jobStatus: "failed", jobError: message, jobNotes: ctx.notes });
  } finally {
    clearInterval(beat);
  }
}

let busy = false;
let again = false;

async function drain(): Promise<void> {
  busy = true;
  try {
    do {
      again = false;
      for (;;) {
        // Switching the feature off pauses the queue; nothing is dropped.
        if (!(await getConfig()).features.teardown) break;
        const job = await claimNext();
        if (!job) break;
        await runJob(job);
      }
    } while (again);
  } catch (err) {
    logger.warn("teardown.worker.failed", { err: describeError(err) });
  } finally {
    busy = false;
  }
}

/** Look for work now, rather than at the next poll. */
export function kickTeardownWorker(): void {
  if (busy) {
    again = true;
    return;
  }
  void drain();
}

async function sweepWorkDirs(): Promise<void> {
  const root = workRoot();
  const names = await fsp.readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    const dir = path.join(root, name);
    const st = await fsp.stat(dir).catch(() => null);
    // A running job touches its directory far more often than this.
    if (st && Date.now() - st.mtimeMs > 24 * HOUR) await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function housekeeping(): Promise<void> {
  try {
    const removed = await sweepOrphanGuides();
    if (removed) logger.info("teardown.sweep.done", { guides: removed });
    await sweepWorkDirs();
  } catch (err) {
    logger.warn("teardown.sweep.failed", { err: describeError(err) });
  }
}

/** Start polling for queued guides, and the hourly sweep. Safe in every replica. */
export function startTeardownWorker(): void {
  setTimeout(kickTeardownWorker, 5_000).unref();
  setInterval(kickTeardownWorker, POLL_MS).unref();
  setTimeout(() => void housekeeping(), 90_000).unref();
  setInterval(() => void housekeeping(), HOUR).unref();
}
