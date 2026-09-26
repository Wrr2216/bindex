import { and, asc, desc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import {
  documentExports,
  documentPackets,
  documentTemplateVersions,
  documentTemplates,
  documents,
  jobs,
  type DocumentRow,
  type DocumentStatus,
} from "../../db/schema";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { getSignature, listSignatures, verifySignature } from "../media-ai-core";
import { documentContentHash, signingContent, type ContentInput } from "./content";
import { mergeContext, tableData, takeSnapshot, todayIn } from "./context";
import { emitDocumentEvent } from "./events";
import { buildRenderModel, type RenderModel, type Snapshot } from "./layout";
import { resolveMerge, type Formatting, type MergeContext } from "./merge";
import { fieldsOf, isSigningType, statementFor, type FieldDef } from "./model";
import type { Actor, Executor } from "./shared";
import { getVersion, latestPublished, loadTemplate, type Version } from "./templates";
import { applyValuesPatch, copyValues, isSignatureValue, missingRequired, type SignatureValue, type Values } from "./values";

/**
 * Filled-in documents: start one from a template, autosave values, copy from
 * another document, complete (values fixed, job data frozen, content hashed),
 * sign each signature field, verify.
 */

export async function formatting(timeZone: string | undefined): Promise<Formatting> {
  const config = await getConfig();
  return { timeZone: timeZone || "UTC", locale: config.locale || "en-US" };
}

export async function loadDocument(id: string, ex: Executor = db): Promise<DocumentRow> {
  const [row] = await ex.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!row) throw notFound("Document not found");
  return row;
}

async function lockDocument(id: string, ex: Executor): Promise<DocumentRow> {
  await ex.execute(sql`SELECT 1 FROM documents WHERE id = ${id} FOR UPDATE`);
  return loadDocument(id, ex);
}

function assertDraft(doc: DocumentRow) {
  if (doc.status !== "draft") {
    throw conflict(
      doc.status === "signed"
        ? "This document is signed and can no longer change. Duplicate it to start a new draft."
        : "This document is completed. Reopen it to change its values.",
    );
  }
}

export type DocumentFilters = { jobId?: string; templateId?: string; status?: DocumentStatus; q?: string; limit?: number };

export async function listDocuments(f: DocumentFilters = {}) {
  const q = f.q?.trim();
  const where: SQL | undefined = and(
    f.jobId ? eq(documents.jobId, f.jobId) : undefined,
    f.templateId ? eq(documents.templateId, f.templateId) : undefined,
    f.status ? eq(documents.status, f.status) : undefined,
    q ? or(ilike(documents.title, `%${q}%`), ilike(jobs.code, `%${q}%`), ilike(jobs.name, `%${q}%`)) : undefined,
  );
  return db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      templateId: documents.templateId,
      templateName: documentTemplates.name,
      version: documentTemplateVersions.version,
      jobId: documents.jobId,
      jobCode: jobs.code,
      jobName: jobs.name,
      packetId: documents.packetId,
      packetName: documentPackets.name,
      position: documents.position,
      contentHash: documents.contentHash,
      filledCount: sql<number>`(SELECT count(*)::int FROM jsonb_object_keys(${documents.values}))`,
      completedAt: documents.completedAt,
      signedAt: documents.signedAt,
      createdBy: documents.createdBy,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .innerJoin(documentTemplates, eq(documents.templateId, documentTemplates.id))
    .innerJoin(documentTemplateVersions, eq(documents.templateVersionId, documentTemplateVersions.id))
    .leftJoin(jobs, eq(documents.jobId, jobs.id))
    .leftJoin(documentPackets, eq(documents.packetId, documentPackets.id))
    .where(where)
    .orderBy(f.jobId ? asc(documents.position) : desc(documents.updatedAt), asc(documents.createdAt))
    .limit(Math.min(Math.max(f.limit ?? 200, 1), 1000));
}

export type CreateInput = {
  templateId: string;
  jobId?: string | null;
  packetId?: string | null;
  position?: number;
  values?: Values;
  copiedFrom?: string | null;
};

/**
 * Start a document from the template's latest published version. `context`
 * lets a caller creating several for one job (a packet) read the job once.
 */
