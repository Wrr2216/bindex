import { and, asc, desc, eq, getTableColumns, ilike, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import {
  entities,
  jobItems,
  jobTasks,
  jobTypes,
  jobs,
  locations,
  projectPhases,
  projects,
  shipments,
  type Job,
  type JobStatus,
  type JobTask,
  type JobTaskStatus,
} from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { withFreshCode } from "./codes";
import { emitJobChanged, emitTaskStatus, type TaskEvent } from "./hooks";
import { PROGRESS_STAGES, isTaskKind, taskKindList, taskKindsForStage, type ProgressStage } from "./model";
import { getJobProgress, progressByJob, progressByShipment } from "./progress";
import { hasReached, jobTimestamps } from "./rules";
import { assertDateOrder, clean, loadJob, type Actor, type Executor } from "./shared";

/**
 * Jobs and their task lists. A job is one piece of work that moves a set of
 * items: an office floor, a delivery, a clear-out to storage. Its task list
 * comes from its job type and can be edited per job.
 */

export type JobInput = {
  name: string;
  projectId?: string | null;
  phaseId?: string | null;
  jobTypeId?: string | null;
  status?: JobStatus;
  originLocationId?: string | null;
  destinationLocationId?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  notes?: string | null;
};

export type TaskInput = {
  title: string;
  kind?: string;
  sequence?: number;
  status?: JobTaskStatus;
  assigneeEntityId?: string | null;
  assigneeUserOid?: string | null;
  dueAt?: string | null;
  notes?: string | null;
};

const origin = alias(locations, "origin");
const destination = alias(locations, "destination");

function jobSelection() {
  return {
    ...getTableColumns(jobs),
    jobTypeName: jobTypes.name,
    jobTypeColor: jobTypes.color,
    projectCode: projects.code,
    projectName: projects.name,
    phaseName: projectPhases.name,
    originName: origin.name,
    destinationName: destination.name,
  };
}

function jobQuery() {
  return db
    .select(jobSelection())
    .from(jobs)
    .leftJoin(jobTypes, eq(jobs.jobTypeId, jobTypes.id))
    .leftJoin(projects, eq(jobs.projectId, projects.id))
    .leftJoin(projectPhases, eq(jobs.phaseId, projectPhases.id))
    .leftJoin(origin, eq(jobs.originLocationId, origin.id))
    .leftJoin(destination, eq(jobs.destinationLocationId, destination.id));
}

export async function listJobs(
  opts: { projectId?: string; phaseId?: string; status?: JobStatus; jobTypeId?: string; q?: string } = {},
) {
  const q = opts.q?.trim();
  const rows = await jobQuery()
    .where(
      and(
        opts.projectId ? eq(jobs.projectId, opts.projectId) : undefined,
        opts.phaseId ? eq(jobs.phaseId, opts.phaseId) : undefined,
        opts.status ? eq(jobs.status, opts.status) : undefined,
        opts.jobTypeId ? eq(jobs.jobTypeId, opts.jobTypeId) : undefined,
        q ? or(ilike(jobs.name, `%${q}%`), ilike(jobs.code, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(desc(jobs.createdAt));
  const progress = await progressByJob(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, progress: progress.get(r.id)! }));
}

/** Everything the job page shows on first load, apart from the manifest itself. */
export async function getJob(id: string) {
  const [row] = await jobQuery().where(eq(jobs.id, id)).limit(1);
  if (!row) throw notFound("Job not found");
  const [tasks, jobShipments, progress] = await Promise.all([
    listTasks(id),
    db
      .select({
        ...getTableColumns(shipments),
        vehicleName: locations.name,
      })
      .from(shipments)
      .leftJoin(locations, eq(shipments.vehicleLocationId, locations.id))
      .where(eq(shipments.jobId, id))
      .orderBy(asc(shipments.createdAt)),
    getJobProgress(id),
  ]);
  const shipmentProgress = await progressByShipment(jobShipments.map((s) => s.id));
  return {
    ...row,
    tasks,
    shipments: jobShipments.map((s) => ({ ...s, progress: shipmentProgress.get(s.id)! })),
    progress,
  };
}

/** Resolve project and phase together: a phase implies its project and must match it. */
async function projectAndPhase(
  projectId: string | null | undefined,
  phaseId: string | null | undefined,
): Promise<{ projectId: string | null; phaseId: string | null }> {
  if (phaseId) {
    const [phase] = await db
      .select({ projectId: projectPhases.projectId })
      .from(projectPhases)
      .where(eq(projectPhases.id, phaseId))
      .limit(1);
    if (!phase) throw notFound("Phase not found");
    if (projectId && projectId !== phase.projectId) {
      throw badRequest("That phase belongs to a different project.");
    }
    return { projectId: phase.projectId, phaseId };
  }
  if (projectId) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) throw notFound("Project not found");
  }
  return { projectId: projectId ?? null, phaseId: null };
}

const toDate = (s: string | null | undefined) => (s ? new Date(s) : null);

export async function createJob(
  input: JobInput & { seedTasks?: boolean },
  actor: Actor,
): Promise<Job> {
  const name = clean(input.name);
  if (!name) throw badRequest("A job needs a name.");
  assertDateOrder(input.scheduledStart, input.scheduledEnd, "The job");
  const link = await projectAndPhase(input.projectId, input.phaseId);
  let template: { kind: string; title: string }[] = [];
  if (input.jobTypeId) {
    const [type] = await db.select().from(jobTypes).where(eq(jobTypes.id, input.jobTypeId)).limit(1);
    if (!type) throw notFound("Job type not found");
    template = type.taskTemplate;
  }
  const status = input.status ?? "planned";
  const now = new Date();

  const job = await withFreshCode("job", "uq_jobs_code", (code) =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(jobs)
        .values({
          code,
          name,
          ...link,
          jobTypeId: input.jobTypeId ?? null,
          status,
          originLocationId: input.originLocationId ?? null,
          destinationLocationId: input.destinationLocationId ?? null,
          scheduledStart: toDate(input.scheduledStart),
          scheduledEnd: toDate(input.scheduledEnd),
          notes: clean(input.notes),
          createdBy: actor.userOid,
          ...jobTimestamps(status, { startedAt: null, completedAt: null }, now),
        })
        .returning();
      // Seeded from the type: a template step whose kind has since been
      // unregistered still becomes a task, labelled as it was written.
      if (input.seedTasks !== false && template.length) {
        await tx.insert(jobTasks).values(
          template.map((step, i) => ({
            jobId: row!.id,
            sequence: i + 1,
            kind: step.kind,
            title: step.title,
          })),
        );
      }
      return row!;
    }),
  );
  logger.info("jobs.job.created", { jobId: job.id, code: job.code, tasks: template.length });
  await emitJobChanged({ job, previous: null, userOid: actor.userOid });
  return job;
}

