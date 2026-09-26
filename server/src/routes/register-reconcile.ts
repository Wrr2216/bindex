import { Router, raw } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { badRequest } from "../lib/errors";
import { currentUser } from "../auth/middleware";
import { COPY_FIELDS, runAction } from "../services/register-reconcile/actions";
import { commitImport, previewImport } from "../services/register-reconcile/importNew";
import { FIELDS, PRESETS } from "../services/register-reconcile/presets";
import {
  compareRunPair,
  deleteRun,
  getRun,
  listResults,
  listRuns,
  runReconciliation,
} from "../services/register-reconcile/reconcile";
import { renderPdf, renderXlsx } from "../services/register-reconcile/report";
import { buildReportData } from "../services/register-reconcile/reportData";
import {
  createImport,
  deleteImport,
  getImport,
  importLocations,
  listImports,
  listLocationMappings,
  listRows,
  setLocationMapping,
  updateImport,
} from "../services/register-reconcile/store";

export const registerReconcileRouter = Router();

const presetSchema = z.enum(["generic", "snipeit", "homebox", "erp"]);
const fieldSchema = z.enum(FIELDS.map((f) => f.key) as [string, ...string[]]);
const classSchema = z.enum(["matched", "misplaced", "conflict", "register_only", "bindex_only", "duplicate", "flagged_missing"]);
const optionalUuid = z.string().uuid().nullish();
const pageSchema = z.object({
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  q: z.string().max(200).optional(),
});

const safeFileName = (name: string) => name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "register";

registerReconcileRouter.get("/presets", (_req, res) => {
  res.json({ fields: FIELDS, presets: PRESETS });
});

// --- Imports ----------------------------------------------------------------

registerReconcileRouter.get(
  "/imports",
  asyncHandler(async (_req, res) => {
    res.json(await listImports());
  }),
);

// The file is the request body, as sent by a file input; the global JSON
// parser leaves non-JSON bodies alone.
const uploadQuery = z.object({
  name: z.string().max(200).optional(),
  preset: presetSchema.optional(),
  filename: z.string().max(255).optional(),
});
registerReconcileRouter.post(
  "/imports",
  raw({ type: () => true, limit: "32mb" }),
  asyncHandler(async (req, res) => {
    const q = parse(uploadQuery, req.query);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw badRequest("Send the CSV or XLSX file itself as the request body.");
    }
    const imp = await createImport({
      bytes: req.body,
      name: q.name,
      preset: q.preset,
      fileName: q.filename,
      userOid: currentUser(req).oid,
    });
    res.status(201).json(imp);
  }),
);

registerReconcileRouter.get(
  "/imports/:id",
  asyncHandler(async (req, res) => {
    res.json(await getImport(param(req, "id")));
  }),
);

const importPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  preset: presetSchema.optional(),
  mapping: z.record(fieldSchema, z.string().max(300).nullable()).optional(),
});
registerReconcileRouter.patch(
  "/imports/:id",
  asyncHandler(async (req, res) => {
    const body = parse(importPatch, req.body);
    const mapping = body.mapping
      ? Object.fromEntries(Object.entries(body.mapping).filter(([, v]) => !!v))
      : undefined;
    res.json(await updateImport(param(req, "id"), { name: body.name, preset: body.preset, mapping }));
  }),
);

registerReconcileRouter.delete(
  "/imports/:id",
  asyncHandler(async (req, res) => {
    await deleteImport(param(req, "id"));
    res.status(204).end();
  }),
);

registerReconcileRouter.get(
  "/imports/:id/rows",
  asyncHandler(async (req, res) => {
    const q = parse(pageSchema.extend({ issues: z.enum(["0", "1"]).optional() }), req.query);
    res.json(await listRows(param(req, "id"), { ...q, issuesOnly: q.issues === "1" }));
  }),
);

registerReconcileRouter.get(
  "/imports/:id/locations",
  asyncHandler(async (req, res) => {
    res.json(await importLocations(param(req, "id")));
  }),
);

const scopeSchema = z.object({ companyId: optionalUuid, locationId: optionalUuid });
registerReconcileRouter.post(
  "/imports/:id/reconcile",
  asyncHandler(async (req, res) => {
    const scope = parse(scopeSchema, req.body ?? {});
    res.status(201).json(await runReconciliation(param(req, "id"), scope, currentUser(req).oid));
  }),
);

