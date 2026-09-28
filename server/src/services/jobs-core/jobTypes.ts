import { asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { jobTypes, type JobTaskTemplateEntry, type JobType } from "../../db/schema";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { isTaskKind, taskKindList } from "./model";
import { clean } from "./shared";

/**
 * Job types: what an organisation calls its kinds of work ("IT relocation",
 * "Library move", "Decommission"), each with the task list a new job starts
 * with. Administered from Settings; read by everyone creating a job.
 */

export type JobTypeInput = {
  name: string;
  color?: string;
  description?: string | null;
  taskTemplate?: JobTaskTemplateEntry[];
  active?: boolean;
};

const nameTaken = (err: unknown) => isUniqueViolation(err, "uq_job_types_name");

/** Reject template steps whose kind nothing knows about. */
export function normalizeTemplate(template: JobTaskTemplateEntry[]): JobTaskTemplateEntry[] {
  const out: JobTaskTemplateEntry[] = [];
  for (const [i, step] of template.entries()) {
    const kind = step.kind.trim();
    if (!isTaskKind(kind)) {
      const known = taskKindList()
        .map((k) => k.kind)
        .join(", ");
      throw badRequest(`Step ${i + 1} has an unknown task kind "${kind}". Use one of: ${known}.`);
    }
    const title = step.title.trim();
    if (!title) throw badRequest(`Step ${i + 1} needs a title.`);
    out.push({ kind, title });
  }
  return out;
}

export function listJobTypes(opts: { includeInactive?: boolean } = {}) {
  return db
    .select()
    .from(jobTypes)
    .where(opts.includeInactive ? undefined : eq(jobTypes.active, true))
    .orderBy(asc(jobTypes.name));
}

export async function getJobType(id: string): Promise<JobType> {
  const [row] = await db.select().from(jobTypes).where(eq(jobTypes.id, id)).limit(1);
  if (!row) throw notFound("Job type not found");
  return row;
}

export async function createJobType(input: JobTypeInput): Promise<JobType> {
  const name = clean(input.name);
  if (!name) throw badRequest("A job type needs a name.");
  try {
    const [row] = await db
      .insert(jobTypes)
      .values({
        name,
        color: input.color ?? "#0284c7",
        description: clean(input.description),
        taskTemplate: normalizeTemplate(input.taskTemplate ?? []),
        active: input.active ?? true,
      })
      .returning();
    return row!;
  } catch (err) {
    if (nameTaken(err)) throw conflict(`There is already a job type called "${name}".`);
    throw err;
  }
}

export async function updateJobType(id: string, patch: Partial<JobTypeInput>): Promise<JobType> {
  const set: Partial<typeof jobTypes.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = clean(patch.name);
    if (!name) throw badRequest("A job type needs a name.");
    set.name = name;
  }
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.description !== undefined) set.description = clean(patch.description);
  if (patch.taskTemplate !== undefined) set.taskTemplate = normalizeTemplate(patch.taskTemplate);
  if (patch.active !== undefined) set.active = patch.active;
  try {
    const [row] = await db.update(jobTypes).set(set).where(eq(jobTypes.id, id)).returning();
    if (!row) throw notFound("Job type not found");
    return row;
  } catch (err) {
    if (nameTaken(err)) throw conflict(`There is already a job type called "${set.name}".`);
    throw err;
  }
}

/** Jobs of a deleted type keep their tasks and lose only the label. */
export async function deleteJobType(id: string): Promise<void> {
  const deleted = await db.delete(jobTypes).where(eq(jobTypes.id, id)).returning({ id: jobTypes.id });
  if (!deleted.length) throw notFound("Job type not found");
}

/**
 * Per-type configuration for a later feature, stored under its own key in
 * `settings` so features never overwrite each other. `value` undefined removes
 * the key.
 */
export async function setJobTypeSetting(id: string, feature: string, value: unknown): Promise<JobType> {
  const expr =
    value === undefined
      ? sql`${jobTypes.settings} - ${feature}`
      : sql`${jobTypes.settings} || jsonb_build_object(${feature}::text, ${JSON.stringify(value)}::jsonb)`;
  const [row] = await db
    .update(jobTypes)
    .set({ settings: expr, updatedAt: new Date() })
    .where(eq(jobTypes.id, id))
    .returning();
  if (!row) throw notFound("Job type not found");
  return row;
}

export async function getJobTypeSetting<T = unknown>(id: string, feature: string): Promise<T | undefined> {
  const type = await getJobType(id);
  return type.settings[feature] as T | undefined;
}
