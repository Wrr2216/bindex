import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { currentUser } from "../auth/middleware";
import { HttpError } from "../lib/errors";
import { asyncHandler, param, parse } from "../lib/http";
import { rateLimit } from "../lib/rateLimit";
import { aiAvailability } from "../services/ai";
import { getConfig } from "../services/config";
import { actorFromUser, publish } from "../services/event-backbone";
import { labelPdf } from "../services/printing";
import {
  PART_KINDS,
  addPart,
  addStep,
  applyDraft,
  cancelGuideJob,
  createGuide,
  deleteGuide,
  deletePart,
  deleteStep,
  discardDraft,
  enqueueGuide,
  ffmpegAvailable,
  getGuide,
  guideBagLabels,
  guideReport,
  listGuides,
  reassemblyProgress,
  resetReassembly,
  updateGuide,
  updatePart,
  updateStep,
} from "../services/teardown";

/**
 * T20 routes under /api/teardown: guides, their steps and parts, processing,
 * the PDF report and hardware bag labels. Every change answers with the whole
 * guide, so a screen can replace what it shows in one step.
 */
export const teardownRouter = Router();

// The feature switch removes the API along with the screens.
const requireTeardownFeature: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.teardown) return next();
      res.status(404).json({ error: "Teardown guides are switched off on this instance.", code: "feature_disabled" });
    })
    .catch(next);
};
teardownRouter.use(requireTeardownFeature);

// Every processing run can mean a paid transcription and model calls, so one
// person repeatedly asking to read a video again is slowed down.
const processLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 30,
  key: (req) => `teardown-process:${currentUser(req).oid}`,
});

const uuid = z.string().uuid();
const seconds = z.number().min(0).max(24 * 3600).nullable().optional();
const kind = z.enum(PART_KINDS);

teardownRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const { languageModel, vision, transcription } = aiAvailability();
    const config = await getConfig();
    res.json({ ffmpeg: await ffmpegAvailable(), transcription, languageModel, vision, printing: config.features.printing });
  }),
);

// ---- Guides -------------------------------------------------------------------

teardownRouter.get(
  "/guides",
  asyncHandler(async (req, res) => {
    const q = parse(
      z.object({
        itemId: uuid.optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      req.query,
    );
    res.json(await listGuides(q));
  }),
);

const createSchema = z.object({
  itemId: uuid,
  unitId: uuid.nullish(),
  title: z.string().max(200).nullish(),
  notes: z.string().max(4000).nullish(),
  videoAttachmentId: uuid.nullish(),
  // Start reading the narration straight away. On by default when there is a video.
  process: z.boolean().optional(),
});

teardownRouter.post(
  "/guides",
  processLimit,
  asyncHandler(async (req, res) => {
    const input = parse(createSchema, req.body);
    const user = currentUser(req);
    const row = await createGuide(input, user.oid);
    if (row.videoAttachmentId && input.process !== false) await enqueueGuide(row.id);
    await publish(
      "teardown.guide_created",
      { guideId: row.id, itemId: row.itemId, unitId: row.unitId, title: row.title, hasVideo: !!row.videoAttachmentId },
      { actor: actorFromUser(user), subject: { type: "teardown_guide", id: row.id } },
    );
    res.status(201).json(await getGuide(row.id));
  }),
);

teardownRouter.get(
  "/guides/:id",
  asyncHandler(async (req, res) => {
    res.json(await getGuide(param(req, "id")));
  }),
);

const patchGuideSchema = z.object({
  title: z.string().max(200).optional(),
  notes: z.string().max(4000).nullish(),
  videoAttachmentId: uuid.nullish(),
  process: z.boolean().optional(),
});

teardownRouter.patch(
  "/guides/:id",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const { process, ...patch } = parse(patchGuideSchema, req.body);
    const { videoChanged } = await updateGuide(id, patch);
    if (videoChanged && patch.videoAttachmentId && process !== false) await enqueueGuide(id);
    res.json(await getGuide(id));
  }),
);

teardownRouter.delete(
  "/guides/:id",
  asyncHandler(async (req, res) => {
    const row = await deleteGuide(param(req, "id"));
    await publish(
      "teardown.guide_deleted",
      { guideId: row.id, itemId: row.itemId, unitId: row.unitId, title: row.title },
      { actor: actorFromUser(currentUser(req)), subject: { type: "teardown_guide", id: row.id } },
    );
    res.status(204).end();
  }),
);

// ---- Processing ----------------------------------------------------------------

teardownRouter.post(
  "/guides/:id/process",
  processLimit,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const { mode } = parse(z.object({ mode: z.enum(["continue", "steps", "all"]).optional() }), req.body ?? {});
    await enqueueGuide(id, mode);
    res.status(202).json(await getGuide(id));
  }),
);

