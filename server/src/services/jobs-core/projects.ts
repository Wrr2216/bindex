import { and, asc, desc, eq, getTableColumns, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  companies,
  entities,
  jobs,
  projectPhases,
  projects,
  type Project,
  type ProjectPhase,
  type ProjectStatus,
} from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { withFreshCode } from "./codes";
import { listJobs } from "./jobs";
import { progressByProject } from "./progress";
import { assertDateOrder, clean, type Actor } from "./shared";

/**
 * Projects: a client engagement that runs as several jobs, often in phases
 * (floor 3 this weekend, floors 4 and 5 the next). A project holds nothing a
 * job does not; it is how staged, multi-site moves stay reconciled in one
 * place.
 */

export type ProjectInput = {
  name: string;
  companyId?: string | null;
  entityId?: string | null;
  status?: ProjectStatus;
  startsOn?: string | null;
  endsOn?: string | null;
  notes?: string | null;
};

export type PhaseInput = {
  name: string;
  sequence?: number;
  startsOn?: string | null;
  endsOn?: string | null;
  notes?: string | null;
};

export async function listProjects(opts: { status?: ProjectStatus; q?: string } = {}) {
  const q = opts.q?.trim();
  const rows = await db
    .select({
      ...getTableColumns(projects),
      companyName: companies.name,
      entityName: entities.name,
      jobCount: sql<number>`(SELECT count(*)::int FROM jobs j WHERE j.project_id = ${projects.id})`,
      phaseCount: sql<number>`(SELECT count(*)::int FROM project_phases p WHERE p.project_id = ${projects.id})`,
    })
    .from(projects)
    .leftJoin(companies, eq(projects.companyId, companies.id))
    .leftJoin(entities, eq(projects.entityId, entities.id))
    .where(
      and(
        opts.status ? eq(projects.status, opts.status) : undefined,
        q ? or(ilike(projects.name, `%${q}%`), ilike(projects.code, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(desc(projects.createdAt));
  const progress = await progressByProject(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, progress: progress.get(r.id) ?? null }));
}

export async function getProjectRow(id: string): Promise<Project> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!row) throw notFound("Project not found");
  return row;
}

/** A project with its phases and jobs, for the project page. */
export async function getProject(id: string) {
  const [row] = await db
    .select({ ...getTableColumns(projects), companyName: companies.name, entityName: entities.name })
    .from(projects)
    .leftJoin(companies, eq(projects.companyId, companies.id))
    .leftJoin(entities, eq(projects.entityId, entities.id))
    .where(eq(projects.id, id))
    .limit(1);
  if (!row) throw notFound("Project not found");
  const [phases, projectJobs, progress] = await Promise.all([
    listPhases(id),
    listJobs({ projectId: id }),
    progressByProject([id]),
  ]);
  return { ...row, phases, jobs: projectJobs, progress: progress.get(id) ?? null };
}

export async function createProject(input: ProjectInput, actor: Actor): Promise<Project> {
  const name = clean(input.name);
  if (!name) throw badRequest("A project needs a name.");
  assertDateOrder(input.startsOn, input.endsOn, "The project");
  return withFreshCode("project", "uq_projects_code", async (code) => {
    const [row] = await db
      .insert(projects)
      .values({
        code,
        name,
        companyId: input.companyId ?? null,
        entityId: input.entityId ?? null,
        status: input.status ?? "planned",
        startsOn: input.startsOn ?? null,
        endsOn: input.endsOn ?? null,
        notes: clean(input.notes),
        createdBy: actor.userOid,
      })
      .returning();
    return row!;
  });
}

