import { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { missingReference } from "../services/jobs-core/shared";
import { currentUser, requireAdmin } from "../auth/middleware";
import { getConfig } from "../services/config";
import * as jobsCore from "../services/jobs-core";
import {
  JOB_STATUSES,
  PROJECT_STATUSES,
  SHIPMENT_STATUSES,
  TASK_STATUSES,
  VIA_PATTERN,
  stageList,
  taskKindList,
  type Actor,
} from "../services/jobs-core";

/**
 * /api/projects, /api/jobs, /api/shipments and /api/job-types. Mounted once
 * on the API router; the whole set answers 404 while the "jobs" feature is
 * switched off, so a disabled feature is disabled for scripts too.
 */

const actor = (req: Request): Actor => {
  const user = currentUser(req);
  return { userOid: user.oid, name: user.name };
};

const uuid = z.string().uuid();
const optionalUuid = uuid.nullish();
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date such as 2026-10-01")
  // JavaScript rolls 2026-02-30 over into March; Postgres rejects it, so check
  // the date survives a round trip.
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "That date does not exist")
  .nullish();
const timestamp = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Use an ISO 8601 date and time")
  .nullish();
const text = (max: number) => z.string().max(max).nullish();
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #0284c7");

const projectStatus = z.enum(PROJECT_STATUSES);
const jobStatus = z.enum(JOB_STATUSES);
const taskStatus = z.enum(TASK_STATUSES);
const shipmentStatus = z.enum(SHIPMENT_STATUSES);

const q = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** The viewer's time zone for printed timestamps, as the print routes take it. */
const tz = (req: Request) => q(req, "tz") ?? "UTC";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id filter from the query string; `allowNone` also accepts "none" (no shipment). */
function qId(req: Request, name: string, allowNone = false): string | undefined {
  const v = q(req, name);
  if (v === undefined || UUID.test(v) || (allowNone && v === "none")) return v;
  throw badRequest(`${name} must be an id${allowNone ? ' or "none"' : ""}.`);
}

/** A malformed id is a record that does not exist, not a database error. */
function uuidParams(router: Router, ...names: string[]) {
  for (const name of names) {
    router.param(name, (_req, _res, next, value: string) => next(UUID.test(value) ? undefined : notFound("Not found")));
  }
  return router;
}

function sendFile(res: Response, body: Buffer, type: string, filename: string, inline: boolean) {
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(body);
}

// --- Job types ----------------------------------------------------------------

const templateSchema = z
  .array(z.object({ kind: z.string().min(1).max(40), title: z.string().min(1).max(120) }))
  .max(50);
const jobTypeSchema = z.object({
  name: z.string().min(1).max(80),
  color: hex.optional(),
  description: text(500),
  taskTemplate: templateSchema.optional(),
  active: z.boolean().optional(),
});

const jobTypesRouter = uuidParams(Router(), "id");

jobTypesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.listJobTypes({ includeInactive: q(req, "all") === "true" }));
  }),
);
jobTypesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.getJobType(param(req, "id")));
  }),
);
jobTypesRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await jobsCore.createJobType(parse(jobTypeSchema, req.body)));
  }),
);
jobTypesRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.updateJobType(param(req, "id"), parse(jobTypeSchema.partial(), req.body)));
  }),
);
jobTypesRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await jobsCore.deleteJobType(param(req, "id"));
    res.status(204).end();
  }),
);

// --- Projects -------------------------------------------------------------------

const projectSchema = z.object({
  name: z.string().min(1).max(200),
  companyId: optionalUuid,
  entityId: optionalUuid,
  status: projectStatus.optional(),
  startsOn: dateOnly,
  endsOn: dateOnly,
  notes: text(5000),
});
const phaseSchema = z.object({
  name: z.string().min(1).max(200),
  sequence: z.number().int().min(0).max(10000).optional(),
  startsOn: dateOnly,
  endsOn: dateOnly,
  notes: text(5000),
});

const projectsRouter = uuidParams(Router(), "id", "phaseId");

projectsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = q(req, "status");
    res.json(
      await jobsCore.listProjects({
        status: status ? parse(projectStatus, status) : undefined,
        q: q(req, "q"),
      }),
    );
  }),
);
projectsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    res.status(201).json(await jobsCore.createProject(parse(projectSchema, req.body), actor(req)));
  }),
);
projectsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.getProject(param(req, "id")));
  }),
);
projectsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.updateProject(param(req, "id"), parse(projectSchema.partial(), req.body)));
  }),
);
projectsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await jobsCore.deleteProject(param(req, "id"));
    res.status(204).end();
  }),
);
projectsRouter.post(
  "/:id/phases",
  asyncHandler(async (req, res) => {
    res.status(201).json(await jobsCore.addPhase(param(req, "id"), parse(phaseSchema, req.body)));
  }),
);
projectsRouter.patch(
  "/:id/phases/:phaseId",
  asyncHandler(async (req, res) => {
    res.json(
      await jobsCore.updatePhase(param(req, "id"), param(req, "phaseId"), parse(phaseSchema.partial(), req.body)),
    );
  }),
);
projectsRouter.delete(
  "/:id/phases/:phaseId",
  asyncHandler(async (req, res) => {
    await jobsCore.deletePhase(param(req, "id"), param(req, "phaseId"));
    res.status(204).end();
  }),
);

// --- Jobs ------------------------------------------------------------------------

const jobSchema = z.object({
  name: z.string().min(1).max(200),
  projectId: optionalUuid,
  phaseId: optionalUuid,
  jobTypeId: optionalUuid,
  status: jobStatus.optional(),
  originLocationId: optionalUuid,
  destinationLocationId: optionalUuid,
  scheduledStart: timestamp,
  scheduledEnd: timestamp,
  notes: text(5000),
});
const createJobSchema = jobSchema.extend({ seedTasks: z.boolean().optional() });

const taskSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.string().min(1).max(40).optional(),
  sequence: z.number().int().min(0).max(10000).optional(),
  status: taskStatus.optional(),
  assigneeEntityId: optionalUuid,
  assigneeUserOid: text(200),
  dueAt: timestamp,
  notes: text(5000),
});

const lineFields = z.object({
  shipmentId: optionalUuid,
  destinationLocationId: optionalUuid,
  destinationLabel: text(200),
  floor: text(80),
  department: text(120),
  crateNo: text(80),
  notes: text(2000),
});
const codesSchema = z.object({ codes: z.array(z.string().max(512)).min(1).max(jobsCore.MAX_BATCH) });
const addCodesSchema = lineFields.extend(codesSchema.shape);
const fromLocationSchema = lineFields.extend({
  locationId: uuid,
  includeContents: z.boolean().optional(),
  perUnit: z.boolean().optional(),
  floorLevel: z.number().int().min(0).max(20).nullish(),
  departmentLevel: z.number().int().min(0).max(20).nullish(),
});
const importSchema = z.object({
  csv: z.string().min(1).max(900_000),
  addMissing: z.boolean().optional(),
  shipmentId: optionalUuid,
});
const idsSchema = z.object({ ids: z.array(uuid).min(1).max(jobsCore.MAX_BATCH) });
const bulkUpdateSchema = idsSchema.extend({ set: lineFields });
const stageOptions = z.object({
  stage: z.string().min(1).max(32),
  shipmentId: optionalUuid,
  via: z.string().regex(VIA_PATTERN, "Use lower_snake_case, such as scan or rfid").optional(),
  deviceId: text(120),
  force: z.boolean().optional(),
  note: text(1000),
});
const advanceSchema = stageOptions.extend(codesSchema.shape);
const lineStageSchema = stageOptions.extend(idsSchema.shape);

const lineFilters = (req: Request): jobsCore.LineFilters => ({
  stage: q(req, "stage"),
  shipmentId: qId(req, "shipmentId", true),
  floor: q(req, "floor"),
  department: q(req, "department"),
  q: q(req, "q"),
  limit: q(req, "limit") ? Number(q(req, "limit")) : undefined,
  offset: q(req, "offset") ? Number(q(req, "offset")) : undefined,
});

const groupBy = z.enum(["floor", "department", "shipment", "origin", "none"]);
const documentFilters = (req: Request): jobsCore.DocumentFilters => ({
  groupBy: parse(groupBy, q(req, "groupBy") ?? "floor"),
  shipmentId: qId(req, "shipmentId", true),
  floor: q(req, "floor"),
  department: q(req, "department"),
  stage: q(req, "stage"),
});

/** API-key callers record as "api" unless they say otherwise; people default to "manual". */
const viaFor = (req: Request, via: string | undefined) => via ?? (req.apiKeyUser ? "api" : "manual");

const jobsRouter = uuidParams(Router(), "id", "taskId", "itemId");

jobsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = q(req, "status");
    res.json(
      await jobsCore.listJobs({
        projectId: qId(req, "projectId"),
        phaseId: qId(req, "phaseId"),
        jobTypeId: qId(req, "jobTypeId"),
        status: status ? parse(jobStatus, status) : undefined,
        q: q(req, "q"),
      }),
    );
  }),
);

// The vocabulary the screens need: stages, task kinds and every lifecycle.
jobsRouter.get("/meta", (_req, res) => {
  res.json({
    stages: stageList(),
    taskKinds: taskKindList(),
    projectStatuses: PROJECT_STATUSES,
    jobStatuses: JOB_STATUSES,
    taskStatuses: TASK_STATUSES,
    shipmentStatuses: SHIPMENT_STATUSES,
  });
});

// Every job line an item is on, for the item page and for a quick "where is
// this supposed to go" lookup.
jobsRouter.get(
  "/for-item/:itemId",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.jobLinesForItem(parse(uuid, param(req, "itemId"))));
  }),
);

jobsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    res.status(201).json(await jobsCore.createJob(parse(createJobSchema, req.body), actor(req)));
  }),
);
jobsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.getJob(param(req, "id")));
  }),
);
jobsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.updateJob(param(req, "id"), parse(jobSchema.partial(), req.body), actor(req)));
  }),
);
jobsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await jobsCore.deleteJob(param(req, "id"));
    res.status(204).end();
  }),
);

jobsRouter.get(
  "/:id/progress",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.getJobProgress(param(req, "id")));
  }),
);

jobsRouter.get(
  "/:id/tasks",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.listTasks(param(req, "id")));
  }),
);
jobsRouter.post(
  "/:id/tasks",
  asyncHandler(async (req, res) => {
    res.status(201).json(await jobsCore.addTask(param(req, "id"), parse(taskSchema, req.body), actor(req)));
  }),
);
jobsRouter.patch(
  "/:id/tasks/:taskId",
  asyncHandler(async (req, res) => {
    res.json(
      await jobsCore.updateTask(
        param(req, "id"),
        param(req, "taskId"),
        parse(taskSchema.partial(), req.body),
        actor(req),
      ),
    );
  }),
);
jobsRouter.delete(
  "/:id/tasks/:taskId",
  asyncHandler(async (req, res) => {
    await jobsCore.deleteTask(param(req, "id"), param(req, "taskId"));
    res.status(204).end();
  }),
);

// Manifest lines.
jobsRouter.get(
  "/:id/items",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const [page, facets] = await Promise.all([
      jobsCore.listJobItems(id, lineFilters(req)),
      jobsCore.manifestFacets(id),
    ]);
    res.json({ ...page, ...facets });
  }),
);
jobsRouter.post(
  "/:id/items",
  asyncHandler(async (req, res) => {
    const { codes, ...fields } = parse(addCodesSchema, req.body);
    res.json(await jobsCore.addItemsByCodes(param(req, "id"), codes, fields, actor(req)));
  }),
);
jobsRouter.post(
  "/:id/items/from-location",
  asyncHandler(async (req, res) => {
    const { locationId, ...opts } = parse(fromLocationSchema, req.body);
    res.json(await jobsCore.addItemsFromLocation(param(req, "id"), locationId, opts, actor(req)));
  }),
);
jobsRouter.post(
  "/:id/items/import",
  asyncHandler(async (req, res) => {
    const { csv, ...opts } = parse(importSchema, req.body);
    res.json(await jobsCore.importManifestCsv(param(req, "id"), csv, opts, actor(req)));
  }),
);
jobsRouter.patch(
  "/:id/items",
  asyncHandler(async (req, res) => {
    const { ids, set } = parse(bulkUpdateSchema, req.body);
    res.json(await jobsCore.updateJobItems(param(req, "id"), ids, set));
  }),
);
jobsRouter.post(
  "/:id/items/remove",
  asyncHandler(async (req, res) => {
    const { ids } = parse(idsSchema, req.body);
    res.json(await jobsCore.removeJobItems(param(req, "id"), ids));
  }),
);
jobsRouter.post(
  "/:id/items/stage",
  asyncHandler(async (req, res) => {
    const { ids, via, ...opts } = parse(lineStageSchema, req.body);
    const who = actor(req);
    res.json(
      await jobsCore.setLineStage(param(req, "id"), ids, opts.stage, {
        ...opts,
        via: viaFor(req, via),
        userOid: who.userOid,
        actor: who.name,
      }),
    );
  }),
);