export async function updateJob(id: string, patch: Partial<JobInput>, actor: Actor): Promise<Job> {
  const current = await loadJob(id);
  const set: Partial<typeof jobs.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = clean(patch.name);
    if (!name) throw badRequest("A job needs a name.");
    set.name = name;
  }
  if (patch.projectId !== undefined || patch.phaseId !== undefined) {
    const projectId = patch.projectId !== undefined ? patch.projectId : current.projectId;
    // Moving to another project drops a phase that belonged to the old one.
    const phaseId =
      patch.phaseId !== undefined ? patch.phaseId : projectId === current.projectId ? current.phaseId : null;
    Object.assign(set, await projectAndPhase(projectId, phaseId));
  }
  if (patch.jobTypeId !== undefined) set.jobTypeId = patch.jobTypeId;
  if (patch.originLocationId !== undefined) set.originLocationId = patch.originLocationId;
  if (patch.destinationLocationId !== undefined) set.destinationLocationId = patch.destinationLocationId;
  if (patch.scheduledStart !== undefined) set.scheduledStart = toDate(patch.scheduledStart);
  if (patch.scheduledEnd !== undefined) set.scheduledEnd = toDate(patch.scheduledEnd);
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  if (patch.status !== undefined && patch.status !== current.status) {
    set.status = patch.status;
    Object.assign(set, jobTimestamps(patch.status, current, new Date()));
  }
  assertDateOrder(
    set.scheduledStart !== undefined ? set.scheduledStart : current.scheduledStart,
    set.scheduledEnd !== undefined ? set.scheduledEnd : current.scheduledEnd,
    "The job",
  );
  const [row] = await db.update(jobs).set(set).where(eq(jobs.id, id)).returning();
  if (set.status) logger.info("jobs.job.status", { jobId: id, from: current.status, to: set.status });
  await emitJobChanged({ job: row!, previous: current, userOid: actor.userOid });
  return row!;
}