const importOptions = z.object({ companyId: optionalUuid, defaultLocationId: optionalUuid });
registerReconcileRouter.post(
  "/imports/:id/import-preview",
  asyncHandler(async (req, res) => {
    res.json(await previewImport(param(req, "id"), parse(importOptions, req.body ?? {})));
  }),
);

registerReconcileRouter.post(
  "/imports/:id/import-commit",
  asyncHandler(async (req, res) => {
    const body = parse(importOptions.extend({ planHash: z.string().length(64) }), req.body);
    const { planHash, ...opts } = body;
    res.status(201).json(await commitImport(param(req, "id"), opts, planHash, currentUser(req).oid));
  }),
);

// --- Location mapping ---------------------------------------------------------

registerReconcileRouter.get(
  "/location-map",
  asyncHandler(async (_req, res) => {
    res.json(await listLocationMappings());
  }),
);

const mappingSchema = z.object({ text: z.string().min(1).max(500), locationId: z.string().uuid().nullable() });
registerReconcileRouter.put(
  "/location-map",
  asyncHandler(async (req, res) => {
    const { text, locationId } = parse(mappingSchema, req.body);
    res.json({ mapping: await setLocationMapping(text, locationId, currentUser(req).oid) });
  }),
);

// --- Runs -------------------------------------------------------------------

registerReconcileRouter.get(
  "/runs",
  asyncHandler(async (req, res) => {
    const { importId } = parse(z.object({ importId: z.string().uuid().optional() }), req.query);
    res.json(await listRuns(importId));
  }),
);

registerReconcileRouter.get(
  "/runs/:id",
  asyncHandler(async (req, res) => {
    res.json(await getRun(param(req, "id")));
  }),
);

registerReconcileRouter.delete(
  "/runs/:id",
  asyncHandler(async (req, res) => {
    await deleteRun(param(req, "id"));
    res.status(204).end();
  }),
);

const resultsQuery = pageSchema.extend({
  class: classSchema.optional(),
  status: z.enum(["open", "resolved", "ignored", "all"]).optional(),
});
registerReconcileRouter.get(
  "/runs/:id/results",
  asyncHandler(async (req, res) => {
    const q = parse(resultsQuery, req.query);
    res.json(await listResults(param(req, "id"), { ...q, cls: q.class }));
  }),
);

const ids = z.array(z.string().uuid()).min(1).max(20_000);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_items"), resultIds: ids, companyId: optionalUuid, defaultLocationId: optionalUuid }),
  z.object({ action: z.literal("move_to_register"), resultIds: ids }),
  z.object({ action: z.literal("accept_bindex_location"), resultIds: ids }),
  z.object({
    action: z.literal("copy_fields"),
    resultIds: ids,
    direction: z.enum(["to_bindex", "to_register"]),
    fields: z.array(z.enum(COPY_FIELDS)).min(1),
  }),
  z.object({ action: z.literal("flag_missing"), resultIds: ids }),
  z.object({ action: z.literal("clear_missing"), resultIds: ids }),
  z.object({ action: z.literal("link_proposal"), resultIds: ids }),
  z.object({ action: z.literal("ignore"), resultIds: ids, reason: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal("reopen"), resultIds: ids }),
]);
registerReconcileRouter.post(
  "/runs/:id/actions",
  asyncHandler(async (req, res) => {
    const input = parse(actionSchema, req.body);
    const user = currentUser(req);
    res.json(await runAction(param(req, "id"), input, { oid: user.oid, name: user.name }));
  }),
);

registerReconcileRouter.get(
  "/runs/:id/compare/:otherId",
  asyncHandler(async (req, res) => {
    res.json(await compareRunPair(param(req, "id"), param(req, "otherId")));
  }),
);

registerReconcileRouter.get(
  "/runs/:id/report.xlsx",
  asyncHandler(async (req, res) => {
    const data = await buildReportData(param(req, "id"));
    const buf = await renderXlsx(data);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="reconciliation-${safeFileName(data.importName)}.xlsx"`);
    res.send(buf);
  }),
);

registerReconcileRouter.get(
  "/runs/:id/report.pdf",
  asyncHandler(async (req, res) => {
    const data = await buildReportData(param(req, "id"));
    const buf = await renderPdf(data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="reconciliation-${safeFileName(data.importName)}.pdf"`);
    res.send(buf);
  }),
);
