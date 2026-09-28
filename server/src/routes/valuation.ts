import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { currentUser, requireAdmin } from "../auth/middleware";
import { env } from "../env";
import { asyncHandler, param, parse } from "../lib/http";
import { rateLimit } from "../lib/rateLimit";
import { getConfig } from "../services/config";
import { DECLARATION_SCOPES, HIGH_VALUE_MODES, VALUATION_SOURCES } from "../db/tables/valuation";
import {
  addDeclarationLines,
  buildReport,
  confirmReceipt,
  createDeclaration,
  createReceipt,
  createServicePlan,
  declarationPdf,
  deleteDeclaration,
  deleteReceipt,
  deleteServicePlan,
  estimateValue,
  getDeclaration,
  getItemValuation,
  getOverview,
  getReceipt,
  getValuationSettings,
  listDeclarations,
  listDue,
  listReceipts,
  listValuations,
  logService,
  markDeclarationSigned,
  pdfReadingAvailable,
  readReceipt,
  receiptMatches,
  recordValuation,
  removeDeclarationLine,
  reportPdf,
  reportXlsx,
  runDigest,
  updateDeclaration,
  updateDeclarationLine,
  updateReceipt,
  updateServicePlan,
  updateValuationSettings,
  upsertProfile,
  verifyDeclaration,
} from "../services/valuation";

/**
 * T19 routes, all under /api/valuation: values and their history, AI
 * estimates, purchase, warranty and service facts, receipts, high-value
 * declarations and the valuation report. docs/valuation.md lists them.
 */
export const valuationRouter = Router();

// The feature switch removes the API along with the screens.
const requireValuationFeature: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.valuation) return next();
      res.status(404).json({ error: "Valuation and warranty is switched off on this instance.", code: "feature_disabled" });
    })
    .catch(next);
};
valuationRouter.use(requireValuationFeature);

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Write dates as YYYY-MM-DD");
const cents = z.number().int().min(0).max(1e13);
const oid = (req: Parameters<RequestHandler>[0]) => currentUser(req).oid;

// Vision calls cost money; one person tapping repeatedly should not run up a bill.
const aiLimit = rateLimit({ windowMs: 60_000, max: 20, key: (req) => `valuation-ai:${currentUser(req).oid}` });

// ---- Status and settings ----------------------------------------------------

valuationRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const settings = await getValuationSettings();
    res.json({
      vision: env.llmVisionConfigured,
      webPrice: env.webSearchConfigured && env.llmConfigured,
      pdfReceipts: env.llmVisionConfigured && pdfReadingAvailable(),
      thresholdCents: settings.highValueThresholdCents,
      warrantyAlertDays: settings.warrantyAlertDays,
    });
  }),
);

valuationRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json(await getValuationSettings());
  }),
);

const settingsSchema = z.object({
  highValueThresholdCents: cents.optional(),
  warrantyAlertDays: z.number().int().min(0).max(3650).optional(),
  serviceSoonDays: z.number().int().min(0).max(3650).optional(),
  serviceSoonPercent: z.number().min(0).max(100).optional(),
  notify: z.boolean().optional(),
  depreciation: z
    .object({
      defaultLifeYears: z.number().min(0.1).max(100).optional(),
      salvagePercent: z.number().min(0).max(100).optional(),
      lifeYearsByCategory: z.record(z.string().trim().min(1).max(60), z.number().min(0.1).max(100)).optional(),
    })
    .optional(),
});

valuationRouter.put(
  "/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await updateValuationSettings(parse(settingsSchema, req.body)));
  }),
);

valuationRouter.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    res.json(await getOverview());
  }),
);

valuationRouter.get(
  "/due",
  asyncHandler(async (_req, res) => {
    res.json(await listDue());
  }),
);

// Send the reminder digest now rather than at the next hourly check.
valuationRouter.post(
  "/digest/run",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await runDigest());
  }),
);

// ---- Items: values, estimates, profile, service ----------------------------------

const unitQuery = z.object({ unitId: uuid.optional() });

valuationRouter.get(
  "/items/:itemId",
  asyncHandler(async (req, res) => {
    res.json(await getItemValuation(parse(uuid, param(req, "itemId"))));
  }),
);

