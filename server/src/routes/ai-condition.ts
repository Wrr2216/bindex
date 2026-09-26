import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { currentUser, requireAdmin } from "../auth/middleware";
import { env } from "../env";
import { HttpError, badRequest } from "../lib/errors";
import { asyncHandler, param, parse } from "../lib/http";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";
import { getConfig } from "../services/config";
import {
  assessCondition,
  closeSweep,
  compareReports,
  compareReportsWithAi,
  createReport,
  deleteReport,
  getConditionSettings,
  getReport,
  getSweepDetail,
  handlingNoteFor,
  listCaptures,
  listReports,
  listSweeps,
  readContainer,
  resolveSweepScan,
  saveCapture,
  startSweep,
  updateConditionSettings,
  updateReport,
} from "../services/ai-condition";
import { LOW_CONFIDENCE } from "../services/ai-condition/normalize";
import { CONTAINER_FLAGS, DEFECT_TYPES, RATINGS, SEVERITIES, STAGES } from "../services/ai-condition/vocab";

/**
 * T12 routes under /api/condition: condition reports, the before/after
 * comparison, container capture, condition sweeps, handling notes, and the
 * AI drafts behind them. AI endpoints return drafts only; saving is always a
 * separate request a person makes.
 */
export const aiConditionRouter = Router();

// The feature switch removes the API along with the screens.
const requireFeature: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.aiCondition) return next();
      res.status(404).json({
        error: "Condition records are switched off on this instance. An administrator can turn them on in Settings.",
        code: "feature_disabled",
      });
    })
    .catch(next);
};
aiConditionRouter.use(requireFeature);

// Vision calls cost money; one person tapping repeatedly should not run up a bill.
const aiLimit = rateLimit({ windowMs: 60_000, max: 30, key: (req) => `ai-condition:${currentUser(req).oid}` });

const oid = (req: Request) => currentUser(req).oid;
const uuid = z.string().uuid();
const ids = z.array(uuid).max(12);

const defect = z.object({
  area: z.string().max(80),
  type: z.enum(DEFECT_TYPES),
  severity: z.enum(SEVERITIES),
  description: z.string().max(300).nullish(),
});

const rating = z.enum(RATINGS);
const stage = z.enum(STAGES);

type AiDraft<T> = { available: boolean; draft: T | null };

/** The shared answer shape for every AI draft. */
function aiAnswer<T>(result: AiDraft<T>, miss: string) {
  return {
    available: result.available,
    found: Boolean(result.draft),
    draft: result.draft,
    lowConfidence: LOW_CONFIDENCE,
    ...(result.available && !result.draft ? { message: miss } : {}),
  };
}

// ---- Settings -------------------------------------------------------------

aiConditionRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json({
      ...(await getConditionSettings()),
      vision: env.llmVisionConfigured,
      vocabulary: { stages: STAGES, ratings: RATINGS, defectTypes: DEFECT_TYPES, severities: SEVERITIES, flags: CONTAINER_FLAGS },
    });
  }),
);

const settingsSchema = z.object({
  sizeClasses: z.array(z.string().max(80)).max(80).optional(),
  categories: z.array(z.string().max(80)).max(80).optional(),
  promptHint: z.string().max(2000).optional(),
});

aiConditionRouter.put(
  "/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await updateConditionSettings(parse(settingsSchema, req.body)));
  }),
);

// ---- Reports --------------------------------------------------------------

