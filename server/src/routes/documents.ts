import { Router, raw, type Request, type Response } from "express";
import { z } from "zod";
import { currentUser, requireAdmin } from "../auth/middleware";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { asyncHandler, param, parse } from "../lib/http";
import { getConfig } from "../services/config";
import * as docs from "../services/documents";
import { listJobTypes, listJobs, listPhases, listProjects } from "../services/jobs-core";

/**
 * /api/documents, /api/document-templates, /api/document-fields and
 * /api/document-packets. One router, so api.ts gains a single mount line; the
 * whole set answers 404 while the "documents" feature is switched off.
 */

const actor = (req: Request): docs.Actor => {
  const user = currentUser(req);
  return { userOid: user.oid, name: user.name };
};

const isAdmin = (req: Request) => !req.apiKeyUser && req.session.user?.role === "admin";

const q = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** The viewer's time zone for dates, as the print routes take it. */
const tz = (req: Request, body?: { tz?: string }) => body?.tz ?? q(req, "tz") ?? "UTC";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function qId(req: Request, name: string): string | undefined {
  const v = q(req, name);
  if (v === undefined || UUID.test(v)) return v;
  throw badRequest(`${name} must be an id.`);
}

/** A malformed id is a record that does not exist, not a database error. */
function uuidParams(router: Router, ...names: string[]) {
  for (const name of names) {
    router.param(name, (_req, _res, next, value: string) => next(UUID.test(value) ? undefined : notFound("Not found")));
  }
  return router;
}

function sendPdf(res: Response, body: Buffer, filename: string, inline: boolean) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename.replace(/"/g, "")}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(body);
}

/**
 * parse(), but the message says which block and which part of it is wrong,
 * so the template editor can show it as it is.
 */
function parseBody<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const messages = result.error.issues.slice(0, 3).map((issue) => {
    const [top, index] = issue.path;
    const block = top === "body" && typeof index === "number" ? `Block ${index + 1}` : null;
    const last = issue.path[issue.path.length - 1];
    const part = typeof last === "string" && last !== "body" ? last : null;
    return `${[block, part].filter(Boolean).join(", ")}${block || part ? ": " : ""}${issue.message}.`;
  });
  throw badRequest(messages.join(" "), result.error.flatten());
}

const uuid = z.string().uuid();
const tzField = z.string().max(64).optional();

// --- Custom field library ----------------------------------------------------------

const customFieldSchema = z.object({
  key: z.string().regex(docs.FIELD_KEY, "Use lowercase letters, digits and underscores, starting with a letter"),
  label: z.string().trim().min(1).max(200),
  type: z.enum(docs.FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  multiline: z.boolean().optional(),
  placeholder: z.string().max(200).nullish(),
  help: z.string().max(500).nullish(),
  statement: z.string().max(2000).nullish(),
  min: z.number().finite().nullish(),
  max: z.number().finite().nullish(),
  active: z.boolean().optional(),
});

const fieldsRouter = uuidParams(Router(), "id");

fieldsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await docs.listCustomFields({ includeInactive: q(req, "all") === "true" }));
  }),
);
fieldsRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await docs.createCustomField(parse(customFieldSchema, req.body)));
  }),
);
fieldsRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await docs.updateCustomField(param(req, "id"), parse(customFieldSchema.partial(), req.body)));
  }),
);
fieldsRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await docs.deleteCustomField(param(req, "id"));
    res.status(204).end();
  }),
);

// --- Templates -------------------------------------------------------------------------

const templateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  active: z.boolean().optional(),
  title: z.string().max(300).optional(),
  body: docs.bodySchema.optional(),
});

const previewSchema = z.object({
  title: z.string().max(300).optional(),
  body: docs.bodySchema,
  /** A real job to merge; without one the sample job is used. */
  jobId: uuid.nullish(),
  values: z.record(z.unknown()).optional(),
  tz: tzField,
});