export async function createDocument(
  input: CreateInput,
  actor: Actor,
  opts: { ex?: Executor; context?: MergeContext; emit?: boolean } = {},
): Promise<DocumentRow> {
  const ex = opts.ex ?? db;
  const template = await loadTemplate(input.templateId, ex);
  const version = await latestPublished(template.id, ex);
  if (!version) throw conflict(`"${template.name}" has not been published yet. Publish it before starting documents from it.`);
  if (input.jobId) {
    const [job] = await ex.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1);
    if (!job) throw notFound("Job not found");
  }
  const context = opts.context ?? (await mergeContext(input.jobId ?? null));
  // The list title is the printed title with merge fields as they read today.
  const title = resolveMerge(version.title, { ...context, document: { id: "", title: "" }, today: todayIn("UTC"), field: {} }).text.trim()
    || template.name;
  const [row] = await ex
    .insert(documents)
    .values({
      templateId: template.id,
      templateVersionId: version.id,
      jobId: input.jobId ?? null,
      packetId: input.packetId ?? null,
      position: input.position ?? 0,
      title: title.slice(0, 300),
      values: input.values ?? {},
      copiedFrom: input.copiedFrom ?? null,
      createdBy: actor.userOid,
    })
    .returning();
  logger.info("documents.document.created", { documentId: row!.id, templateId: template.id, jobId: input.jobId ?? null });
  if (opts.emit !== false) {
    await emitDocumentEvent(
      "document.created",
      { type: "document", id: row!.id },
      { title: row!.title, templateId: template.id, version: version.version, jobId: row!.jobId, packetId: row!.packetId },
      actor,
    );
  }
  return row!;
}

function contentInput(doc: DocumentRow, version: Version, values: Values = doc.values, snapshot = doc.snapshot as Snapshot | null): ContentInput {
  return {
    documentId: doc.id,
    templateId: doc.templateId,
    templateVersionId: version.id,
    version: version.version,
    title: doc.title,
    fields: fieldsOf(version.body),
    values,
    snapshot,
  };
}

/** The render model: live job data for a draft, the frozen snapshot once completed. */
export async function renderModel(doc: DocumentRow, version: Version, fmt: Formatting): Promise<RenderModel> {
  const snapshot = doc.snapshot as Snapshot | null;
  const [context, tables] = snapshot
    ? [snapshot.context, snapshot.tables]
    : await Promise.all([mergeContext(doc.jobId), tableData(version.body, doc.jobId)]);
  return buildRenderModel({
    title: version.title,
    body: version.body,
    values: doc.values,
    context,
    tables,
    today: snapshot?.today ?? todayIn(fmt.timeZone),
    document: { id: doc.id, title: doc.title },
    fmt,
  });
}

/** Everything the fill screen needs in one request. */
export async function getDocumentDetail(id: string, timeZone?: string) {
  const doc = await loadDocument(id);
  const [version, template, fmt, signatures, exports] = await Promise.all([
    getVersion(doc.templateVersionId),
    loadTemplate(doc.templateId),
    formatting(timeZone),
    listSignatures("document", doc.id),
    db
      .select()
      .from(documentExports)
      .where(eq(documentExports.documentId, doc.id))
      .orderBy(desc(documentExports.createdAt))
      .limit(20),
  ]);
  const [render, job, packet] = await Promise.all([
    renderModel(doc, version, fmt),
    doc.jobId
      ? db
          .select({ id: jobs.id, code: jobs.code, name: jobs.name, status: jobs.status })
          .from(jobs)
          .where(eq(jobs.id, doc.jobId))
          .then((r) => r[0] ?? null)
      : null,
    doc.packetId
      ? db
          .select({ id: documentPackets.id, name: documentPackets.name })
          .from(documentPackets)
          .where(eq(documentPackets.id, doc.packetId))
          .then((r) => r[0] ?? null)
      : null,
  ]);
  // What each signature field's signer signs, once the content is fixed.
  const signing =
    doc.status !== "draft" && doc.contentHash
      ? Object.fromEntries(
          fieldsOf(version.body)
            .filter((f) => isSigningType(f.type))
            .map((f) => [
              f.key,
              { statement: statementFor(f), content: signingContent(doc.id, version.id, doc.contentHash!, f.key) },
            ]),
        )
      : null;
  const latest = await latestPublished(doc.templateId);
  return {
    document: doc,
    template: { id: template.id, name: template.name, latestVersion: latest?.version ?? null },
    version: { id: version.id, version: version.version, title: version.title, body: version.body },
    job,
    packet,
    render,
    signatures,
    signing,
    exports,
  };
}