// Scans to a stage: the endpoint a scanning screen, a reader script or a
// portal calls. See advanceStage for what each result bucket means.
jobsRouter.post(
  "/:id/advance",
  asyncHandler(async (req, res) => {
    const { codes, via, ...opts } = parse(advanceSchema, req.body);
    const who = actor(req);
    res.json(
      await jobsCore.advanceStage(param(req, "id"), codes, opts.stage, {
        ...opts,
        via: viaFor(req, via),
        userOid: who.userOid,
        actor: who.name,
      }),
    );
  }),
);

jobsRouter.get(
  "/:id/history",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(q(req, "limit") ?? 100) || 100, 1), 1000);
    res.json(await jobsCore.stageHistory(param(req, "id"), limit));
  }),
);

jobsRouter.get(
  "/:id/manifest.pdf",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const pdf = await jobsCore.jobManifestPdf(id, documentFilters(req), tz(req));
    sendFile(res, pdf, "application/pdf", "manifest.pdf", true);
  }),
);
jobsRouter.get(
  "/:id/manifest.xlsx",
  asyncHandler(async (req, res) => {
    const xlsx = await jobsCore.jobManifestXlsx(param(req, "id"), documentFilters(req));
    sendFile(res, xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "manifest.xlsx", false);
  }),
);

// --- Shipments --------------------------------------------------------------------

const number = z.number().finite().min(0).max(1e9).nullish();
const shipmentFields = z.object({
  name: z.string().min(1).max(200),
  vehicleLocationId: optionalUuid,
  carrier: text(200),
  sealNumbers: z.array(z.string().max(80)).max(50).optional(),
  weightKg: number,
  volumeM3: number,
  distanceKm: number,
  eta: timestamp,
  notes: text(5000),
});
const createShipmentSchema = shipmentFields.extend({ jobId: uuid });
const statusSchema = z.object({
  status: shipmentStatus,
  force: z.boolean().optional(),
  reason: text(1000),
});

const shipmentsRouter = uuidParams(Router(), "id");

shipmentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = q(req, "status");
    res.json(
      await jobsCore.listShipments({
        jobId: qId(req, "jobId"),
        status: status ? parse(shipmentStatus, status) : undefined,
      }),
    );
  }),
);
shipmentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    res.status(201).json(await jobsCore.createShipment(parse(createShipmentSchema, req.body), actor(req)));
  }),
);
shipmentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.getShipment(param(req, "id")));
  }),
);
shipmentsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await jobsCore.updateShipment(param(req, "id"), parse(shipmentFields.partial(), req.body)));
  }),
);
shipmentsRouter.post(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const { status, ...opts } = parse(statusSchema, req.body);
    res.json(await jobsCore.setShipmentStatus(param(req, "id"), status, opts, actor(req)));
  }),
);
shipmentsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await jobsCore.deleteShipment(param(req, "id"));
    res.status(204).end();
  }),
);
shipmentsRouter.get(
  "/:id/load-sheet.pdf",
  asyncHandler(async (req, res) => {
    const pdf = await jobsCore.shipmentLoadSheetPdf(param(req, "id"), tz(req));
    sendFile(res, pdf, "application/pdf", "load-sheet.pdf", true);
  }),
);

// --- Mount ------------------------------------------------------------------------

export const jobsCoreRouter = Router();

jobsCoreRouter.use(
  ["/projects", "/jobs", "/shipments", "/job-types"],
  asyncHandler(async (_req, _res, next) => {
    if (!(await getConfig()).features.jobs) {
      throw new HttpError(
        404,
        "feature_disabled",
        "Projects, jobs and shipments are switched off. An administrator can turn them on in Settings.",
      );
    }
    next();
  }),
);
jobsCoreRouter.use("/job-types", jobTypesRouter);
jobsCoreRouter.use("/projects", projectsRouter);
jobsCoreRouter.use("/jobs", jobsRouter);
jobsCoreRouter.use("/shipments", shipmentsRouter);

// An id for a location, holder, group or job type that does not exist gets
// to the database as a foreign key; answer with what to fix, not a 500.
const referenceErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  const missing = missingReference(err);
  next(missing ? badRequest(`${missing} not found. Pick one that exists.`) : err);
};
jobsCoreRouter.use(["/projects", "/jobs", "/shipments", "/job-types"], referenceErrors);
