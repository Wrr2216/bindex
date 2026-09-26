import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  documentTemplateVersions,
  documentTemplates,
  documents,
  type DocumentTemplate,
  type DocumentTemplateVersion,
} from "../../db/schema";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { bodySchema, checkBody, type Block, type BodyProblem } from "./model";
import type { Executor } from "./shared";

/**
 * Templates and their versions.
 *
 * A template has at most one draft version, which the editor saves into, and
 * any number of published ones. Saving over a published template starts a
 * new draft (the next version number) from the edit; publishing freezes it.
 * New documents always start from the latest published version and keep
 * pointing at it, so a later edit never changes a document already started.
 */

export type TemplateInput = {
  name: string;
  description?: string | null;
  active?: boolean;
  /** The printed title; may hold merge fields. Defaults to the name. */
  title?: string;
  body?: Block[];
};

export type Version = Omit<DocumentTemplateVersion, "body"> & { body: Block[] };

/** A stored body, validated on the way out so a hand-edited row cannot crash a screen. */
export function readBody(raw: unknown, where: string): Block[] {
  const parsed = bodySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger.warn("documents.body.invalid", { where, issues: parsed.error.issues.length });
  return [];
}

const version = (row: DocumentTemplateVersion): Version => ({ ...row, body: readBody(row.body, row.id) });

const nameTaken = (err: unknown) => isUniqueViolation(err, "uq_document_templates_name");

const clean = (s: string | null | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

export async function listTemplates(opts: { includeInactive?: boolean } = {}) {
  const rows = await db
    .select({
      id: documentTemplates.id,
      name: documentTemplates.name,
      description: documentTemplates.description,
      active: documentTemplates.active,
      createdAt: documentTemplates.createdAt,
      updatedAt: documentTemplates.updatedAt,
      latestVersion: sql<number>`(SELECT max(v.version)::int FROM document_template_versions v WHERE v.template_id = ${documentTemplates.id})`,
      publishedVersion: sql<number | null>`(SELECT max(v.version)::int FROM document_template_versions v WHERE v.template_id = ${documentTemplates.id} AND v.status = 'published')`,
      hasDraft: sql<boolean>`EXISTS (SELECT 1 FROM document_template_versions v WHERE v.template_id = ${documentTemplates.id} AND v.status = 'draft')`,
      documentCount: sql<number>`(SELECT count(*)::int FROM documents d WHERE d.template_id = ${documentTemplates.id})`,
    })
    .from(documentTemplates)
    .where(opts.includeInactive ? undefined : eq(documentTemplates.active, true))
    .orderBy(asc(documentTemplates.name));
  return rows;
}

export async function loadTemplate(id: string, ex: Executor = db): Promise<DocumentTemplate> {
  const [row] = await ex.select().from(documentTemplates).where(eq(documentTemplates.id, id)).limit(1);
  if (!row) throw notFound("Template not found");
  return row;
}

export async function latestPublished(templateId: string, ex: Executor = db): Promise<Version | null> {
  const [row] = await ex
    .select()
    .from(documentTemplateVersions)
    .where(and(eq(documentTemplateVersions.templateId, templateId), eq(documentTemplateVersions.status, "published")))
    .orderBy(desc(documentTemplateVersions.version))
    .limit(1);
  return row ? version(row) : null;
}

async function draftOf(templateId: string, ex: Executor = db): Promise<Version | null> {
  const [row] = await ex
    .select()
    .from(documentTemplateVersions)
    .where(and(eq(documentTemplateVersions.templateId, templateId), eq(documentTemplateVersions.status, "draft")))
    .limit(1);
  return row ? version(row) : null;
}

export async function getVersion(id: string, ex: Executor = db): Promise<Version> {
  const [row] = await ex.select().from(documentTemplateVersions).where(eq(documentTemplateVersions.id, id)).limit(1);
  if (!row) throw notFound("Template version not found");
  return version(row);
}

export async function getVersionByNumber(templateId: string, n: number): Promise<Version> {
  const [row] = await db
    .select()
    .from(documentTemplateVersions)
    .where(and(eq(documentTemplateVersions.templateId, templateId), eq(documentTemplateVersions.version, n)))
    .limit(1);
  if (!row) throw notFound(`Version ${n} of this template does not exist.`);
  return version(row);
}

/**
 * The template with the version the editor works on (the draft, or else the
 * latest published), what is live, the history, and anything that would stop
 * the draft being published.
 */
export async function getTemplate(id: string) {
  const template = await loadTemplate(id);
  const versions = await db
    .select({
      id: documentTemplateVersions.id,
      version: documentTemplateVersions.version,
      status: documentTemplateVersions.status,
      title: documentTemplateVersions.title,
      publishedAt: documentTemplateVersions.publishedAt,
      publishedBy: documentTemplateVersions.publishedBy,
      updatedAt: documentTemplateVersions.updatedAt,
      documentCount: sql<number>`(SELECT count(*)::int FROM documents d WHERE d.template_version_id = ${documentTemplateVersions.id})`,
    })
    .from(documentTemplateVersions)
    .where(eq(documentTemplateVersions.templateId, id))
    .orderBy(desc(documentTemplateVersions.version));
  const [draft, published] = await Promise.all([draftOf(id), latestPublished(id)]);
  const editing = draft ?? published;
  const problems: BodyProblem[] = editing ? checkBody(editing.body, { publishing: true }) : [];
  return { ...template, draft, published, editing, versions, problems };
}

export async function createTemplate(input: TemplateInput, userOid: string | null) {
  const name = clean(input.name);
  if (!name) throw badRequest("A template needs a name.");
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(documentTemplates)
        .values({ name, description: clean(input.description), active: input.active ?? true, createdBy: userOid })
        .returning();
      await tx.insert(documentTemplateVersions).values({
        templateId: row!.id,
        version: 1,
        status: "draft",
        title: clean(input.title) ?? name,
        body: input.body ?? [],
      });
      return row!.id;
    });
    logger.info("documents.template.created", { templateId: id });
    return getTemplate(id);
  } catch (err) {
    if (nameTaken(err)) throw conflict(`There is already a template called "${name}".`);
    throw err;
  }
}