export async function deleteJob(id: string): Promise<void> {
  const deleted = await db.delete(jobs).where(eq(jobs.id, id)).returning({ id: jobs.id, code: jobs.code });
  if (!deleted.length) throw notFound("Job not found");
  logger.info("jobs.job.deleted", { jobId: id, code: deleted[0]!.code });
}

/**
 * Store a later feature's per-job data under its own key in `metadata`, so
 * features never overwrite each other. `value` undefined removes the key.
 */
export async function setJobMetadata(id: string, key: string, value: unknown): Promise<Job> {
  const expr =
    value === undefined
      ? sql`${jobs.metadata} - ${key}`
      : sql`${jobs.metadata} || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)`;
  const [row] = await db.update(jobs).set({ metadata: expr, updatedAt: new Date() }).where(eq(jobs.id, id)).returning();
  if (!row) throw notFound("Job not found");
  return row;
}

// --- Tasks ---------------------------------------------------------------------

export function listTasks(jobId: string) {
  return db
    .select({ ...getTableColumns(jobTasks), assigneeEntityName: entities.name })
    .from(jobTasks)
    .leftJoin(entities, eq(jobTasks.assigneeEntityId, entities.id))
    .where(eq(jobTasks.jobId, jobId))
    .orderBy(asc(jobTasks.sequence), asc(jobTasks.createdAt));
}

async function loadTask(jobId: string, taskId: string): Promise<JobTask> {
  const [row] = await db
    .select()
    .from(jobTasks)
    .where(and(eq(jobTasks.id, taskId), eq(jobTasks.jobId, jobId)))
    .limit(1);
  if (!row) throw notFound("Task not found on this job");
  return row;
}

function assertKind(kind: string): void {
  if (!isTaskKind(kind)) {
    const known = taskKindList()
      .map((k) => k.kind)
      .join(", ");
    throw badRequest(`Unknown task kind "${kind}". Use one of: ${known}.`);
  }
}

/** The columns a status change sets, given who made it. */
function statusColumns(
  to: JobTaskStatus,
  current: Pick<JobTask, "startedAt">,
  by: string | null,
  now: Date,
): Partial<typeof jobTasks.$inferInsert> {
  const set: Partial<typeof jobTasks.$inferInsert> = { status: to };
  if ((to === "doing" || to === "done") && !current.startedAt) set.startedAt = now;
  if (to === "done") {
    set.completedAt = now;
    set.completedBy = by;
  } else {
    set.completedAt = null;
    set.completedBy = null;
  }
  return set;
}

export async function addTask(jobId: string, input: TaskInput, actor: Actor): Promise<JobTask> {
  await loadJob(jobId);
  const kind = input.kind ?? "custom";
  assertKind(kind);
  const title = clean(input.title);
  if (!title) throw badRequest("A task needs a title.");
  let sequence = input.sequence;
  if (sequence === undefined) {
    const [{ max } = { max: 0 }] = await db
      .select({ max: sql<number>`coalesce(max(${jobTasks.sequence}), 0)::int` })
      .from(jobTasks)
      .where(eq(jobTasks.jobId, jobId));
    sequence = max + 1;
  }
  const now = new Date();
  const [row] = await db
    .insert(jobTasks)
    .values({
      jobId,
      kind,
      title,
      sequence,
      assigneeEntityId: input.assigneeEntityId ?? null,
      assigneeUserOid: input.assigneeUserOid ?? null,
      dueAt: toDate(input.dueAt),
      notes: clean(input.notes),
      ...(input.status ? statusColumns(input.status, { startedAt: null }, actor.userOid, now) : {}),
    })
    .returning();
  return row!;
}