async function preview(input: z.infer<typeof previewSchema>, timeZone: string) {
  const [context, tables, fmt, terms] = await Promise.all([
    input.jobId ? docs.mergeContext(input.jobId) : docs.sampleMergeContext(),
    docs.tableData(input.body, input.jobId ?? null, { sample: !input.jobId }),
    docs.formatting(timeZone),
    docs.instanceTerms(),
  ]);
  const model = docs.buildRenderModel({
    title: input.title ?? "",
    body: input.body,
    values: input.values ?? {},
    context,
    tables,
    today: docs.todayIn(fmt.timeZone),
    document: { id: "preview", title: input.title ?? "" },
    fmt,
    terms,
  });
  return { model, fmt, problems: docs.checkBody(input.body, { publishing: true }) };
}

const templatesRouter = uuidParams(Router(), "id");

templatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await docs.listTemplates({ includeInactive: q(req, "all") === "true" }));
  }),
);
templatesRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await docs.createTemplate(parseBody(templateSchema, req.body), actor(req).userOid));
  }),
);
templatesRouter.post(
  "/preview",
  asyncHandler(async (req, res) => {
    const input = parseBody(previewSchema, req.body);
    const { model, problems } = await preview(input, tz(req, input));
    res.json({ ...model, problems });
  }),
);
templatesRouter.post(
  "/preview.pdf",
  asyncHandler(async (req, res) => {
    const input = parseBody(previewSchema, req.body);
    const { model, fmt } = await preview(input, tz(req, input));
    const config = await getConfig();
    const pdf = await docs.renderDocumentPdf({
      model,
      documentId: "preview",
      status: "draft",
      contentHash: null,
      kicker: config.orgName || config.appName,
      details: [input.jobId ? "Preview with a real job" : "Preview with a sample job"],
      record: [],
      signatureImages: new Map(),
      at: new Date(),
      fmt,
    });
    sendPdf(res, pdf, "preview.pdf", true);
  }),
);
templatesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await docs.getTemplate(param(req, "id")));
  }),
);
templatesRouter.get(
  "/:id/versions/:version",
  asyncHandler(async (req, res) => {
    const n = Number(param(req, "version"));
    if (!Number.isInteger(n) || n < 1) throw notFound("Not found");
    res.json(await docs.getVersionByNumber(param(req, "id"), n));
  }),
);
templatesRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await docs.updateTemplate(param(req, "id"), parseBody(templateSchema.partial(), req.body)));
  }),
);
templatesRouter.post(
  "/:id/publish",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const who = actor(req);
    const result = await docs.publishTemplate(param(req, "id"), who.userOid);
    res.json(result.template);
  }),
);
templatesRouter.delete(
  "/:id/draft",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await docs.discardDraft(param(req, "id")));
  }),
);
templatesRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await docs.deleteTemplate(param(req, "id"));
    res.status(204).end();
  }),
);

// --- Packets ---------------------------------------------------------------------------

const packetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  templateIds: z.array(uuid).max(50),
  conditions: docs.conditionsSchema.optional(),
  autoAttach: z.boolean().optional(),
  active: z.boolean().optional(),
});

const packetsRouter = uuidParams(Router(), "id");

packetsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await docs.listPackets());
  }),
);
/** Pickers for the condition editor: job types, projects and their phases. */
packetsRouter.get(
  "/options",
  asyncHandler(async (_req, res) => {
    const [jobTypes, projects] = await Promise.all([listJobTypes({ includeInactive: true }), listProjects()]);
    const phases = await Promise.all(projects.map((p) => listPhases(p.id)));
    res.json({
      jobTypes: jobTypes.map((t) => ({ id: t.id, name: t.name, color: t.color, active: t.active })),
      projects: projects.map((p, i) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        phases: phases[i]!.map((ph) => ({ id: ph.id, name: ph.name })),
      })),
      ruleFields: docs.RULE_FIELDS,
      ruleOps: docs.RULE_OPS,
    });
  }),
);
packetsRouter.post(
  "/test",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ conditions: docs.conditionsSchema, jobId: uuid }), req.body);
    res.json(await docs.testConditions(input.conditions, input.jobId));
  }),
);
packetsRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await docs.createPacket(parse(packetSchema, req.body), actor(req)));
  }),
);
packetsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await docs.getPacket(param(req, "id")));
  }),
);
packetsRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await docs.updatePacket(param(req, "id"), parse(packetSchema.partial(), req.body)));
  }),
);
packetsRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await docs.deletePacket(param(req, "id"));
    res.status(204).end();
  }),
);
packetsRouter.post(
  "/:id/apply",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await docs.applyPacketToOpenJobs(param(req, "id"), actor(req)));
  }),
);