valuationRouter.get(
  "/items/:itemId/valuations",
  asyncHandler(async (req, res) => {
    res.json(await listValuations(parse(uuid, param(req, "itemId"))));
  }),
);

const estimateSchema = z.object({
  unitId: uuid.nullish(),
  attachmentIds: z.array(uuid).min(1, "Take or pick at least one photo of the item.").max(6),
  crossCheck: z.boolean().optional(),
});

// Estimate from photos already attached to the item. Saves nothing.
valuationRouter.post(
  "/items/:itemId/estimate",
  aiLimit,
  asyncHandler(async (req, res) => {
    const input = parse(estimateSchema, req.body);
    res.json(await estimateValue({ itemId: parse(uuid, param(req, "itemId")), ...input }, oid(req)));
  }),
);

const valuationSchema = z.object({
  unitId: uuid.nullish(),
  valueCents: cents,
  source: z.enum(VALUATION_SOURCES),
  basis: z.string().max(500).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  lowCents: cents.nullish(),
  highCents: cents.nullish(),
  valuedOn: isoDate.nullish(),
  details: z.record(z.unknown()).optional(),
  apply: z.object({ brand: z.string().max(120).nullish(), model: z.string().max(120).nullish() }).optional(),
});

valuationRouter.post(
  "/items/:itemId/valuations",
  asyncHandler(async (req, res) => {
    const input = parse(valuationSchema, req.body);
    res.status(201).json(await recordValuation({ itemId: parse(uuid, param(req, "itemId")), ...input }, oid(req)));
  }),
);

const profileSchema = z.object({
  unitId: uuid.nullish(),
  purchaseDate: isoDate.nullish(),
  purchaseCents: cents.nullish(),
  vendor: z.string().max(200).nullish(),
  warrantyEnds: isoDate.nullish(),
  warrantyTerms: z.string().max(1000).nullish(),
  warrantyProvider: z.string().max(200).nullish(),
  highValue: z.enum(HIGH_VALUE_MODES).optional(),
  usageHours: z.number().min(0).max(1e9).nullish(),
});

valuationRouter.put(
  "/items/:itemId/profile",
  asyncHandler(async (req, res) => {
    const { unitId, ...patch } = parse(profileSchema, req.body);
    res.json(await upsertProfile(parse(uuid, param(req, "itemId")), unitId ?? null, patch));
  }),
);

const planFields = {
  name: z.string().trim().min(1, "Name the service").max(120),
  intervalDays: z.number().int().positive().max(36_500).nullish(),
  intervalHours: z.number().positive().max(1e7).nullish(),
  lastDoneAt: z.string().datetime({ offset: true }).or(isoDate).nullish(),
  lastDoneHours: z.number().min(0).max(1e9).nullish(),
  notes: z.string().max(1000).nullish(),
  active: z.boolean().optional(),
};

valuationRouter.post(
  "/items/:itemId/service-plans",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ unitId: uuid.nullish(), ...planFields }), req.body);
    res.status(201).json(await createServicePlan({ itemId: parse(uuid, param(req, "itemId")), ...input }, oid(req)));
  }),
);

valuationRouter.patch(
  "/service-plans/:id",
  asyncHandler(async (req, res) => {
    const patch = parse(z.object(planFields).partial(), req.body);
    res.json(await updateServicePlan(parse(uuid, param(req, "id")), patch));
  }),
);

valuationRouter.delete(
  "/service-plans/:id",
  asyncHandler(async (req, res) => {
    await deleteServicePlan(parse(uuid, param(req, "id")));
    res.status(204).end();
  }),
);

const doneSchema = z.object({
  doneAt: z.string().datetime({ offset: true }).or(isoDate).nullish(),
  hours: z.number().min(0).max(1e9).nullish(),
  costCents: cents.nullish(),
  notes: z.string().max(1000).nullish(),
});

valuationRouter.post(
  "/service-plans/:id/done",
  asyncHandler(async (req, res) => {
    res.json(await logService(parse(uuid, param(req, "id")), parse(doneSchema, req.body), oid(req)));
  }),
);

// ---- Declarations -------------------------------------------------------------