export async function updateTask(
  jobId: string,
  taskId: string,
  patch: Partial<TaskInput>,
  actor: Actor,
): Promise<JobTask> {
  const current = await loadTask(jobId, taskId);
  const set: Partial<typeof jobTasks.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) {
    const title = clean(patch.title);
    if (!title) throw badRequest("A task needs a title.");
    set.title = title;
  }
  if (patch.kind !== undefined) {
    assertKind(patch.kind);
    set.kind = patch.kind;
  }
  if (patch.sequence !== undefined) set.sequence = patch.sequence;
  if (patch.assigneeEntityId !== undefined) set.assigneeEntityId = patch.assigneeEntityId;
  if (patch.assigneeUserOid !== undefined) set.assigneeUserOid = patch.assigneeUserOid;
  if (patch.dueAt !== undefined) set.dueAt = toDate(patch.dueAt);
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  if (patch.status !== undefined && patch.status !== current.status) {
    Object.assign(set, statusColumns(patch.status, current, actor.name ?? actor.userOid, new Date()));
  }
  const [row] = await db.update(jobTasks).set(set).where(eq(jobTasks.id, taskId)).returning();
  if (set.status) {
    await emitTaskStatus({ task: row!, previousStatus: current.status, userOid: actor.userOid });
  }
  return row!;
}

export async function deleteTask(jobId: string, taskId: string): Promise<void> {
  await loadTask(jobId, taskId);
  await db.delete(jobTasks).where(eq(jobTasks.id, taskId));
}

/**
 * Mark every open task of a kind done: how a later feature closes its task
 * when its own work finishes (an inspection completed, a packet signed).
 * Returns the tasks it changed.
 */
export async function completeTasksByKind(jobId: string, kind: string, actor: Actor): Promise<JobTask[]> {
  const open = await db
    .select()
    .from(jobTasks)
    .where(and(eq(jobTasks.jobId, jobId), eq(jobTasks.kind, kind), inArray(jobTasks.status, ["todo", "doing"])));
  const done: JobTask[] = [];
  for (const task of open) done.push(await updateTask(jobId, task.id, { status: "done" }, actor));
  return done;
}

/**
 * Keep tasks that follow a stage in step with the manifest: the first line to
 * reach a stage starts its task, the last one finishes it. Reaching a stage
 * also counts for every stage before it (placing a line delivers it), so all
 * the linked tasks up to `stage` are checked. Only ever moves a task forward,
 * and leaves skipped tasks alone, so a person's call stands. Runs inside the
 * stage-change transaction; returns the events to emit after it commits.
 */
export async function syncStageTasks(
  ex: Executor,
  jobId: string,
  stage: ProgressStage,
  by: string | null,
): Promise<TaskEvent[]> {
  const followed = PROGRESS_STAGES.slice(1, PROGRESS_STAGES.indexOf(stage) + 1);
  const kindStage = new Map(followed.flatMap((s) => taskKindsForStage(s).map((k) => [k, s] as const)));
  if (kindStage.size === 0) return [];
  const tasks = await ex
    .select()
    .from(jobTasks)
    .where(
      and(
        eq(jobTasks.jobId, jobId),
        inArray(jobTasks.kind, [...kindStage.keys()]),
        inArray(jobTasks.status, ["todo", "doing"]),
      ),
    );
  if (tasks.length === 0) return [];

  const stages = await ex
    .select({ stage: jobItems.stage, n: sql<number>`count(*)::int` })
    .from(jobItems)
    .where(eq(jobItems.jobId, jobId))
    .groupBy(jobItems.stage);
  const total = stages.reduce((a, s) => a + s.n, 0);
  const reachedBy = (target: ProgressStage) =>
    stages.filter((s) => hasReached(s.stage, target)).reduce((a, s) => a + s.n, 0);

  const events: TaskEvent[] = [];
  const now = new Date();
  for (const task of tasks) {
    const reached = reachedBy(kindStage.get(task.kind)!);
    if (reached === 0) continue;
    const to: JobTaskStatus = reached === total ? "done" : "doing";
    if (task.status === to) continue;
    const [row] = await ex
      .update(jobTasks)
      .set({ ...statusColumns(to, task, by, now), updatedAt: now })
      .where(eq(jobTasks.id, task.id))
      .returning();
    events.push({ task: row!, previousStatus: task.status, userOid: null });
  }
  return events;
}