// --- Documents ---------------------------------------------------------------------------

const documentRoutes = uuidParams(Router(), "id", "jobId", "packetId");

documentRoutes.get(
  "/meta",
  asyncHandler(async (_req, res) => {
    const [config, terms] = await Promise.all([getConfig(), docs.instanceTerms()]);
    res.json({
      fieldTypes: docs.FIELD_TYPES,
      blockTypes: docs.BLOCK_TYPES,
      statuses: docs.DOCUMENT_STATUSES,
      tableSources: docs.tableSources().map(({ load: _load, sample: _sample, ...s }) => ({
        ...s,
        columns: s.columns.map((c) => ({ key: c.key, label: docs.columnLabel(c, terms) })),
      })),
      mergeFields: docs.MERGE_CATALOG,
      share: await docs.shareAvailability(),
      jobs: config.features.jobs,
    });
  }),
);
/** Jobs to pick from (for a new document, a preview, a condition test). */
documentRoutes.get(
  "/jobs",
  asyncHandler(async (req, res) => {
    if (!(await getConfig()).features.jobs) return void res.json([]);
    const rows = await listJobs({ q: q(req, "q") });
    res.json(
      rows.slice(0, 100).map((j) => ({ id: j.id, code: j.code, name: j.name, status: j.status, jobTypeName: j.jobTypeName })),
    );
  }),
);
documentRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = q(req, "status");
    if (status && !(docs.DOCUMENT_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`status must be one of ${docs.DOCUMENT_STATUSES.join(", ")}.`);
    }
    res.json(
      await docs.listDocuments({
        jobId: qId(req, "jobId"),
        templateId: qId(req, "templateId"),
        status: status as (typeof docs.DOCUMENT_STATUSES)[number] | undefined,
        q: q(req, "q"),
        limit: Number(q(req, "limit") ?? 200) || 200,
      }),
    );
  }),
);
documentRoutes.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parse(
      z.object({ templateId: uuid, jobId: uuid.nullish(), copyFromId: uuid.optional() }),
      req.body,
    );
    const who = actor(req);
    const doc = await docs.createDocument({ templateId: input.templateId, jobId: input.jobId ?? null }, who);
    if (input.copyFromId) await docs.copyFrom(doc.id, input.copyFromId, {});
    res.status(201).json(await docs.getDocumentDetail(doc.id, tz(req)));
  }),
);

// A PDF someone holds: the body is the file. Answers which export it is.
documentRoutes.post(
  "/verify-pdf",
  raw({ type: () => true, limit: "32mb" }),
  asyncHandler(async (req, res) => {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw badRequest("Send the PDF itself as the request body, with Content-Type application/pdf.");
    }
    res.json(await docs.verifyPdf(body));
  }),
);

documentRoutes.get(
  "/job/:jobId",
  asyncHandler(async (req, res) => {
    res.json(await docs.jobDocuments(param(req, "jobId")));
  }),
);
documentRoutes.post(
  "/job/:jobId/sync",
  asyncHandler(async (req, res) => {
    const result = await docs.syncJobPackets(param(req, "jobId"), actor(req));
    if (!result) throw notFound("Job not found");
    res.json(result);
  }),
);
documentRoutes.post(
  "/job/:jobId/packets",
  asyncHandler(async (req, res) => {
    const { packetId } = parse(z.object({ packetId: uuid }), req.body);
    res.status(201).json(await docs.attachPacket(param(req, "jobId"), packetId, actor(req)));
  }),
);
documentRoutes.delete(
  "/job/:jobId/packets/:packetId",
  asyncHandler(async (req, res) => {
    res.json(await docs.detachPacket(param(req, "jobId"), param(req, "packetId"), actor(req)));
  }),
);

