import { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { currentUser } from "../auth/middleware";
import { env } from "../env";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { asyncHandler, param, parse } from "../lib/http";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";
import { getConfig } from "../services/config";
import { getAttachmentStream, thumbnail } from "../services/media-ai-core";
import {
  AREAS,
  AREA_LABEL,
  INSPECTION_KINDS,
  INSPECTION_STATUSES,
  KIND_LABEL,
  SEVERITIES,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  SHARE_DEFAULT_DAYS,
  SHARE_MAX_DAYS,
  SIGNOFF_LABEL,
  SIGNOFF_ROLES,
  SPOTS,
  SPOT_LABEL,
  STATUS_LABEL,
  addFinding,
  buildReport,
  completeInspection,
  createInspection,
  createShare,
  deleteInspection,
  getComparison,
  getInspectionDetail,
  inspectionPdf,
  listInspections,
  listShares,
  loadInspection,
  loadReportImage,
  matchUnpairedWithAi,
  openShare,
  recordSignoff,
  removeFinding,
  renderInspectionPdf,
  renderShareHtml,
  renderShareProblem,
  reopenInspection,
  reportFileIdsFor,
  revokeShare,
  setPairing,
  sharePath,
  signRequest,
  suggestFinding,
  updateFinding,
  updateInspection,
  type InspectionActor,
} from "../services/inspections";
import { publishInspection } from "../services/inspections/events";

/**
 * /api/inspections (signed in) and /api/share/inspections (a share link, no
 * sign-in). Both answer 404 while the "inspections" feature is switched off.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const actor = (req: Request): InspectionActor => {
  const user = currentUser(req);
  return {
    userOid: user.oid,
    name: user.name,
    // Browser sessions only, as for requireAdmin: an API key is never an administrator.
    isAdmin: !req.apiKeyUser && req.session.user?.role === "admin",
  };
};

const q = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};
const tz = (req: Request) => q(req, "tz") ?? "UTC";

async function requireFeature(): Promise<void> {
  if (!(await getConfig()).features.inspections) {
    throw new HttpError(
      404,
      "feature_disabled",
      "Site inspections are switched off. An administrator can turn them on in Settings.",
    );
  }
}

const uuid = z.string().uuid();
const text = (max: number) => z.string().max(max).nullish();

const inspectionFields = z.object({
  kind: z.enum(INSPECTION_KINDS),
  locationId: uuid.nullish(),
  siteName: text(200),
  jobId: uuid.nullish(),
  jobTaskId: uuid.nullish(),
  preInspectionId: uuid.nullish(),
  inspectors: z.array(z.string().max(120)).max(20).optional(),
  notes: text(4000),
});

const findingFields = z.object({
  area: z.enum(AREAS).optional(),
  room: text(200),
  locationId: uuid.nullish(),
  spot: z.enum(SPOTS).optional(),
  spotDetail: text(200),
  description: z.string().max(1000).optional(),
  severity: z.enum(SEVERITIES).optional(),
  preExisting: z.boolean().optional(),
  aiGenerated: z.boolean().optional(),
  aiSuggestion: z.record(z.unknown()).nullish(),
  attachmentIds: z.array(uuid).max(12).optional(),
});

// Vision and chat calls cost money; one person tapping repeatedly should not run up a bill.
const aiLimit = rateLimit({ windowMs: 60_000, max: 20, key: (req) => `inspections-ai:${currentUser(req).oid}` });

export const inspectionsRouter = Router();

inspectionsRouter.use(
  asyncHandler(async (_req, _res, next) => {
    await requireFeature();
    next();
  }),
);
for (const name of ["id", "findingId", "shareId"]) {
  inspectionsRouter.param(name, (_req, _res, next, value: string) => next(UUID.test(value) ? undefined : notFound("Not found")));
}

inspectionsRouter.get(
  "/meta",
  asyncHandler(async (_req, res) => {
    res.json({
      kinds: INSPECTION_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
      statuses: INSPECTION_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      areas: AREAS.map((a) => ({ value: a, label: AREA_LABEL[a] })),
      spots: SPOTS.map((s) => ({ value: s, label: SPOT_LABEL[s] })),
      severities: SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s], color: SEVERITY_COLOR[s] })),
      signoffs: SIGNOFF_ROLES.map((r) => ({ value: r, label: SIGNOFF_LABEL[r] })),
      share: { defaultDays: SHARE_DEFAULT_DAYS, maxDays: SHARE_MAX_DAYS },
      ai: { vision: env.llmVisionConfigured, languageModel: env.llmConfigured },
    });
  }),
);

const listQuery = z.object({
  jobId: uuid.optional(),
  locationId: uuid.optional(),
  kind: z.enum(INSPECTION_KINDS).optional(),
  status: z.enum(INSPECTION_STATUSES).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

inspectionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listInspections(parse(listQuery, req.query)));
  }),
);

inspectionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parse(inspectionFields, req.body);
    const created = await createInspection(input, actor(req));
    res.status(201).json(await getInspectionDetail(created.id));
  }),
);

inspectionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await getInspectionDetail(param(req, "id")));
  }),
);

inspectionsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const patch = parse(inspectionFields.partial(), req.body);
    await updateInspection(param(req, "id"), patch, actor(req));
    res.json(await getInspectionDetail(param(req, "id")));
  }),
);

inspectionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteInspection(param(req, "id"), actor(req));
    res.status(204).end();
  }),
);

inspectionsRouter.post(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    await completeInspection(param(req, "id"), actor(req));
    res.json(await getInspectionDetail(param(req, "id")));
  }),
);

inspectionsRouter.post(
  "/:id/reopen",
  asyncHandler(async (req, res) => {
    await reopenInspection(param(req, "id"), actor(req));
    res.json(await getInspectionDetail(param(req, "id")));
  }),
);

// ---- Findings

inspectionsRouter.post(
  "/:id/findings",
  asyncHandler(async (req, res) => {
    const input = parse(findingFields.extend({ description: z.string().min(1).max(1000) }), req.body);
    res.status(201).json(await addFinding(param(req, "id"), input, actor(req)));
  }),
);

inspectionsRouter.patch(
  "/:id/findings/:findingId",
  asyncHandler(async (req, res) => {
    const patch = parse(findingFields, req.body);
    res.json(await updateFinding(param(req, "id"), param(req, "findingId"), patch, actor(req)));
  }),
);

inspectionsRouter.delete(
  "/:id/findings/:findingId",
  asyncHandler(async (req, res) => {
    await removeFinding(param(req, "id"), param(req, "findingId"), actor(req));
    res.status(204).end();
  }),
);

const pairSchema = z.union([z.object({ auto: z.literal(true) }), z.object({ preFindingId: uuid.nullable() })]);

inspectionsRouter.post(
  "/:id/findings/:findingId/pair",
  asyncHandler(async (req, res) => {
    const choice = parse(pairSchema, req.body);
    res.json(await setPairing(param(req, "id"), param(req, "findingId"), choice, actor(req)));
  }),
);

// ---- AI

inspectionsRouter.post(
  "/:id/ai/damage",
  aiLimit,
  asyncHandler(async (req, res) => {
    const { attachmentId } = parse(z.object({ attachmentId: uuid }), req.body);
    res.json(await suggestFinding(param(req, "id"), attachmentId, currentUser(req).oid));
  }),
);

inspectionsRouter.post(
  "/:id/ai/match",
  aiLimit,
  asyncHandler(async (req, res) => {
    const result = await matchUnpairedWithAi(param(req, "id"));
    res.json({ ...result, ...(await getComparison(param(req, "id"))) });
  }),
);

inspectionsRouter.get(
  "/:id/comparison",
  asyncHandler(async (req, res) => {
    res.json(await getComparison(param(req, "id")));
  }),
);

// ---- Signing

const roleSchema = z.enum(SIGNOFF_ROLES);

// What the signing screen hands to SignDialog: the statement and the content
// built here from the record, so what is signed is what is stored.
inspectionsRouter.get(
  "/:id/sign-request",
  asyncHandler(async (req, res) => {
    const role = parse(roleSchema, q(req, "role") ?? "crew_lead");
    res.json(await signRequest(param(req, "id"), role));
  }),
);

inspectionsRouter.post(
  "/:id/signoffs",
  asyncHandler(async (req, res) => {
    const { role, signatureId } = parse(z.object({ role: roleSchema, signatureId: uuid }), req.body);
    await recordSignoff(param(req, "id"), role, signatureId, actor(req));
    res.json(await getInspectionDetail(param(req, "id")));
  }),
);

// ---- Report

function sendPdf(res: Response, pdf: Buffer, filename: string, inline: boolean) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(pdf);
}

inspectionsRouter.get(
  "/:id/report.pdf",
  asyncHandler(async (req, res) => {
    const { pdf, filename } = await inspectionPdf(param(req, "id"), tz(req));
    sendPdf(res, pdf, filename, q(req, "download") !== "1");
  }),
);

// ---- Share links

inspectionsRouter.get(
  "/:id/shares",
  asyncHandler(async (req, res) => {
    await loadInspection(param(req, "id"));
    res.json(await listShares(param(req, "id")));
  }),
);

inspectionsRouter.post(
  "/:id/shares",
  asyncHandler(async (req, res) => {
    const { days } = parse(z.object({ days: z.number().positive().max(SHARE_MAX_DAYS).optional() }), req.body ?? {});
    const inspection = await loadInspection(param(req, "id"));
    const share = await createShare(inspection, days ?? SHARE_DEFAULT_DAYS, currentUser(req).oid);
    await publishInspection("inspection.share_created", inspection, currentUser(req).oid, {
      shareId: share.id,
      expiresAt: share.expiresAt,
    });
    res.status(201).json(share);
  }),
);

inspectionsRouter.delete(
  "/:id/shares/:shareId",
  asyncHandler(async (req, res) => {
    const inspection = await loadInspection(param(req, "id"));
    const share = await revokeShare(inspection.id, param(req, "shareId"));
    await publishInspection("inspection.share_revoked", inspection, currentUser(req).oid, { shareId: share.id });
    res.json(share);
  }),
);

/** The column a foreign key violation names ("Location"), or null. Drizzle wraps the driver error. */
function missingReference(err: unknown): string | null {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 10; depth++) {
    const e = cur as { code?: unknown; detail?: unknown; cause?: unknown };
    if (e.code === "23503") {
      const column = /Key \(([a-z_]+)\)/.exec(String(e.detail ?? ""))?.[1] ?? "linked record";
      const words = column.replace(/_id$/, "").replace(/_/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
    cur = e.cause;
  }
  return null;
}

// A location, job or task id that does not exist reaches the database as a
// foreign key; answer with what to fix, not a 500.
const referenceErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  const missing = missingReference(err);
  next(missing ? badRequest(`${missing} not found. Pick one that exists.`) : err);
};
inspectionsRouter.use(referenceErrors);

// ---- Share links, no sign-in -------------------------------------------------------

/**
 * Mounted before the session guard. The token is the only credential: it is
 * checked on every request, including each photo, and a photo is served only
 * if the report shows it.
 */
export const inspectionShareRouter = Router();

// Guessing a token is hopeless (128 random bits and a MAC), but the routes
// still do database work, so a client hammering them is slowed down.
inspectionShareRouter.use(rateLimit({ windowMs: 60_000, max: 300, key: (req) => `inspection-share:${req.ip}` }));

const problem = (res: Response, status: number, title: string, message: string) => {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.type("html").send(renderShareProblem(title, message));
};

async function openOr404(req: Request, res: Response, count = false) {
  if (!(await getConfig()).features.inspections) {
    problem(res, 404, "Link not available", "This link does not work any more.");
    return null;
  }
  const token = param(req, "token");
  const opened = await openShare(token, { count });
  if (!opened.ok) {
    if (opened.reason === "expired") {
      problem(res, 410, "This link has expired", "Ask the person who sent it for a new one.");
    } else if (opened.reason === "revoked") {
      problem(res, 410, "This link was withdrawn", "Ask the person who sent it for a new one.");
    } else {
      problem(res, 404, "Link not found", "Check that the whole link was copied, or ask for a new one.");
    }
    return null;
  }
  return { token, share: opened.share };
}

const shareHeaders = (res: Response) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
};

inspectionShareRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const opened = await openOr404(req, res, true);
    if (!opened) return;
    const report = await buildReport(opened.share.inspectionId);
    shareHeaders(res);
    logger.info("inspections.share.opened", { shareId: opened.share.id, inspectionId: report.id });
    res.type("html").send(
      renderShareHtml(report, {
        base: sharePath(opened.token),
        tz: tz(req),
        appName: (await getConfig()).appName,
        expiresAt: opened.share.expiresAt,
      }),
    );
  }),
);

inspectionShareRouter.get(
  "/:token/report.pdf",
  asyncHandler(async (req, res) => {
    const opened = await openOr404(req, res);
    if (!opened) return;
    const report = await buildReport(opened.share.inspectionId);
    const pdf = await renderInspectionPdf(report, loadReportImage, tz(req));
    shareHeaders(res);
    sendPdf(res, pdf, `${report.code}-${report.kind}-inspection.pdf`, true);
  }),
);

inspectionShareRouter.get(
  "/:token/files/:fileId",
  asyncHandler(async (req, res) => {
    const opened = await openOr404(req, res);
    if (!opened) return;
    const fileId = param(req, "fileId");
    if (!UUID.test(fileId) || !(await reportFileIdsFor(opened.share.inspectionId)).has(fileId)) {
      throw notFound("That file is not part of this report.");
    }
    shareHeaders(res);
    const w = Number(q(req, "w"));
    if (Number.isFinite(w) && w > 0) {
      const thumb = await thumbnail(fileId, Math.min(1024, Math.max(64, Math.round(w))));
      if (thumb) {
        res.setHeader("Content-Type", "image/jpeg");
        res.send(thumb.bytes);
        return;
      }
    }
    const file = await getAttachmentStream(fileId);
    if (file.status === 416) throw notFound("That file is empty.");
    // Only finding photos and signature images reach here: shown in place,
    // never sniffed into something else.
    res.setHeader("Content-Type", file.attachment.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Length", String(file.size));
    try {
      await pipeline(file.stream, res);
    } catch (err) {
      logger.debug("inspections.share.file_aborted", { fileId, err: String(err) });
    }
  }),
);