const listSchema = z.object({
  itemId: uuid.optional(),
  unitId: uuid.optional(),
  sweepId: uuid.optional(),
  before: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

aiConditionRouter.get(
  "/reports",
  asyncHandler(async (req, res) => {
    res.json(await listReports(parse(listSchema, req.query)));
  }),
);

const reportFields = {
  unitId: uuid.nullish(),
  stage,
  stageLabel: z.string().max(40).nullish(),
  rating: rating.nullish(),
  notes: z.string().max(4000).nullish(),
  aiNotes: z.string().max(4000).nullish(),
  defects: z.array(defect).max(50).optional(),
  handlingNote: z.string().max(300).nullish(),
  attachmentIds: ids.optional(),
  aiAssisted: z.boolean().optional(),
};

const createSchema = z.object({ itemId: uuid, sweepId: uuid.nullish(), ...reportFields });
const patchSchema = z.object({ ...reportFields, stage: stage.optional() });

aiConditionRouter.post(
  "/reports",
  asyncHandler(async (req, res) => {
    const body = parse(createSchema, req.body);
    res.status(201).json(await createReport(body, oid(req)));
  }),
);

aiConditionRouter.get(
  "/reports/:id",
  asyncHandler(async (req, res) => {
    const report = await getReport(param(req, "id"));
    if (!report) throw new HttpError(404, "not_found", "Condition report not found. It may have been deleted.");
    res.json(report);
  }),
);

aiConditionRouter.patch(
  "/reports/:id",
  asyncHandler(async (req, res) => {
    const body = parse(patchSchema, req.body);
    res.json(await updateReport(param(req, "id"), body, oid(req)));
  }),
);

aiConditionRouter.delete(
  "/reports/:id",
  asyncHandler(async (req, res) => {
    await deleteReport(param(req, "id"), currentUser(req));
    res.status(204).end();
  }),
);

// ---- Before and after -----------------------------------------------------

const pairSchema = z.object({ before: uuid, after: uuid });

aiConditionRouter.get(
  "/compare",
  asyncHandler(async (req, res) => {
    const { before, after } = parse(pairSchema, req.query);
    res.json(await compareReports(before, after));
  }),
);

aiConditionRouter.post(
  "/compare/ai",
  aiLimit,
  asyncHandler(async (req, res) => {
    const { before, after } = parse(pairSchema, req.body);
    const result = await compareReportsWithAi(before, after, { user: oid(req) });
    logger.info("ai_condition.compare.read", { before, after, available: result.available, found: Boolean(result.draft) });
    res.json(aiAnswer(result, "The photos could not be compared. Try photos taken from the same angle, in good light."));
  }),
);

// ---- AI condition assessment ----------------------------------------------

const assessSchema = z.object({ itemId: uuid, attachmentIds: ids });

aiConditionRouter.post(
  "/assess",
  aiLimit,
  asyncHandler(async (req, res) => {
    const body = parse(assessSchema, req.body);
    const result = await assessCondition(body, { user: oid(req) });
    logger.info("ai_condition.assess.read", { itemId: body.itemId, available: result.available, found: Boolean(result.draft) });
    res.json(aiAnswer(result, "The condition could not be read from these photos. Try closer, in better light, or fill it in by hand."));
  }),
);

// ---- Containers -----------------------------------------------------------

aiConditionRouter.get(
  "/containers/:itemId",
  asyncHandler(async (req, res) => {
    const itemId = parse(uuid, param(req, "itemId"));
    res.json({ captures: await listCaptures(itemId) });
  }),
);

aiConditionRouter.post(
  "/containers/:itemId/read",
  aiLimit,
  asyncHandler(async (req, res) => {
    const itemId = parse(uuid, param(req, "itemId"));
    const { attachmentIds } = parse(z.object({ attachmentIds: ids }), req.body);
    const result = await readContainer(itemId, attachmentIds, { user: oid(req) });
    logger.info("ai_condition.container.read", { itemId, available: result.available, found: Boolean(result.draft) });
    res.json(
      aiAnswer(result, "Nothing could be read from these photos. Photograph the writing straight on, and the open top in good light."),
    );
  }),
);

const lineSchema = z.object({
  name: z.string().min(1, "Every line needs a name").max(120),
  category: z.string().max(60).nullish(),
  qty: z.number().int().min(1).max(9999).optional(),
  condition: rating.nullish(),
  fragile: z.boolean().optional(),
  description: z.string().max(300).nullish(),
  create: z.boolean().optional(),
});

const captureSchema = z.object({
  sizeClass: z.string().max(60).nullish(),
  handwrittenText: z.string().max(2000).nullish(),
  room: z.string().max(80).nullish(),
  contentsSummary: z.string().max(200).nullish(),
  flags: z.array(z.enum(CONTAINER_FLAGS)).max(10).optional(),
  contents: z.array(lineSchema).max(100).optional(),
  attachmentIds: z.array(uuid).max(8).optional(),
  aiAssisted: z.boolean().optional(),
  confidence: z.record(z.number().min(0).max(1)).nullish(),
  containerName: z.string().max(200).nullish(),
  inheritLocation: z.boolean().optional(),
});

aiConditionRouter.post(
  "/containers/:itemId/capture",
  asyncHandler(async (req, res) => {
    const itemId = parse(uuid, param(req, "itemId"));
    const body = parse(captureSchema, req.body);
    res.status(201).json(await saveCapture(itemId, body, oid(req)));
  }),
);

// ---- Handling notes -------------------------------------------------------

aiConditionRouter.get(
  "/handling",
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.itemIds === "string" ? req.query.itemIds : "";
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length > 500) throw badRequest("Ask for at most 500 items at a time.");
    parse(z.array(uuid), list);
    const notes = await handlingNoteFor(list);
    res.json({ notes: Object.fromEntries(notes) });
  }),
);

// ---- Sweeps ---------------------------------------------------------------

const sweepStage = z.enum(["before", "after", "inspection"]);

aiConditionRouter.get(
  "/sweeps",
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ status: z.enum(["open", "closed"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), req.query);
    res.json({ sweeps: await listSweeps(q) });
  }),
);

aiConditionRouter.post(
  "/sweeps",
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ locationId: uuid, stage: sweepStage.optional(), name: z.string().max(120).nullish() }), req.body);
    res.status(201).json(await startSweep(body, oid(req)));
  }),
);

aiConditionRouter.get(
  "/sweeps/:id",
  asyncHandler(async (req, res) => {
    res.json(await getSweepDetail(parse(uuid, param(req, "id"))));
  }),
);

aiConditionRouter.post(
  "/sweeps/:id/scan",
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().min(1).max(500) }), req.body);
    res.json(await resolveSweepScan(parse(uuid, param(req, "id")), code));
  }),
);

aiConditionRouter.post(
  "/sweeps/:id/close",
  asyncHandler(async (req, res) => {
    res.json(await closeSweep(parse(uuid, param(req, "id")), oid(req)));
  }),
);