/**
 * Change the name or description, and save the body into the draft. A
 * template whose latest version is published gets a new draft, numbered
 * after the highest version, holding the edit.
 */
export async function updateTemplate(id: string, patch: Partial<TemplateInput>) {
  try {
    await db.transaction(async (tx) => {
      // Serialises edits to one template, so two saves cannot both start a draft.
      await tx.execute(sql`SELECT 1 FROM document_templates WHERE id = ${id} FOR UPDATE`);
      const template = await loadTemplate(id, tx);
      const set: Partial<typeof documentTemplates.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) {
        const name = clean(patch.name);
        if (!name) throw badRequest("A template needs a name.");
        set.name = name;
      }
      if (patch.description !== undefined) set.description = clean(patch.description);
      if (patch.active !== undefined) set.active = patch.active;
      await tx.update(documentTemplates).set(set).where(eq(documentTemplates.id, template.id));

      if (patch.body === undefined && patch.title === undefined) return;
      const draft = await draftOf(id, tx);
      if (draft) {
        await tx
          .update(documentTemplateVersions)
          .set({
            ...(patch.body !== undefined ? { body: patch.body } : {}),
            ...(patch.title !== undefined ? { title: clean(patch.title) ?? template.name } : {}),
            updatedAt: new Date(),
          })
          .where(eq(documentTemplateVersions.id, draft.id));
        return;
      }
      const published = await latestPublished(id, tx);
      const [{ next } = { next: 1 }] = await tx
        .select({ next: sql<number>`coalesce(max(${documentTemplateVersions.version}), 0)::int + 1` })
        .from(documentTemplateVersions)
        .where(eq(documentTemplateVersions.templateId, id));
      await tx.insert(documentTemplateVersions).values({
        templateId: id,
        version: next,
        status: "draft",
        title: patch.title !== undefined ? clean(patch.title) ?? template.name : published?.title ?? template.name,
        body: patch.body ?? published?.body ?? [],
      });
      logger.info("documents.template.draft_started", { templateId: id, version: next });
    });
  } catch (err) {
    if (nameTaken(err)) throw conflict(`There is already a template called "${patch.name?.trim()}".`);
    throw err;
  }
  return getTemplate(id);
}

/** Freeze the draft as the version new documents start from. */
export async function publishTemplate(id: string, userOid: string | null) {
  const published = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM document_templates WHERE id = ${id} FOR UPDATE`);
    await loadTemplate(id, tx);
    const draft = await draftOf(id, tx);
    if (!draft) throw conflict("There are no unpublished changes. Edit the template first.");
    const problems = checkBody(draft.body, { publishing: true });
    if (problems.length) {
      throw badRequest(`Fix these before publishing: ${problems.map((p) => p.message).join(" ")}`, { problems });
    }
    const [row] = await tx
      .update(documentTemplateVersions)
      .set({ status: "published", publishedAt: new Date(), publishedBy: userOid, updatedAt: new Date() })
      .where(eq(documentTemplateVersions.id, draft.id))
      .returning();
    return row!;
  });
  logger.info("documents.template.published", { templateId: id, version: published.version });
  return { template: await getTemplate(id), version: version(published) };
}

/** Throw away unpublished changes. A template that was never published has nothing to fall back to. */
export async function discardDraft(id: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM document_templates WHERE id = ${id} FOR UPDATE`);
    await loadTemplate(id, tx);
    const draft = await draftOf(id, tx);
    if (!draft) throw conflict("There are no unpublished changes to discard.");
    if (!(await latestPublished(id, tx))) {
      throw conflict("This template has never been published, so there is nothing to go back to. Delete the template instead.");
    }
    await tx.delete(documentTemplateVersions).where(eq(documentTemplateVersions.id, draft.id));
  });
  return getTemplate(id);
}

/** Only a template no document uses can go; one in use can be switched off instead. */
export async function deleteTemplate(id: string): Promise<void> {
  await loadTemplate(id);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.templateId, id));
  if (n > 0) {
    throw conflict(`${n} document${n === 1 ? " uses" : "s use"} this template. Switch it off instead, so no new ones are started.`);
  }
  await db.delete(documentTemplates).where(eq(documentTemplates.id, id));
  logger.info("documents.template.deleted", { templateId: id });
}
