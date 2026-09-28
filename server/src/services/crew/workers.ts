import { and, asc, desc, eq, getTableColumns, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { attachments, crewCheckins, crewWorkers, jobs, type ComplianceLight, type CrewWorker } from "../../db/schema";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { credentialTypesByKey } from "./credentialTypes";
import { asFacts, credentialsForWorkers, type CredentialRow } from "./credentials";
import { crewEvent } from "./events";
import { assessCredential, describeAssessment, shiftMinutes, standing, type CredentialCheck } from "./model";
import { clean, isForeignKeyViolation, withFreshBadge, type CrewActor } from "./shared";

/**
 * Workers: the people who turn up on jobs, with the badge that checks them in.
 * A worker with hours on file is retired (active: false), not deleted, so
 * timesheets keep their names.
 */

export type WorkerInput = {
  name: string;
  company?: string | null;
  role?: string | null;
  /** Left out on create: a CRW-… code is generated. */
  badgeCode?: string;
  phone?: string | null;
  active?: boolean;
  notes?: string | null;
  /** A photo attachment of this worker, printed on the badge. Null clears it. */
  photoAttachmentId?: string | null;
};

export type WorkerFilters = {
  q?: string;
  company?: string;
  /** Undefined lists everyone. */
  active?: boolean;
  /** The worst standing of their credentials; "none" for someone with none on file. */
  light?: ComplianceLight | "none";
  /** Holds a credential of this type key, in any state. */
  credentialType?: string;
  /** Has a credential expired, or expiring within this many days. */
  expiringWithin?: number;
};

export type OpenCheckin = { checkinId: string; jobId: string; jobCode: string; jobName: string; since: Date };

export type WorkerSummary = CrewWorker & {
  photoUrl: string | null;
  light: ComplianceLight | null;
  checks: CredentialCheck[];
  nextExpiry: { typeName: string; expiresOn: string; daysLeft: number } | null;
  onJob: OpenCheckin | null;
};

const BADGE_MAX = 64;

function normalizeBadge(raw: string): string {
  const code = raw.trim();
  if (!code) throw badRequest("A badge code cannot be empty. Leave it out to have one generated.");
  if (code.length > BADGE_MAX) throw badRequest(`A badge code can be at most ${BADGE_MAX} characters.`);
  // A scan of the printed QR carries a link to /crew/badge/<code>; a code that
  // itself looked like such a link could never be told apart from one.
  if (/[\s/]/.test(code)) throw badRequest("A badge code cannot contain spaces or slashes.");
  return code;
}

const photoUrl = (id: string | null, w = 160) => (id ? `/api/attachments/${id}/thumb?w=${w}` : null);

function workerQuery() {
  return db
    .select({ ...getTableColumns(crewWorkers), photoId: attachments.id })
    .from(crewWorkers)
    .leftJoin(attachments, eq(attachments.id, crewWorkers.photoAttachmentId));
}

export async function loadWorker(id: string): Promise<CrewWorker> {
  const [row] = await db.select().from(crewWorkers).where(eq(crewWorkers.id, id)).limit(1);
  if (!row) throw notFound("Worker not found");
  return row;
}

/** Badge codes are compared without regard to case: readers and people type them differently. */
export async function findWorkerByBadge(code: string): Promise<CrewWorker | null> {
  const [row] = await db
    .select()
    .from(crewWorkers)
    .where(sql`lower(${crewWorkers.badgeCode}) = lower(${code.trim()})`)
    .limit(1);
  return row ?? null;
}

async function openCheckins(workerIds: string[] | null): Promise<Map<string, OpenCheckin>> {
  const rows = await db
    .select({
      checkinId: crewCheckins.id,
      workerId: crewCheckins.workerId,
      jobId: crewCheckins.jobId,
      jobCode: jobs.code,
      jobName: jobs.name,
      since: crewCheckins.checkedInAt,
    })
    .from(crewCheckins)
    .innerJoin(jobs, eq(jobs.id, crewCheckins.jobId))
    .where(isNull(crewCheckins.checkedOutAt));
  const wanted = workerIds ? new Set(workerIds) : null;
  return new Map(
    rows
      .filter((r) => !wanted || wanted.has(r.workerId))
      .map(({ workerId, ...rest }) => [workerId, rest]),
  );
}

function summarize(
  worker: CrewWorker & { photoId: string | null },
  credentials: CredentialRow[],
  types: Map<string, { name: string; warnDays: number }>,
  today: string,
  onJob: OpenCheckin | null,
): WorkerSummary {
  const { photoId, ...rest } = worker;
  const { light, checks } = standing(credentials.map(asFacts), types, today);
  const upcoming = checks
    .filter((c) => c.expiresOn && c.daysLeft !== null)
    .sort((a, b) => a.daysLeft! - b.daysLeft!)[0];
  return {
    ...rest,
    photoUrl: photoUrl(photoId),
    light,
    checks,
    nextExpiry: upcoming ? { typeName: upcoming.typeName, expiresOn: upcoming.expiresOn!, daysLeft: upcoming.daysLeft! } : null,
    onJob,
  };
}

export async function listWorkers(filters: WorkerFilters, today: string): Promise<{ workers: WorkerSummary[]; companies: string[] }> {
  const conds: (SQL | undefined)[] = [];
  const q = filters.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(
      or(
        ilike(crewWorkers.name, like),
        ilike(crewWorkers.badgeCode, like),
        ilike(crewWorkers.company, like),
        ilike(crewWorkers.role, like),
        ilike(crewWorkers.phone, like),
      ),
    );
  }
  if (filters.company) conds.push(sql`lower(${crewWorkers.company}) = lower(${filters.company.trim()})`);
  if (filters.active !== undefined) conds.push(eq(crewWorkers.active, filters.active));

  const [rows, companyRows, typeMap] = await Promise.all([
    workerQuery()
      .where(and(...conds))
      .orderBy(asc(sql`lower(${crewWorkers.name})`))
      .limit(2000),
    db
      .selectDistinct({ company: crewWorkers.company })
      .from(crewWorkers)
      .where(sql`${crewWorkers.company} IS NOT NULL`)
      .orderBy(asc(crewWorkers.company)),
    credentialTypesByKey(),
  ]);
  const ids = rows.map((r) => r.id);
  const [credentials, onJob] = await Promise.all([credentialsForWorkers(ids), openCheckins(ids)]);

  let workers = rows.map((w) => summarize(w, credentials.get(w.id) ?? [], typeMap, today, onJob.get(w.id) ?? null));
  if (filters.light) {
    workers = workers.filter((w) => (filters.light === "none" ? w.light === null : w.light === filters.light));
  }
  if (filters.credentialType) {
    const key = filters.credentialType;
    workers = workers.filter((w) => w.checks.some((c) => c.typeKey === key));
  }
  if (filters.expiringWithin !== undefined) {
    const days = filters.expiringWithin;
    workers = workers.filter((w) => w.checks.some((c) => c.daysLeft !== null && c.daysLeft <= days));
  }
  return { workers, companies: companyRows.map((c) => c.company!).filter(Boolean) };
}

