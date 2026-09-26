import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { currentUser, requireAdmin } from "../auth/middleware";
import { env } from "../env";
import { asyncHandler, param, parse } from "../lib/http";
import { rateLimit } from "../lib/rateLimit";
import { getConfig } from "../services/config";
import {
  MAX_IMAGE_CAP,
  addDraft,
  addSource,
  analyse,
  commitSession,
  createSession,
  deleteSession,
  getBulkCaptureSettings,
  getSessionDetail,
  listSessions,
  mediaTools,
  mergeDrafts,
  removeSource,
  retrySource,
  saveBulkCaptureSettings,
  splitDraft,
  updateDraft,
  updateSession,
  updateSource,
} from "../services/bulk-capture";

/**
 * T21 routes under /api/bulk-capture. Files are uploaded through the
 * attachments API (owner type capture_session) and then added here, so
 * uploads get the same streaming, progress and size limits as every other
 * file.
 */
export const bulkCaptureRouter = Router();

// The feature switch removes the API along with the screens.
const requireFeature: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.bulkCapture) return next();
      res.status(404).json({
        error: "AI bulk capture is switched off on this instance. An administrator can turn it on in Settings.",
        code: "feature_disabled",
      });
    })
    .catch(next);
};
bulkCaptureRouter.use(requireFeature);

bulkCaptureRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const settings = await getBulkCaptureSettings();
    res.json({
      available: env.llmVisionConfigured,
      vision: env.llmVisionConfigured,
      ...mediaTools(),
      maxImagesPerSession: settings.maxImagesPerSession,
      deskTemplates: settings.deskTemplates,
    });
  }),
);

// ---- Settings ---------------------------------------------------------------

bulkCaptureRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json(await getBulkCaptureSettings());
  }),
);

const templateSchema = z.object({
  id: z.string().max(40).optional(),
  name: z.string().trim().min(1, "Give the template a name").max(80),
  items: z
    .array(
      z.object({
        key: z.string().max(40).optional(),
        label: z.string().trim().min(1, "Give each expected item a label").max(60),
        qty: z.number().int().min(1).max(20),
        match: z.array(z.string().max(40)).max(12).optional(),
      }),
    )
    .min(1, "List at least one expected item")
    .max(20),
});

const settingsSchema = z.object({
  maxImagesPerSession: z.number().int().min(1).max(MAX_IMAGE_CAP).optional(),
  deskTemplates: z.array(templateSchema).min(1).max(20).optional(),
});

bulkCaptureRouter.put(
  "/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const patch = parse(settingsSchema, req.body);
    res.json(
      await saveBulkCaptureSettings({
        ...(patch.maxImagesPerSession !== undefined ? { maxImagesPerSession: patch.maxImagesPerSession } : {}),
        ...(patch.deskTemplates
          ? { deskTemplates: patch.deskTemplates.map((t) => ({ ...t, id: t.id ?? "", items: t.items.map((i) => ({ ...i, key: i.key ?? "", match: i.match ?? [] })) })) }
          : {}),
      }),
    );
  }),
);

// ---- Sessions -----------------------------------------------------------------

const MODES = ["walkthrough", "desk", "manifest"] as const;
const RULES = ["max", "sum"] as const;

bulkCaptureRouter.get(
  "/sessions",
  asyncHandler(async (_req, res) => {
    res.json(await listSessions());
  }),
);

const createSchema = z.object({
  mode: z.enum(MODES),
  title: z.string().max(200).nullish(),
  locationId: z.string().uuid().nullish(),
  imageCap: z.number().int().min(1).max(MAX_IMAGE_CAP).nullish(),
  countRule: z.enum(RULES).optional(),
  deskTemplateId: z.string().max(40).nullish(),
});

bulkCaptureRouter.post(
  "/sessions",
  asyncHandler(async (req, res) => {
    const input = parse(createSchema, req.body);
    res.status(201).json(await createSession(input, currentUser(req).oid));
  }),
);

bulkCaptureRouter.get(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    res.json(await getSessionDetail(param(req, "id")));
  }),
);

const updateSchema = z.object({
  title: z.string().max(200).optional(),
  locationId: z.string().uuid().nullable().optional(),
  imageCap: z.number().int().min(1).max(MAX_IMAGE_CAP).optional(),
  countRule: z.enum(RULES).optional(),
  deskTemplateId: z.string().max(40).optional(),
});

bulkCaptureRouter.patch(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    res.json(await updateSession(param(req, "id"), parse(updateSchema, req.body)));
  }),
);