/** Autosave. Only drafts change; keys present are set, keys absent kept. */
export async function saveValues(id: string, patch: { values?: Values; title?: string }, actor: Actor) {
  return db.transaction(async (tx) => {
    const doc = await lockDocument(id, tx);
    assertDraft(doc);
    const version = await getVersion(doc.templateVersionId, tx);
    const set: Partial<typeof documents.$inferInsert> = { updatedAt: new Date() };
    if (patch.values) {
      const { values, problems } = applyValuesPatch(fieldsOf(version.body), doc.values, patch.values);
      if (problems.length) {
        throw badRequest(problems.map((p) => `${labelOf(version, p.key)}: ${p.message}`).join(" "), { problems });
      }
      set.values = values;
    }
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw badRequest("A document needs a title.");
      set.title = title.slice(0, 300);
    }
    const [row] = await tx.update(documents).set(set).where(eq(documents.id, id)).returning();
    logger.debug("documents.document.saved", { documentId: id, by: actor.userOid, keys: Object.keys(patch.values ?? {}).length });
    return row!;
  });
}

const labelOf = (version: Version, key: string) => fieldsOf(version.body).find((f) => f.key === key)?.label ?? key;

/**
 * Fill a draft from another document: every field with the same key whose
 * value fits. Signatures are never copied.
 */
export async function copyFrom(id: string, sourceId: string, opts: { overwrite?: boolean }) {
  if (id === sourceId) throw badRequest("Pick a different document to copy from.");
  const source = await loadDocument(sourceId);
  return db.transaction(async (tx) => {
    const doc = await lockDocument(id, tx);
    assertDraft(doc);
    const version = await getVersion(doc.templateVersionId, tx);
    const result = copyValues(fieldsOf(version.body), doc.values, source.values, opts);
    const [row] = await tx
      .update(documents)
      .set({ values: result.values, copiedFrom: sourceId, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    logger.info("documents.document.copied", { documentId: id, sourceId, copied: result.copied.length });
    return { document: row!, copied: result.copied, skipped: result.skipped };
  });
}

/**
 * Earlier documents worth copying from: the same template first, then any
 * other with at least one field key in common, newest first.
 */
export async function copySources(id: string) {
  const doc = await loadDocument(id);
  const version = await getVersion(doc.templateVersionId);
  const keys = fieldsOf(version.body)
    .filter((f) => !isSigningType(f.type))
    .map((f) => f.key);
  if (!keys.length) return [];
  // Keys are lowercase identifiers (FIELD_KEY), so this array literal needs no quoting.
  const keyArray = `{${keys.join(",")}}`;
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      templateId: documents.templateId,
      templateName: documentTemplates.name,
      jobCode: jobs.code,
      jobName: jobs.name,
      updatedAt: documents.updatedAt,
      shared: sql<number>`(SELECT count(*)::int FROM jsonb_object_keys(${documents.values}) k WHERE k = ANY(${keyArray}::text[]))`,
    })
    .from(documents)
    .innerJoin(documentTemplates, eq(documents.templateId, documentTemplates.id))
    .leftJoin(jobs, eq(documents.jobId, jobs.id))
    .where(and(ne(documents.id, id), sql`${documents.values} ?| ${keyArray}::text[]`))
    .orderBy(sql`(${documents.templateId} = ${doc.templateId}) DESC`, desc(documents.updatedAt))
    .limit(30);
  return rows;
}