export type CredentialView = CredentialRow & { light: ComplianceLight; reason: string; label: string; daysLeft: number | null };

export async function getWorker(id: string, today: string) {
  const [row] = await workerQuery().where(eq(crewWorkers.id, id)).limit(1);
  if (!row) throw notFound("Worker not found");
  const [credentialMap, typeMap, onJob, history] = await Promise.all([
    credentialsForWorkers([id]),
    credentialTypesByKey(),
    openCheckins([id]),
    db
      .select({ ...getTableColumns(crewCheckins), jobCode: jobs.code, jobName: jobs.name })
      .from(crewCheckins)
      .innerJoin(jobs, eq(jobs.id, crewCheckins.jobId))
      .where(eq(crewCheckins.workerId, id))
      .orderBy(desc(crewCheckins.checkedInAt))
      .limit(50),
  ]);
  const credentials = credentialMap.get(id) ?? [];
  const summary = summarize(row, credentials, typeMap, today, onJob.get(id) ?? null);
  const now = new Date();
  const [totals] = await db
    .select({
      shifts: sql<number>`count(*)::int`,
      minutes: sql<number>`coalesce(sum(greatest(0, floor(extract(epoch from (coalesce(${crewCheckins.checkedOutAt}, now()) - ${crewCheckins.checkedInAt})) / 60) - ${crewCheckins.breakMinutes})), 0)::int`,
    })
    .from(crewCheckins)
    .where(eq(crewCheckins.workerId, id));
  return {
    ...summary,
    photoLargeUrl: photoUrl(row.photoId, 480),
    credentials: credentials.map((c): CredentialView => {
      const a = assessCredential(asFacts(c), c.warnDays, today);
      return { ...c, light: a.light, reason: a.reason, label: describeAssessment(a, c.expiresOn), daysLeft: a.daysLeft };
    }),
    checkins: history.map((h) => ({
      ...h,
      minutes: shiftMinutes(h.checkedInAt, h.checkedOutAt, h.breakMinutes, now),
    })),
    totals: totals ?? { shifts: 0, minutes: 0 },
  };
}

async function checkPhoto(workerId: string, attachmentId: string | null | undefined): Promise<void> {
  if (!attachmentId) return;
  const [a] = await db
    .select({ ownerType: attachments.ownerType, ownerId: attachments.ownerId, kind: attachments.kind })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  if (!a || a.ownerType !== "crew_worker" || a.ownerId !== workerId) {
    throw badRequest("That photo is not one of this worker's. Upload it to the worker first.");
  }
  if (a.kind !== "photo") throw badRequest("The badge picture has to be a photo.");
}