documentRoutes.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await docs.getDocumentDetail(param(req, "id"), tz(req)));
  }),
);
documentRoutes.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ values: z.record(z.unknown()).optional(), title: z.string().max(300).optional() }), req.body);
    const row = await docs.saveValues(param(req, "id"), input, actor(req));
    res.json({ id: row.id, values: row.values, title: row.title, status: row.status, updatedAt: row.updatedAt });
  }),
);
documentRoutes.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await docs.deleteDocument(param(req, "id"), { ...actor(req), isAdmin: isAdmin(req) });
    res.status(204).end();
  }),
);
documentRoutes.get(
  "/:id/copy-sources",
  asyncHandler(async (req, res) => {
    res.json(await docs.copySources(param(req, "id")));
  }),
);
documentRoutes.post(
  "/:id/copy-from",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ sourceId: uuid, overwrite: z.boolean().optional() }), req.body);
    const result = await docs.copyFrom(param(req, "id"), input.sourceId, { overwrite: input.overwrite });
    res.json({ copied: result.copied, skipped: result.skipped, values: result.document.values });
  }),
);
documentRoutes.post(
  "/:id/duplicate",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ jobId: uuid.nullish() }), req.body ?? {});
    const row = await docs.duplicateDocument(param(req, "id"), { jobId: input.jobId }, actor(req));
    res.status(201).json(await docs.getDocumentDetail(row.id, tz(req)));
  }),
);
documentRoutes.post(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ tz: tzField }), req.body ?? {});
    await docs.completeDocument(param(req, "id"), actor(req), tz(req, input));
    res.json(await docs.getDocumentDetail(param(req, "id"), tz(req, input)));
  }),
);
documentRoutes.post(
  "/:id/reopen",
  asyncHandler(async (req, res) => {
    await docs.reopenDocument(param(req, "id"), actor(req));
    res.json(await docs.getDocumentDetail(param(req, "id"), tz(req)));
  }),
);
documentRoutes.post(
  "/:id/signatures",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ fieldKey: z.string().regex(docs.FIELD_KEY), signatureId: uuid }), req.body);
    await docs.attachSignature(param(req, "id"), input, actor(req));
    res.json(await docs.getDocumentDetail(param(req, "id"), tz(req)));
  }),
);
documentRoutes.get(
  "/:id/verify",
  asyncHandler(async (req, res) => {
    res.json(await docs.verifyDocument(param(req, "id")));
  }),
);
documentRoutes.get(
  "/:id/pdf",
  asyncHandler(async (req, res) => {
    const result = await docs.documentPdf(param(req, "id"), { timeZone: tz(req), actor: actor(req) });
    res.setHeader("X-Document-Sha256", result.sha256);
    if (result.exportId) res.setHeader("X-Document-Export", result.exportId);
    sendPdf(res, result.bytes, result.filename, q(req, "download") !== "1");
  }),
);
documentRoutes.post(
  "/:id/share",
  asyncHandler(async (req, res) => {
    const input = parse(
      z.object({
        email: z.string().email().max(320).nullish(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
        allowSigning: z.boolean().optional(),
      }),
      req.body ?? {},
    );
    const detail = await docs.getDocumentDetail(param(req, "id"));
    const result = await docs.shareDocument(
      { documentId: detail.document.id, jobId: detail.document.jobId, ...input },
      actor(req),
    );
    if (!result) {
      throw new HttpError(404, "share_unavailable", "Sharing needs the external portal, which is not set up on this instance.");
    }
    res.json(result);
  }),
);

// --- Mount ---------------------------------------------------------------------------------

export const documentsRouter = Router();

const PATHS = ["/documents", "/document-templates", "/document-fields", "/document-packets"];

documentsRouter.use(
  PATHS,
  asyncHandler(async (_req, _res, next) => {
    if (!(await getConfig()).features.documents) {
      throw new HttpError(404, "feature_disabled", "Documents are switched off. An administrator can turn them on in Settings.");
    }
    next();
  }),
);
documentsRouter.use("/document-fields", fieldsRouter);
documentsRouter.use("/document-templates", templatesRouter);
documentsRouter.use("/document-packets", packetsRouter);
documentsRouter.use("/documents", documentRoutes);