/** A new draft with this document's values (not its signatures), on the same or another job. */
export async function duplicateDocument(id: string, opts: { jobId?: string | null }, actor: Actor) {
  const source = await loadDocument(id);
  const jobId = opts.jobId === undefined ? source.jobId : opts.jobId;
  const doc = await createDocument({ templateId: source.templateId, jobId, copiedFrom: source.id }, actor);
  const version = await getVersion(doc.templateVersionId);
  const { values, copied } = copyValues(fieldsOf(version.body), {}, source.values);
  const [row] = await db.update(documents).set({ values }).where(eq(documents.id, doc.id)).returning();
  logger.info("documents.document.duplicated", { documentId: doc.id, sourceId: id, copied: copied.length });
  return row!;
}

/**
 * Fix the values: every required field (other than signatures) must be
 * filled. The job data is frozen into the snapshot and the content hashed.
 */
export async function completeDocument(id: string, actor: Actor, timeZone: string) {
  const doc = await loadDocument(id);
  assertDraft(doc);
  const version = await getVersion(doc.templateVersionId);
  const fields = fieldsOf(version.body);
  const missing = missingRequired(fields, doc.values, { signing: false });
  if (missing.length) {
    throw badRequest(`Fill in ${missing.map((f) => `"${f.label}"`).join(", ")} before completing.`, {
      missing: missing.map((f) => f.key),
    });
  }
  // Read outside the lock: it can be slow for a large manifest, and nothing it
  // reads belongs to the document.
  const snapshot = await takeSnapshot(version.body, doc.jobId, timeZone);
  const row = await db.transaction(async (tx) => {
    const current = await lockDocument(id, tx);
    assertDraft(current);
    if (JSON.stringify(current.values) !== JSON.stringify(doc.values) || current.title !== doc.title) {
      throw conflict("Someone changed this document while it was being completed. Check it and complete it again.");
    }
    const hash = documentContentHash(contentInput(current, version, current.values, snapshot));
    const [updated] = await tx
      .update(documents)
      .set({
        status: "completed",
        snapshot: snapshot as unknown as Record<string, unknown>,
        contentHash: hash,
        completedAt: new Date(),
        completedBy: actor.name ?? actor.userOid,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, id))
      .returning();
    return updated!;
  });
  logger.info("documents.document.completed", { documentId: id, contentHash: row.contentHash });
  await emitDocumentEvent("document.completed", { type: "document", id }, { title: row.title, contentHash: row.contentHash, jobId: row.jobId }, actor);
  return row;
}