function badgeTaken(err: unknown, code: string | undefined): Error | null {
  return isUniqueViolation(err, "uq_crew_workers_badge")
    ? conflict(`Badge ${code ?? ""} is already assigned to someone else. Use a different code, or leave it blank to generate one.`)
    : null;
}

export async function createWorker(input: WorkerInput, actor: CrewActor): Promise<CrewWorker> {
  const name = clean(input.name);
  if (!name) throw badRequest("A worker needs a name.");
  const values = {
    name,
    company: clean(input.company),
    role: clean(input.role),
    phone: clean(input.phone),
    active: input.active ?? true,
    notes: clean(input.notes),
    createdBy: actor.userOid,
  };
  const given = input.badgeCode !== undefined && input.badgeCode.trim() !== "" ? normalizeBadge(input.badgeCode) : null;
  let row: CrewWorker;
  try {
    row = given
      ? (await db.insert(crewWorkers).values({ ...values, badgeCode: given }).returning())[0]!
      : await withFreshBadge(async (badgeCode) => (await db.insert(crewWorkers).values({ ...values, badgeCode }).returning())[0]!);
  } catch (err) {
    throw badgeTaken(err, given ?? undefined) ?? err;
  }
  logger.info("crew.worker.created", { workerId: row.id });
  await crewEvent("crew.worker_created", { name: row.name, company: row.company, role: row.role }, actor, {
    type: "crew_worker",
    id: row.id,
  });
  return row;
}

export async function updateWorker(id: string, patch: Partial<WorkerInput>, actor: CrewActor): Promise<CrewWorker> {
  const current = await loadWorker(id);
  const set: Partial<typeof crewWorkers.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = clean(patch.name);
    if (!name) throw badRequest("A worker needs a name.");
    set.name = name;
  }
  if (patch.company !== undefined) set.company = clean(patch.company);
  if (patch.role !== undefined) set.role = clean(patch.role);
  if (patch.phone !== undefined) set.phone = clean(patch.phone);
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  if (patch.badgeCode !== undefined) set.badgeCode = normalizeBadge(patch.badgeCode);
  if (patch.photoAttachmentId !== undefined) {
    await checkPhoto(id, patch.photoAttachmentId);
    set.photoAttachmentId = patch.photoAttachmentId;
  }
  let row: CrewWorker;
  try {
    [row] = (await db.update(crewWorkers).set(set).where(eq(crewWorkers.id, id)).returning()) as [CrewWorker];
  } catch (err) {
    throw badgeTaken(err, set.badgeCode) ?? err;
  }
  const changed = (Object.keys(set) as (keyof typeof set)[]).filter(
    (k) => k !== "updatedAt" && String(set[k] ?? "") !== String(current[k as keyof CrewWorker] ?? ""),
  );
  if (changed.length) {
    await crewEvent("crew.worker_updated", { name: row.name, changed, active: row.active }, actor, { type: "crew_worker", id });
  }
  return row;
}

/** A lost badge: issue a new code, and the old card stops checking anyone in. */
export async function reissueBadge(id: string, actor: CrewActor): Promise<CrewWorker> {
  await loadWorker(id);
  const row = await withFreshBadge(async (badgeCode) => {
    const [r] = await db.update(crewWorkers).set({ badgeCode, updatedAt: new Date() }).where(eq(crewWorkers.id, id)).returning();
    return r!;
  });
  logger.info("crew.worker.badge_reissued", { workerId: id });
  await crewEvent("crew.worker_updated", { name: row.name, changed: ["badgeCode"], reissued: true, active: row.active }, actor, {
    type: "crew_worker",
    id,
  });
  return row;
}

export async function deleteWorker(id: string, actor: CrewActor): Promise<void> {
  const worker = await loadWorker(id);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(crewCheckins)
    .where(eq(crewCheckins.workerId, id));
  if (n > 0) {
    throw conflict(
      `${worker.name} has ${n} check-in${n === 1 ? "" : "s"} on timesheets. Mark them inactive instead, so their hours keep a name.`,
    );
  }
  try {
    await db.delete(crewWorkers).where(eq(crewWorkers.id, id));
  } catch (err) {
    // Checked in between the count and the delete.
    if (isForeignKeyViolation(err)) throw conflict(`${worker.name} was just checked in. Mark them inactive instead.`);
    throw err;
  }
  logger.info("crew.worker.deleted", { workerId: id });
  await crewEvent("crew.worker_deleted", { name: worker.name, company: worker.company }, actor, { type: "crew_worker", id });
}