teardownRouter.post(
  "/guides/:id/process/cancel",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await cancelGuideJob(id);
    res.json(await getGuide(id));
  }),
);

teardownRouter.post(
  "/guides/:id/draft/apply",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await applyDraft(id);
    // New steps need their pictures.
    await enqueueGuide(id).catch(() => undefined);
    res.json(await getGuide(id));
  }),
);

teardownRouter.delete(
  "/guides/:id/draft",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await discardDraft(id);
    res.json(await getGuide(id));
  }),
);

// ---- Steps ------------------------------------------------------------------------

const stepFields = {
  instruction: z.string().max(4000).nullish(),
  start: seconds,
  end: seconds,
  callout: z.string().max(1000).nullish(),
  keyframeAttachmentId: uuid.nullish(),
};

teardownRouter.post(
  "/guides/:id/steps",
  asyncHandler(async (req, res) => {
    const input = parse(
      z.object({ title: z.string().min(1, "Give the step a title").max(400), afterN: z.number().int().min(0).optional(), ...stepFields }),
      req.body,
    );
    const guideId = await addStep(param(req, "id"), input);
    res.status(201).json(await getGuide(guideId));
  }),
);

teardownRouter.patch(
  "/steps/:stepId",
  asyncHandler(async (req, res) => {
    const patch = parse(
      z.object({ title: z.string().max(400).optional(), n: z.number().int().min(1).optional(), ...stepFields }),
      req.body,
    );
    const guideId = await updateStep(param(req, "stepId"), patch);
    res.json(await getGuide(guideId));
  }),
);

teardownRouter.delete(
  "/steps/:stepId",
  asyncHandler(async (req, res) => {
    const guideId = await deleteStep(param(req, "stepId"));
    res.json(await getGuide(guideId));
  }),
);

// ---- Parts ------------------------------------------------------------------------

const partFields = {
  kind: kind.optional(),
  qty: z.number().int().min(1).max(100_000).optional(),
  stepId: uuid.nullish(),
  note: z.string().max(500).nullish(),
};

teardownRouter.post(
  "/guides/:id/parts",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ name: z.string().min(1, "Name the part").max(400), ...partFields }), req.body);
    const guideId = await addPart(param(req, "id"), input);
    res.status(201).json(await getGuide(guideId));
  }),
);

teardownRouter.patch(
  "/parts/:partId",
  asyncHandler(async (req, res) => {
    const patch = parse(
      z.object({ name: z.string().max(400).optional(), reassembled: z.boolean().optional(), ...partFields }),
      req.body,
    );
    const user = currentUser(req);
    const { guideId, reassembledChanged } = await updatePart(param(req, "partId"), patch, user.oid);
    const guide = await getGuide(guideId);
    if (reassembledChanged && patch.reassembled) {
      const progress = await reassemblyProgress(guideId);
      if (progress.total > 0 && progress.done === progress.total) {
        await publish(
          "teardown.reassembly_completed",
          { guideId, itemId: guide.itemId, unitId: guide.unitId, title: guide.title, parts: progress.total },
          { actor: actorFromUser(user), subject: { type: "teardown_guide", id: guideId } },
        );
      }
    }
    res.json(guide);
  }),
);

teardownRouter.delete(
  "/parts/:partId",
  asyncHandler(async (req, res) => {
    const guideId = await deletePart(param(req, "partId"));
    res.json(await getGuide(guideId));
  }),
);

teardownRouter.post(
  "/guides/:id/reassembly/reset",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await resetReassembly(id);
    res.json(await getGuide(id));
  }),
);

// ---- Export -------------------------------------------------------------------------

const fileName = (title: string, suffix: string) =>
  `${title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "teardown"}-${suffix}.pdf`;

teardownRouter.get(
  "/guides/:id/report.pdf",
  asyncHandler(async (req, res) => {
    const tz = typeof req.query.tz === "string" && req.query.tz ? req.query.tz : "UTC";
    const { pdf, title } = await guideReport(param(req, "id"), { appName: (await getConfig()).appName, timeZone: tz });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName(title, "report")}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  }),
);

teardownRouter.get(
  "/guides/:id/bag-labels.pdf",
  asyncHandler(async (req, res) => {
    if (!(await getConfig()).features.printing) {
      throw new HttpError(404, "feature_disabled", "Label printing is switched off. An administrator can turn it on in Settings.");
    }
    // Step numbers to print; 0 is hardware not tied to a step. None means all.
    const steps = String(req.query.steps ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0);
    const labels = await guideBagLabels(param(req, "id"), steps);
    if (!labels.length) {
      throw new HttpError(404, "nothing_to_print", "No hardware is listed for those steps, so there are no bag labels to print.");
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="bag-labels.pdf"');
    res.setHeader("Cache-Control", "no-store");
    res.send(await labelPdf(labels));
  }),
);
