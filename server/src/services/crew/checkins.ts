import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  attachments,
  crewCheckins,
  crewWorkers,
  jobTypes,
  jobs,
  type CrewCheckin,
  type CrewWorker,
} from "../../db/schema";
import { HttpError, badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { OPEN_JOB_STATUSES, completeTasksByKind } from "../jobs-core";
import { credentialTypesByKey } from "./credentialTypes";
import { asFacts, credentialsForWorkers } from "./credentials";
import { crewEvent } from "./events";
import {
  badgeCodeFromScan,
  decideGate,
  evaluateCompliance,
  localDate,
  shiftMinutes,
  type Compliance,
  type CrewPolicySetting,
  type RequiredType,
} from "./model";
import { policyForJobType, requiredTypes } from "./policy";
import { actorName, clean, type CrewActor } from "./shared";
import { verifierAvailable, verifyWorker, type VerifierResult } from "./verifier";
import { findWorkerByBadge, loadWorker } from "./workers";

/**
 * Checking crew in and out of jobs. A badge scan (or a pick from a search)
 * finds the worker, asks the external verifier when there is one, judges their
 * credentials against what the job's type requires, and either lets them in,
 * lets them in flagged, or refuses until someone with a reason overrides.
 * Everything seen at the door is kept on the check-in row.
 */

export const CREW_TASK_KIND = "crew_checkin";

export type CheckInInput = {
  /** What was scanned or typed: a badge code, or the link a badge QR carries. */
  code?: string;
  workerId?: string;
  via?: string;
  /** The viewer's time zone, for judging expiry dates on the right day. */
  tz?: string;
  overrideReason?: string | null;
  /** Check them out of the job they are on first. */
  switchJob?: boolean;
  note?: string | null;
};

export type WorkerBrief = Pick<CrewWorker, "id" | "name" | "company" | "role" | "badgeCode" | "active"> & {
  photoUrl: string | null;
};

type JobRef = { id: string; code: string; name: string; status: string; jobTypeId: string | null };

const brief = (w: CrewWorker): WorkerBrief => ({
  id: w.id,
  name: w.name,
  company: w.company,
  role: w.role,
  badgeCode: w.badgeCode,
  active: w.active,
  photoUrl: w.photoAttachmentId ? `/api/attachments/${w.photoAttachmentId}/thumb?w=160` : null,
});

async function loadJob(jobId: string): Promise<JobRef> {
  const [job] = await db
    .select({ id: jobs.id, code: jobs.code, name: jobs.name, status: jobs.status, jobTypeId: jobs.jobTypeId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) throw notFound("Job not found");
  return job;
}

function assertOpen(job: JobRef): void {
  if (!(OPEN_JOB_STATUSES as readonly string[]).includes(job.status)) {
    throw badRequest(`${job.code} is ${job.status.replace(/_/g, " ")}. Reopen it (set it back to in progress) to check crew in.`);
  }
}

async function resolveWorker(input: Pick<CheckInInput, "code" | "workerId">): Promise<CrewWorker> {
  if (input.workerId) return loadWorker(input.workerId);
  const code = input.code ? badgeCodeFromScan(input.code) : null;
  if (!code) throw badRequest("Scan a badge, or pick the worker from the list.");
  const worker = await findWorkerByBadge(code);
  if (!worker) {
    throw new HttpError(404, "unknown_badge", `No worker has badge ${code}. Check the badge, or add them under Crew → Workers.`, {
      code,
    });
  }
  return worker;
}

async function openCheckinOf(workerId: string) {
  const [row] = await db
    .select({ ...getTableColumns(crewCheckins), jobCode: jobs.code, jobName: jobs.name })
    .from(crewCheckins)
    .innerJoin(jobs, eq(jobs.id, crewCheckins.jobId))
    .where(and(eq(crewCheckins.workerId, workerId), isNull(crewCheckins.checkedOutAt)))
    .limit(1);
  return row ?? null;
}

/** Judge one worker against a job's requirements, from what is on file now. */
async function judge(
  worker: CrewWorker,
  required: RequiredType[],
  today: string,
): Promise<Compliance> {
  const credentials = (await credentialsForWorkers([worker.id])).get(worker.id) ?? [];
  return evaluateCompliance({ required, credentials: credentials.map(asFacts), today });
}

export type CheckInOutcome = {
  status: "checked_in" | "already";
  checkin: CrewCheckin;
  worker: WorkerBrief;
  compliance: Compliance;
  policy: CrewPolicySetting;
  verifier: VerifierResult | null;
  warned: boolean;
  overridden: boolean;
  movedFrom: { jobId: string; jobCode: string } | null;
};

export async function checkIn(jobId: string, input: CheckInInput, actor: CrewActor): Promise<CheckInOutcome> {
  const job = await loadJob(jobId);
  assertOpen(job);
  const worker = await resolveWorker(input);
  if (!worker.active) {
    throw new HttpError(409, "worker_inactive", `${worker.name} is marked inactive. Reactivate them on their worker page first.`, {
      worker: brief(worker),
    });
  }

  const [types, policy] = await Promise.all([credentialTypesByKey(), policyForJobType(job.jobTypeId)]);
  const required = requiredTypes(policy, types);
  const today = localDate(new Date(), input.tz);

  let movedFrom: CheckInOutcome["movedFrom"] = null;
  const open = await openCheckinOf(worker.id);
  if (open && open.jobId === job.id) {
    return {
      status: "already",
      checkin: stripJoin(open),
      worker: brief(worker),
      compliance: await judge(worker, required, today),
      policy,
      verifier: null,
      warned: false,
      overridden: false,
      movedFrom: null,
    };
  }
  if (open && !input.switchJob) {
    throw new HttpError(
      409,
      "checked_in_elsewhere",
      `${worker.name} is still checked in on ${open.jobCode} (${open.jobName}). Check them out there first, or move them here.`,
      { worker: brief(worker), jobId: open.jobId, jobCode: open.jobCode, jobName: open.jobName, checkinId: open.id, since: open.checkedInAt },
    );
  }

  const verifier = verifierAvailable() ? await verifyWorker(worker, types) : null;
  const compliance = await judge(worker, required, today);
  const decision = decideGate(compliance, policy, { reason: input.overrideReason, isAdmin: actor.isAdmin });
  const via = input.via ?? "manual";

  if (!decision.allowed) {
    logger.info("crew.checkin.refused", { jobId, workerId: worker.id, reason: decision.reason });
    await crewEvent(
      "crew.check_in_refused",
      { jobId, jobCode: job.code, workerId: worker.id, workerName: worker.name, compliance: compliance.light, summary: compliance.summary, via },
      actor,
      { type: "job", id: jobId },
    );
    const message =
      decision.reason === "override_admin_only"
        ? `${worker.name} cannot be checked in: ${compliance.summary}. Only an administrator can override this job type's policy.`
        : `${worker.name} cannot be checked in: ${compliance.summary}. Bring their credentials up to date, or override with a reason.`;
    throw new HttpError(409, "credentials_blocked", message, {
      worker: brief(worker),
      compliance,
      policy,
      verifier,
      reason: decision.reason,
    });
  }

  if (open) {
    await checkOut(open.id, { note: `Moved to ${job.code}` }, actor);
    movedFrom = { jobId: open.jobId, jobCode: open.jobCode };
  }

  const reason = clean(input.overrideReason);
  const note = clean(input.note) ?? (!decision.overridden ? reason : null);
  let checkin: CrewCheckin;
  try {
    [checkin] = (await db
      .insert(crewCheckins)
      .values({
        jobId,
        workerId: worker.id,
        via,
        compliance: compliance.light,
        complianceDetail: compliance.checks,
        policy: policy.policy,
        overrideReason: decision.overridden ? reason : null,
        overriddenBy: decision.overridden ? actor.userOid : null,
        overriddenByName: decision.overridden ? actorName(actor) : null,
        checkedInBy: actor.userOid,
        checkedInByName: actorName(actor),
        notes: note,
      })
      .returning()) as [CrewCheckin];
  } catch (err) {
    // Two scans of the same badge at once: the other one won.
    if (isUniqueViolation(err, "uq_crew_checkins_open")) {
      const now = await openCheckinOf(worker.id);
      if (now?.jobId === jobId) {
        return { status: "already", checkin: stripJoin(now), worker: brief(worker), compliance, policy, verifier, warned: false, overridden: false, movedFrom };
      }
      throw conflict(`${worker.name} was just checked in on another job.`);
    }
    throw err;
  }

  logger.info("crew.checkin.created", {
    jobId,
    workerId: worker.id,
    compliance: compliance.light,
    overridden: decision.overridden,
  });
  await crewEvent(
    "crew.checked_in",
    {
      jobId,
      jobCode: job.code,
      checkinId: checkin.id,
      workerId: worker.id,
      workerName: worker.name,
      company: worker.company,
      via,
      compliance: compliance.light,
      summary: compliance.summary,
      policy: policy.policy,
      overridden: decision.overridden,
      overrideReason: checkin.overrideReason,
      movedFrom: movedFrom?.jobCode ?? null,
    },
    actor,
    { type: "job", id: jobId },
  );
  if (decision.overridden) {
    await crewEvent(
      "crew.check_in_overridden",
      {
        jobId,
        jobCode: job.code,
        checkinId: checkin.id,
        workerId: worker.id,
        workerName: worker.name,
        summary: compliance.summary,
        checks: compliance.checks.filter((c) => c.light === "red").map((c) => ({ type: c.typeKey, reason: c.reason, expiresOn: c.expiresOn })),
        reason: checkin.overrideReason,
        by: checkin.overriddenByName,
      },
      actor,
      { type: "job", id: jobId },
    );
  }
  // A "Crew check-in" task on the job is done once the crew starts arriving.
  await completeTasksByKind(jobId, CREW_TASK_KIND, { userOid: actor.userOid, name: actor.name }).catch((err) =>
    logger.warn("crew.checkin.task_failed", { jobId, err: describeError(err) }),
  );

  return {
    status: "checked_in",
    checkin,
    worker: brief(worker),
    compliance,
    policy,
    verifier,
    warned: decision.warned,
    overridden: decision.overridden,
    movedFrom,
  };
}

function stripJoin<T extends CrewCheckin>(row: T & { jobCode?: string; jobName?: string }): CrewCheckin {
  const { jobCode: _c, jobName: _n, ...rest } = row;
  return rest as CrewCheckin;
}

async function loadCheckin(id: string): Promise<CrewCheckin> {
  const [row] = await db.select().from(crewCheckins).where(eq(crewCheckins.id, id)).limit(1);
  if (!row) throw notFound("Check-in not found");
  return row;
}

const MAX_FUTURE_MS = 5 * 60_000;

function checkWhen(at: Date, what: string): void {
  if (Number.isNaN(at.getTime())) throw badRequest(`${what} is not a date and time.`);
  if (at.getTime() > Date.now() + MAX_FUTURE_MS) throw badRequest(`${what} is in the future.`);
}

export type CheckOutInput = { at?: string | null; breakMinutes?: number; note?: string | null };

export async function checkOut(id: string, input: CheckOutInput, actor: CrewActor): Promise<CrewCheckin> {
  const current = await loadCheckin(id);
  if (current.checkedOutAt) {
    throw conflict(`Already checked out at ${current.checkedOutAt.toISOString()}. Edit the check-in to change the time.`);
  }
  const at = input.at ? new Date(input.at) : new Date();
  checkWhen(at, "The check-out time");
  if (at < current.checkedInAt) throw badRequest("The check-out time is before they checked in.");
  const [row] = await db
    .update(crewCheckins)
    .set({
      checkedOutAt: at,
      checkedOutBy: actor.userOid,
      checkedOutByName: actorName(actor),
      ...(input.breakMinutes !== undefined ? { breakMinutes: input.breakMinutes } : {}),
      ...(clean(input.note) ? { notes: [current.notes, clean(input.note)].filter(Boolean).join("\n") } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(crewCheckins.id, id), isNull(crewCheckins.checkedOutAt)))
    .returning();
  if (!row) throw conflict("Already checked out. Refresh to see the time.");
  const minutes = shiftMinutes(row.checkedInAt, row.checkedOutAt, row.breakMinutes, new Date());
  const worker = await loadWorker(row.workerId).catch(() => null);
  logger.info("crew.checkin.closed", { checkinId: id, jobId: row.jobId, minutes });
  await crewEvent(
    "crew.checked_out",
    { jobId: row.jobId, checkinId: id, workerId: row.workerId, workerName: worker?.name ?? null, minutes, breakMinutes: row.breakMinutes },
    actor,
    { type: "job", id: row.jobId },
  );
  return row;
}

/** Scan a badge at the end of a shift. */
export async function checkOutByCode(
  jobId: string,
  input: Pick<CheckInInput, "code" | "workerId"> & CheckOutInput,
  actor: CrewActor,
): Promise<{ checkin: CrewCheckin; worker: WorkerBrief }> {
  const job = await loadJob(jobId);
  const worker = await resolveWorker(input);
  const [open] = await db
    .select()
    .from(crewCheckins)
    .where(and(eq(crewCheckins.jobId, jobId), eq(crewCheckins.workerId, worker.id), isNull(crewCheckins.checkedOutAt)))
    .limit(1);
  if (!open) throw new HttpError(404, "not_checked_in", `${worker.name} is not checked in on ${job.code}.`, { worker: brief(worker) });
  return { checkin: await checkOut(open.id, input, actor), worker: brief(worker) };
}

/** End of the day: everyone still on the job goes off the clock at `at` (default now). */
export async function checkOutAll(jobId: string, input: CheckOutInput, actor: CrewActor): Promise<{ count: number }> {
  await loadJob(jobId);
  const open = await db
    .select({ id: crewCheckins.id, checkedInAt: crewCheckins.checkedInAt })
    .from(crewCheckins)
    .where(and(eq(crewCheckins.jobId, jobId), isNull(crewCheckins.checkedOutAt)));
  let count = 0;
  for (const c of open) {
    // A shared end time earlier than someone's arrival would be refused; they
    // leave now instead.
    const at = input.at && new Date(input.at) >= c.checkedInAt ? input.at : null;
    await checkOut(c.id, { ...input, at }, actor).then(
      () => count++,
      (err) => logger.warn("crew.checkout_all.skipped", { checkinId: c.id, err: describeError(err) }),
    );
  }
  return { count };
}

export type CheckinPatch = {
  checkedInAt?: string;
  checkedOutAt?: string | null;
  breakMinutes?: number;
  notes?: string | null;
};

/** Timesheet corrections. Each one is published with the before and after. */
export async function updateCheckin(id: string, patch: CheckinPatch, actor: CrewActor): Promise<CrewCheckin> {
  const current = await loadCheckin(id);
  const set: Partial<typeof crewCheckins.$inferInsert> = { updatedAt: new Date() };
  if (patch.checkedInAt !== undefined) {
    const at = new Date(patch.checkedInAt);
    checkWhen(at, "The check-in time");
    set.checkedInAt = at;
  }
  if (patch.checkedOutAt !== undefined) {
    if (patch.checkedOutAt === null) {
      set.checkedOutAt = null;
      set.checkedOutBy = null;
      set.checkedOutByName = null;
    } else {
      const at = new Date(patch.checkedOutAt);
      checkWhen(at, "The check-out time");
      set.checkedOutAt = at;
      if (!current.checkedOutAt) {
        set.checkedOutBy = actor.userOid;
        set.checkedOutByName = actorName(actor);
      }
    }
  }
  if (patch.breakMinutes !== undefined) set.breakMinutes = patch.breakMinutes;
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  const inAt = set.checkedInAt ?? current.checkedInAt;
  const outAt = set.checkedOutAt !== undefined ? set.checkedOutAt : current.checkedOutAt;
  if (outAt && outAt < inAt) throw badRequest("The check-out time is before the check-in time.");
  let row: CrewCheckin;
  try {
    [row] = (await db.update(crewCheckins).set(set).where(eq(crewCheckins.id, id)).returning()) as [CrewCheckin];
  } catch (err) {
    if (isUniqueViolation(err, "uq_crew_checkins_open")) {
      throw conflict("That worker is checked in somewhere else now, so this shift cannot be reopened.");
    }
    throw err;
  }
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  await crewEvent(
    "crew.checkin_updated",
    {
      jobId: row.jobId,
      checkinId: id,
      workerId: row.workerId,
      before: { checkedInAt: iso(current.checkedInAt), checkedOutAt: iso(current.checkedOutAt), breakMinutes: current.breakMinutes },
      after: { checkedInAt: iso(row.checkedInAt), checkedOutAt: iso(row.checkedOutAt), breakMinutes: row.breakMinutes },
    },
    actor,
    { type: "job", id: row.jobId },
  );
  return row;
}

export async function deleteCheckin(id: string, actor: CrewActor): Promise<void> {
  const current = await loadCheckin(id);
  await db.delete(crewCheckins).where(eq(crewCheckins.id, id));
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  await crewEvent(
    "crew.checkin_deleted",
    {
      jobId: current.jobId,
      checkinId: id,
      workerId: current.workerId,
      checkedInAt: iso(current.checkedInAt),
      checkedOutAt: iso(current.checkedOutAt),
      compliance: current.compliance,
      overrideReason: current.overrideReason,
    },
    actor,
    { type: "job", id: current.jobId },
  );
}

// --- Reading ------------------------------------------------------------------------

/** Open jobs, for the check-in screen's picker, with how many are on site. */
export async function listCrewJobs() {
  const onSite = db
    .select({ jobId: crewCheckins.jobId, n: sql<number>`count(*)::int`.as("n") })
    .from(crewCheckins)
    .where(isNull(crewCheckins.checkedOutAt))
    .groupBy(crewCheckins.jobId)
    .as("on_site");
  return db
    .select({
      id: jobs.id,
      code: jobs.code,
      name: jobs.name,
      status: jobs.status,
      jobTypeId: jobs.jobTypeId,
      jobTypeName: jobTypes.name,
      jobTypeColor: jobTypes.color,
      scheduledStart: jobs.scheduledStart,
      onSite: sql<number>`coalesce(${onSite.n}, 0)::int`,
    })
    .from(jobs)
    .leftJoin(jobTypes, eq(jobTypes.id, jobs.jobTypeId))
    .leftJoin(onSite, eq(onSite.jobId, jobs.id))
    .where(inArray(jobs.status, [...OPEN_JOB_STATUSES]))
    .orderBy(desc(sql`coalesce(${onSite.n}, 0)`), asc(jobs.scheduledStart), desc(jobs.createdAt))
    .limit(500);
}

export type RosterEntry = CrewCheckin & {
  worker: WorkerBrief;
  minutes: number;
  /** Judged now, from what is on file: a credential can lapse mid-job. */
  current: Compliance;
};

export async function roster(jobId: string, tz?: string) {
  const job = await loadJob(jobId);
  const [types, policy] = await Promise.all([credentialTypesByKey(), policyForJobType(job.jobTypeId)]);
  const required = requiredTypes(policy, types);
  const [typeRow] = job.jobTypeId
    ? await db.select({ name: jobTypes.name, color: jobTypes.color }).from(jobTypes).where(eq(jobTypes.id, job.jobTypeId)).limit(1)
    : [];
  const rows = await db
    .select({ checkin: crewCheckins, worker: crewWorkers, photoId: attachments.id })
    .from(crewCheckins)
    .innerJoin(crewWorkers, eq(crewWorkers.id, crewCheckins.workerId))
    .leftJoin(attachments, eq(attachments.id, crewWorkers.photoAttachmentId))
    .where(eq(crewCheckins.jobId, jobId))
    .orderBy(desc(crewCheckins.checkedInAt))
    .limit(2000);
  const workerIds = [...new Set(rows.map((r) => r.worker.id))];
  const credentials = await credentialsForWorkers(workerIds);
  const today = localDate(new Date(), tz);
  const current = new Map(
    workerIds.map((id) => [
      id,
      evaluateCompliance({ required, credentials: (credentials.get(id) ?? []).map(asFacts), today }),
    ]),
  );
  const now = new Date();
  const entries: RosterEntry[] = rows.map((r) => ({
    ...r.checkin,
    worker: { ...brief(r.worker), photoUrl: r.photoId ? `/api/attachments/${r.photoId}/thumb?w=160` : null },
    minutes: shiftMinutes(r.checkin.checkedInAt, r.checkin.checkedOutAt, r.checkin.breakMinutes, now),
    current: current.get(r.worker.id)!,
  }));
  const perWorker = new Map<string, { worker: WorkerBrief; minutes: number; shifts: number; onSite: boolean }>();
  for (const e of entries) {
    const t = perWorker.get(e.workerId) ?? { worker: e.worker, minutes: 0, shifts: 0, onSite: false };
    t.minutes += e.minutes;
    t.shifts += 1;
    t.onSite ||= e.checkedOutAt === null;
    perWorker.set(e.workerId, t);
  }
  const workers = [...perWorker.values()].sort((a, b) => a.worker.name.localeCompare(b.worker.name));
  return {
    job: { ...job, jobTypeName: typeRow?.name ?? null, jobTypeColor: typeRow?.color ?? null },
    policy,
    required,
    onSite: entries.filter((e) => e.checkedOutAt === null),
    shifts: entries,
    workers,
    totals: {
      minutes: workers.reduce((s, w) => s + w.minutes, 0),
      workers: workers.length,
      onSite: entries.filter((e) => e.checkedOutAt === null).length,
    },
  };
}

/**
 * Workers matching a search, each judged against this job's requirements, so
 * the person at the door sees who can come in before picking them. No
 * verifier call: that happens on the check-in itself.
 */
export async function candidates(jobId: string, q: string, tz?: string) {
  const job = await loadJob(jobId);
  const [types, policy] = await Promise.all([credentialTypesByKey(), policyForJobType(job.jobTypeId)]);
  const required = requiredTypes(policy, types);
  const term = q.trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select({ worker: crewWorkers, photoId: attachments.id })
    .from(crewWorkers)
    .leftJoin(attachments, eq(attachments.id, crewWorkers.photoAttachmentId))
    .where(
      sql`(${crewWorkers.name} ILIKE ${like} OR ${crewWorkers.badgeCode} ILIKE ${like} OR ${crewWorkers.company} ILIKE ${like})`,
    )
    .orderBy(desc(crewWorkers.active), asc(sql`lower(${crewWorkers.name})`))
    .limit(25);
  const ids = rows.map((r) => r.worker.id);
  const [credentials, open] = await Promise.all([
    credentialsForWorkers(ids),
    ids.length
      ? db
          .select({ workerId: crewCheckins.workerId, jobId: crewCheckins.jobId, jobCode: jobs.code })
          .from(crewCheckins)
          .innerJoin(jobs, eq(jobs.id, crewCheckins.jobId))
          .where(and(inArray(crewCheckins.workerId, ids), isNull(crewCheckins.checkedOutAt)))
      : Promise.resolve([]),
  ]);
  const openBy = new Map(open.map((o) => [o.workerId, o]));
  const today = localDate(new Date(), tz);
  return rows.map((r) => ({
    worker: { ...brief(r.worker), photoUrl: r.photoId ? `/api/attachments/${r.photoId}/thumb?w=160` : null },
    compliance: evaluateCompliance({ required, credentials: (credentials.get(r.worker.id) ?? []).map(asFacts), today }),
    onJob: openBy.get(r.worker.id) ?? null,
  }));
}