export async function updateProject(id: string, patch: Partial<ProjectInput>): Promise<Project> {
  const current = await getProjectRow(id);
  const set: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = clean(patch.name);
    if (!name) throw badRequest("A project needs a name.");
    set.name = name;
  }
  if (patch.companyId !== undefined) set.companyId = patch.companyId;
  if (patch.entityId !== undefined) set.entityId = patch.entityId;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.startsOn !== undefined) set.startsOn = patch.startsOn;
  if (patch.endsOn !== undefined) set.endsOn = patch.endsOn;
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  assertDateOrder(
    set.startsOn !== undefined ? set.startsOn : current.startsOn,
    set.endsOn !== undefined ? set.endsOn : current.endsOn,
    "The project",
  );
  const [row] = await db.update(projects).set(set).where(eq(projects.id, id)).returning();
  return row!;
}

/**
 * Only an empty project can be deleted. Silently detaching its jobs would
 * leave work in flight with nothing tying it together.
 */
export async function deleteProject(id: string): Promise<void> {
  await getProjectRow(id);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.projectId, id));
  if (n > 0) {
    throw badRequest(`This project still has ${n} job${n === 1 ? "" : "s"}. Delete or move them first.`);
  }
  await db.delete(projects).where(eq(projects.id, id));
}

// --- Phases -------------------------------------------------------------------

export function listPhases(projectId: string) {
  return db
    .select({
      ...getTableColumns(projectPhases),
      jobCount: sql<number>`(SELECT count(*)::int FROM jobs j WHERE j.phase_id = ${projectPhases.id})`,
    })
    .from(projectPhases)
    .where(eq(projectPhases.projectId, projectId))
    .orderBy(asc(projectPhases.sequence), asc(projectPhases.createdAt));
}

async function loadPhase(projectId: string, phaseId: string): Promise<ProjectPhase> {
  const [row] = await db
    .select()
    .from(projectPhases)
    .where(and(eq(projectPhases.id, phaseId), eq(projectPhases.projectId, projectId)))
    .limit(1);
  if (!row) throw notFound("Phase not found on this project");
  return row;
}

export async function addPhase(projectId: string, input: PhaseInput): Promise<ProjectPhase> {
  await getProjectRow(projectId);
  const name = clean(input.name);
  if (!name) throw badRequest("A phase needs a name.");
  assertDateOrder(input.startsOn, input.endsOn, "The phase");
  let sequence = input.sequence;
  if (sequence === undefined) {
    const [{ max } = { max: 0 }] = await db
      .select({ max: sql<number>`coalesce(max(${projectPhases.sequence}), 0)::int` })
      .from(projectPhases)
      .where(eq(projectPhases.projectId, projectId));
    sequence = max + 1;
  }
  const [row] = await db
    .insert(projectPhases)
    .values({
      projectId,
      name,
      sequence,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      notes: clean(input.notes),
    })
    .returning();
  return row!;
}

export async function updatePhase(projectId: string, phaseId: string, patch: Partial<PhaseInput>) {
  const current = await loadPhase(projectId, phaseId);
  const set: Partial<typeof projectPhases.$inferInsert> = {};
  if (patch.name !== undefined) {
    const name = clean(patch.name);
    if (!name) throw badRequest("A phase needs a name.");
    set.name = name;
  }
  if (patch.sequence !== undefined) set.sequence = patch.sequence;
  if (patch.startsOn !== undefined) set.startsOn = patch.startsOn;
  if (patch.endsOn !== undefined) set.endsOn = patch.endsOn;
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  assertDateOrder(
    set.startsOn !== undefined ? set.startsOn : current.startsOn,
    set.endsOn !== undefined ? set.endsOn : current.endsOn,
    "The phase",
  );
  if (Object.keys(set).length === 0) return current;
  const [row] = await db.update(projectPhases).set(set).where(eq(projectPhases.id, phaseId)).returning();
  return row!;
}

/** The phase's jobs stay on the project, just without a phase. */
export async function deletePhase(projectId: string, phaseId: string): Promise<void> {
  await loadPhase(projectId, phaseId);
  await db.delete(projectPhases).where(eq(projectPhases.id, phaseId));
}