valuationRouter.get(
  "/declarations",
  asyncHandler(async (_req, res) => {
    res.json(await listDeclarations());
  }),
);

const createDeclarationSchema = z.object({
  title: z.string().max(200).nullish(),
  scope: z.enum(DECLARATION_SCOPES),
  scopeId: uuid.nullish(),
  scopeLabel: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  populate: z.boolean().optional(),
  itemIds: z.array(uuid).max(500).optional(),
});

valuationRouter.post(
  "/declarations",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createDeclaration(parse(createDeclarationSchema, req.body), oid(req)));
  }),
);

valuationRouter.get(
  "/declarations/:id",
  asyncHandler(async (req, res) => {
    res.json(await getDeclaration(parse(uuid, param(req, "id"))));
  }),
);

valuationRouter.patch(
  "/declarations/:id",
  asyncHandler(async (req, res) => {
    const patch = parse(
      z.object({ title: z.string().max(200).optional(), notes: z.string().max(2000).nullish(), scopeLabel: z.string().max(200).nullish() }),
      req.body,
    );
    res.json(await updateDeclaration(parse(uuid, param(req, "id")), patch));
  }),
);

valuationRouter.delete(
  "/declarations/:id",
  asyncHandler(async (req, res) => {
    await deleteDeclaration(parse(uuid, param(req, "id")), oid(req));
    res.status(204).end();
  }),
);

valuationRouter.post(
  "/declarations/:id/lines",
  asyncHandler(async (req, res) => {
    const { lines } = parse(z.object({ lines: z.array(z.object({ itemId: uuid, unitId: uuid.nullish() })).min(1).max(500) }), req.body);
    res.json(await addDeclarationLines(parse(uuid, param(req, "id")), lines));
  }),
);

valuationRouter.patch(
  "/declarations/:id/lines/:lineId",
  asyncHandler(async (req, res) => {
    const patch = parse(
      z.object({
        declaredCents: cents.optional(),
        name: z.string().max(200).optional(),
        description: z.string().max(500).nullish(),
        materials: z.string().max(200).nullish(),
        condition: z.string().max(60).nullish(),
        serial: z.string().max(200).nullish(),
        notes: z.string().max(500).nullish(),
      }),
      req.body,
    );
    res.json(await updateDeclarationLine(parse(uuid, param(req, "id")), parse(uuid, param(req, "lineId")), patch));
  }),
);

valuationRouter.delete(
  "/declarations/:id/lines/:lineId",
  asyncHandler(async (req, res) => {
    res.json(await removeDeclarationLine(parse(uuid, param(req, "id")), parse(uuid, param(req, "lineId"))));
  }),
);

// Seal a draft with a signature made over its signingContent through /api/signatures.
valuationRouter.post(
  "/declarations/:id/signed",
  asyncHandler(async (req, res) => {
    const { signatureId } = parse(z.object({ signatureId: uuid }), req.body);
    res.json(await markDeclarationSigned(parse(uuid, param(req, "id")), signatureId, oid(req)));
  }),
);

valuationRouter.get(
  "/declarations/:id/verify",
  asyncHandler(async (req, res) => {
    res.json(await verifyDeclaration(parse(uuid, param(req, "id"))));
  }),
);

const tzOf = (q: unknown) => (typeof q === "string" && q && q.length < 64 ? q : "UTC");

function sendFile(res: Response, bytes: Buffer, type: string, filename: string, inline: boolean): void {
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(bytes);
}

valuationRouter.get(
  "/declarations/:id/pdf",
  asyncHandler(async (req, res) => {
    const decl = await getDeclaration(parse(uuid, param(req, "id")));
    sendFile(res, await declarationPdf(decl, tzOf(req.query.tz)), "application/pdf", `${decl.code}.pdf`, true);
  }),
);

// ---- Receipts -------------------------------------------------------------------

valuationRouter.get(
  "/receipts",
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ itemId: uuid.optional(), status: z.enum(["draft", "confirmed"]).optional() }), req.query);
    res.json(await listReceipts(q));
  }),
);

valuationRouter.post(
  "/receipts",
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ notes: z.string().max(2000).nullish() }), req.body ?? {});
    res.status(201).json(await createReceipt(input, oid(req)));
  }),
);