bulkCaptureRouter.delete(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    await deleteSession(param(req, "id"));
    res.status(204).end();
  }),
);

// ---- Sources --------------------------------------------------------------------

const areaField = z.string().max(80).nullish();

bulkCaptureRouter.post(
  "/sessions/:id/sources",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ attachmentId: z.string().uuid(), area: areaField }), req.body);
    res.status(201).json(await addSource(param(req, "id"), input, currentUser(req).oid));
  }),
);

bulkCaptureRouter.patch(
  "/sessions/:id/sources/:sourceId",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ area: areaField }), req.body);
    res.json(await updateSource(param(req, "id"), param(req, "sourceId"), input));
  }),
);

bulkCaptureRouter.delete(
  "/sessions/:id/sources/:sourceId",
  asyncHandler(async (req, res) => {
    res.json(await removeSource(param(req, "id"), param(req, "sourceId")));
  }),
);

bulkCaptureRouter.post(
  "/sessions/:id/sources/:sourceId/retry",
  asyncHandler(async (req, res) => {
    res.json(await retrySource(param(req, "id"), param(req, "sourceId")));
  }),
);

// Every call here is a paid vision request per image; the session cap bounds
// the total, and this bounds the rate one person can spend it at.
const analyseLimit = rateLimit({
  windowMs: 60_000,
  max: 40,
  key: (req) => `bulk-capture-analyse:${currentUser(req).oid}`,
});

bulkCaptureRouter.post(
  "/sessions/:id/analyse",
  analyseLimit,
  asyncHandler(async (req, res) => {
    const { limit } = parse(z.object({ limit: z.number().int().min(1).max(4).optional() }), req.body ?? {});
    res.json(await analyse(param(req, "id"), { limit: limit ?? 2 }));
  }),
);

// ---- Drafts -----------------------------------------------------------------------

const optText = (max: number) => z.string().max(max).nullish();

const draftFields = {
  name: z.string().trim().min(1, "Give the entry a name").max(200),
  category: optText(60),
  brand: optText(80),
  model: optText(80),
  description: optText(1000),
  qty: z.number().int().min(1).max(100_000),
  area: optText(80),
  locationId: z.string().uuid().nullish(),
  lineNo: z.number().int().min(1).max(999_999).nullish(),
  condition: optText(300),
  stickerColor: optText(30),
  stickerLot: optText(40),
  stickerNumber: optText(40),
};

const addDraftSchema = z.object(draftFields).partial().required({ name: true });
const patchDraftSchema = z.object({ ...draftFields, status: z.enum(["pending", "discarded"]) }).partial();

bulkCaptureRouter.post(
  "/sessions/:id/drafts",
  asyncHandler(async (req, res) => {
    res.status(201).json(await addDraft(param(req, "id"), parse(addDraftSchema, req.body)));
  }),
);

bulkCaptureRouter.patch(
  "/sessions/:id/drafts/:draftId",
  asyncHandler(async (req, res) => {
    res.json(await updateDraft(param(req, "id"), param(req, "draftId"), parse(patchDraftSchema, req.body)));
  }),
);

// Deleting keeps the entry as "discarded", so a later photo of the same thing
// does not bring it back. PATCH { status: "pending" } restores it.
bulkCaptureRouter.delete(
  "/sessions/:id/drafts/:draftId",
  asyncHandler(async (req, res) => {
    res.json(await updateDraft(param(req, "id"), param(req, "draftId"), { status: "discarded" }));
  }),
);

bulkCaptureRouter.post(
  "/sessions/:id/drafts/merge",
  asyncHandler(async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(2).max(50) }), req.body);
    res.json(await mergeDrafts(param(req, "id"), ids));
  }),
);

const splitSchema = z.union([
  z.object({ by: z.literal("source") }),
  z.object({ qty: z.number().int().min(1).max(100_000) }),
]);

bulkCaptureRouter.post(
  "/sessions/:id/drafts/:draftId/split",
  asyncHandler(async (req, res) => {
    res.json(await splitDraft(param(req, "id"), param(req, "draftId"), parse(splitSchema, req.body)));
  }),
);

// ---- Commit -------------------------------------------------------------------------

const commitSchema = z.object({
  draftIds: z.array(z.string().uuid()).max(2000).optional(),
  individual: z.boolean().optional(),
  areaLocations: z.boolean().optional(),
});

bulkCaptureRouter.post(
  "/sessions/:id/commit",
  asyncHandler(async (req, res) => {
    const opts = parse(commitSchema, req.body ?? {});
    res.json(await commitSession(param(req, "id"), opts, currentUser(req).oid));
  }),
);