/** Back to draft, while nobody has signed: a signature would no longer match. */
export async function reopenDocument(id: string, actor: Actor) {
  const row = await db.transaction(async (tx) => {
    const doc = await lockDocument(id, tx);
    if (doc.status === "draft") throw conflict("This document is already a draft.");
    const version = await getVersion(doc.templateVersionId, tx);
    const signed = fieldsOf(version.body).some((f) => isSigningType(f.type) && isSignatureValue(doc.values[f.key]));
    if (doc.status === "signed" || signed) {
      throw conflict("Someone has signed this document, so it cannot be reopened. Duplicate it to start a new draft.");
    }
    const [updated] = await tx
      .update(documents)
      .set({ status: "draft", snapshot: null, contentHash: null, completedAt: null, completedBy: null, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    return updated!;
  });
  await emitDocumentEvent("document.reopened", { type: "document", id }, { title: row.title }, actor);
  return row;
}

/**
 * Put a signature (captured by the signing dialog against this document) into
 * its field. The signature must belong to this document and must have signed
 * exactly the statement the server expects for this field; anything else is
 * refused. When every required signature field is signed the document is.
 */
export async function attachSignature(id: string, input: { fieldKey: string; signatureId: string }, actor: Actor) {
  const signature = await getSignature(input.signatureId);
  if (!signature || signature.ownerType !== "document" || signature.ownerId !== id) {
    throw badRequest("That signature was not made on this document. Sign again from the document.");
  }
  const result = await db.transaction(async (tx) => {
    const doc = await lockDocument(id, tx);
    if (doc.status === "draft" || !doc.contentHash) throw conflict("Complete the document before signing it.");
    const version = await getVersion(doc.templateVersionId, tx);
    const fields = fieldsOf(version.body);
    const field = fields.find((f) => f.key === input.fieldKey);
    if (!field || !isSigningType(field.type)) throw badRequest("This document has no signature field with that key.");
    if (isSignatureValue(doc.values[field.key])) throw conflict(`"${field.label}" is already signed.`);
    const check = await verifySignature(input.signatureId, signingContent(doc.id, version.id, doc.contentHash, field.key));
    if (!check.valid) {
      throw badRequest("That signature does not match this document as it stands. Reload the document and sign again.");
    }
    const value: SignatureValue = {
      signatureId: signature.id,
      signerName: signature.signerName,
      signerRole: signature.signerRole,
      signedAt: new Date(signature.signedAt).toISOString(),
    };
    const values = { ...doc.values, [field.key]: value };
    const done = allSigned(fields, values);
    const [updated] = await tx
      .update(documents)
      .set({
        values,
        status: done ? "signed" : doc.status,
        signedAt: done ? doc.signedAt ?? new Date() : doc.signedAt,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, id))
      .returning();
    return { row: updated!, field };
  });
  logger.info("documents.document.signed", { documentId: id, field: input.fieldKey, status: result.row.status });
  await emitDocumentEvent(
    "document.signed",
    { type: "document", id },
    {
      title: result.row.title,
      field: result.field.key,
      fieldLabel: result.field.label,
      signatureId: signature.id,
      signerName: signature.signerName,
      status: result.row.status,
      contentHash: result.row.contentHash,
    },
    actor,
  );
  return result.row;
}

/** Signed: every required signature field has a signature, and there is at least one. */
export function allSigned(fields: FieldDef[], values: Values): boolean {
  const signing = fields.filter((f) => isSigningType(f.type));
  const signed = signing.filter((f) => isSignatureValue(values[f.key]));
  return signed.length > 0 && signing.every((f) => !f.required || isSignatureValue(values[f.key]));
}

export type VerifyReport = {
  documentId: string;
  status: DocumentStatus;
  valid: boolean;
  content: { storedHash: string | null; currentHash: string | null; matches: boolean };
  signatures: { field: string; label: string; signatureId: string; signerName: string; valid: boolean; reason: string }[];
};

/**
 * Check a document against itself: its stored values and snapshot still hash
 * to the recorded content hash, and every signature still verifies against
 * that hash (which also checks each signature image is intact).
 */
export async function verifyDocument(id: string): Promise<VerifyReport> {
  const doc = await loadDocument(id);
  const version = await getVersion(doc.templateVersionId);
  if (doc.status === "draft" || !doc.contentHash) {
    return {
      documentId: id,
      status: doc.status,
      valid: false,
      content: { storedHash: null, currentHash: null, matches: false },
      signatures: [],
    };
  }
  const currentHash = documentContentHash(contentInput(doc, version));
  const matches = currentHash === doc.contentHash;
  const signatures: VerifyReport["signatures"] = [];
  for (const field of fieldsOf(version.body).filter((f) => isSigningType(f.type))) {
    const value = doc.values[field.key];
    if (!isSignatureValue(value)) continue;
    let valid = false;
    let reason = "missing";
    try {
      const r = await verifySignature(value.signatureId, signingContent(doc.id, version.id, currentHash, field.key));
      valid = r.valid;
      reason = r.reason;
    } catch {
      reason = "signature_missing";
    }
    signatures.push({ field: field.key, label: field.label, signatureId: value.signatureId, signerName: value.signerName, valid, reason });
  }
  return {
    documentId: id,
    status: doc.status,
    valid: matches && signatures.every((s) => s.valid),
    content: { storedHash: doc.contentHash, currentHash, matches },
    signatures,
  };
}

/** Drafts go freely; a completed or signed document only by an administrator. */
export async function deleteDocument(id: string, actor: Actor & { isAdmin: boolean }) {
  const doc = await loadDocument(id);
  if (doc.status !== "draft" && !actor.isAdmin) {
    throw conflict(`This document is ${doc.status}. Only an administrator can delete it.`);
  }
  await db.delete(documents).where(eq(documents.id, id));
  logger.info("documents.document.deleted", { documentId: id, status: doc.status });
  await emitDocumentEvent("document.deleted", { type: "document", id }, { title: doc.title, status: doc.status, jobId: doc.jobId, contentHash: doc.contentHash }, actor);
}