valuationRouter.get(
  "/receipts/:id",
  asyncHandler(async (req, res) => {
    res.json(await getReceipt(parse(uuid, param(req, "id"))));
  }),
);

const receiptLineSchema = z.object({
  description: z.string().min(1).max(300),
  quantity: z.number().positive().max(1e6).nullish(),
  unitPriceCents: z.number().int().min(-1e13).max(1e13).nullish(),
  totalCents: z.number().int().min(-1e13).max(1e13).nullish(),
  sku: z.string().max(80).nullish(),
  serial: z.string().max(80).nullish(),
  warrantyMonths: z.number().int().min(1).max(240).nullish(),
  itemId: uuid.nullish(),
  unitId: uuid.nullish(),
});

const receiptPatchSchema = z.object({
  vendor: z.string().max(120).nullish(),
  purchaseDate: isoDate.nullish(),
  currency: z.string().length(3).nullish(),
  subtotalCents: z.number().int().min(-1e13).max(1e13).nullish(),
  taxCents: z.number().int().min(-1e13).max(1e13).nullish(),
  totalCents: z.number().int().min(-1e13).max(1e13).nullish(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(receiptLineSchema).max(200).optional(),
});

valuationRouter.put(
  "/receipts/:id",
  asyncHandler(async (req, res) => {
    res.json(await updateReceipt(parse(uuid, param(req, "id")), parse(receiptPatchSchema, req.body)));
  }),
);

valuationRouter.delete(
  "/receipts/:id",
  asyncHandler(async (req, res) => {
    await deleteReceipt(parse(uuid, param(req, "id")), currentUser(req).role === "admin" && !req.apiKeyUser);
    res.status(204).end();
  }),
);

// Read the receipt's files with AI, replacing the draft's lines. Returns the reading for review.
valuationRouter.post(
  "/receipts/:id/read",
  aiLimit,
  asyncHandler(async (req, res) => {
    res.json(await readReceipt(parse(uuid, param(req, "id")), oid(req)));
  }),
);

valuationRouter.get(
  "/receipts/:id/matches",
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ preferItemId: uuid.optional() }), req.query);
    res.json(await receiptMatches(parse(uuid, param(req, "id")), q.preferItemId));
  }),
);

const confirmSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: uuid,
        itemId: uuid.nullish(),
        unitId: uuid.nullish(),
        create: z.boolean().optional(),
        setValue: z.boolean().optional(),
        setWarranty: z.boolean().optional(),
      }),
    )
    .max(200),
});

valuationRouter.post(
  "/receipts/:id/confirm",
  asyncHandler(async (req, res) => {
    const { lines } = parse(confirmSchema, req.body);
    res.json(await confirmReceipt(parse(uuid, param(req, "id")), lines, oid(req)));
  }),
);

// ---- Report -----------------------------------------------------------------------

const reportQuery = z.object({
  format: z.enum(["pdf", "xlsx", "json"]).default("pdf"),
  locationId: uuid.optional(),
  companyId: uuid.optional(),
  includeSublocations: z.enum(["true", "false"]).optional(),
  groupBy: z.enum(["location", "company"]).optional(),
  highValueOnly: z.enum(["true", "false"]).optional(),
  asOf: isoDate.optional(),
  tz: z.string().max(64).optional(),
});

valuationRouter.get(
  "/report",
  asyncHandler(async (req, res) => {
    const q = parse(reportQuery, req.query);
    const report = await buildReport({
      locationId: q.locationId,
      companyId: q.companyId,
      includeSublocations: q.includeSublocations !== "false",
      groupBy: q.groupBy,
      highValueOnly: q.highValueOnly === "true",
      asOf: q.asOf,
    });
    const stamp = report.asOf;
    if (q.format === "json") {
      res.json(report);
    } else if (q.format === "xlsx") {
      const base = env.APP_BASE_URL.replace(/\/+$/, "");
      sendFile(res, await reportXlsx(report, base), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `valuation-${stamp}.xlsx`, false);
    } else {
      sendFile(res, await reportPdf(report, tzOf(q.tz)), "application/pdf", `valuation-${stamp}.pdf`, true);
    }
  }),
);
