import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { currentUser, requireAdmin } from "../auth/middleware";
import { getConfig } from "../services/config";
import {
  LOCATION_ROLES,
  RULE_IDS,
  SEVERITIES,
  deleteProfile,
  explainAnomaly,
  explanationsAvailable,
  getAnomaly,
  getSettings,
  invalidateStorage,
  jobLoadPlan,
  listAnomalies,
  listProfiles,
  listStorageItems,
  loadPlanPdf,
  registerOpsEventTypes,
  resolveAnomaly,
  ruleList,
  runAnomalyRules,
  saveProfile,
  shipmentCapacities,
  storageAnalysis,
  summary,
  updateSettings,
  type Severity,
} from "../services/ops-intel";

/**
 * /api/ops: operations insights. Everything answers 404 while the feature is
 * switched off. Reading is open to anyone signed in and to API keys; resolving
 * and running need a read-write caller; thresholds and location profiles
 * change how the instance behaves, so they need an administrator.
 */
export const opsIntelRouter = Router();

// The webhook picker lists event types from every feature, on or off.
registerOpsEventTypes();

const requireOpsFeature: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.opsIntel) return next();
      res.status(404).json({
        error: "Operations insights are switched off. An administrator can turn them on in Settings.",
        code: "feature_disabled",
      });
    })
    .catch(next);
};
opsIntelRouter.use(requireOpsFeature);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A malformed id is a record that does not exist, not a database error.
for (const name of ["id", "locationId", "jobId"]) {
  opsIntelRouter.param(name, (_req, _res, next, value: string) => next(UUID.test(value) ? undefined : notFound("Not found")));
}

const q = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  if (Array.isArray(v)) return typeof v[0] === "string" && v[0].trim() ? v[0].trim() : undefined;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** A list from `?x=a,b` or `?x=a&x=b`. */
const qList = (req: Request, name: string, split = true): string[] => {
  const v = req.query[name];
  const raw = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return raw
    .filter((x): x is string => typeof x === "string")
    .flatMap((x) => (split ? x.split(",") : [x]))
    .map((x) => x.trim())
    .filter(Boolean);
};

function qId(req: Request, name: string): string | undefined {
  const v = q(req, name);
  if (v === undefined || UUID.test(v)) return v;
  throw badRequest(`${name} must be an id.`);
}

function qInt(req: Request, name: string): number | undefined {
  const v = q(req, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`${name} must be a whole number.`);
  return n;
}

const qBool = (req: Request, name: string): boolean | undefined => {
  const v = q(req, name);
  return v === undefined ? undefined : v === "true" || v === "1";
};

// --- Meta and settings -------------------------------------------------------

opsIntelRouter.get(
  "/meta",
  asyncHandler(async (_req, res) => {
    res.json({
      rules: ruleList(),
      severities: SEVERITIES,
      roles: LOCATION_ROLES,
      explanations: { available: explanationsAvailable() },
      settings: await getSettings(),
    });
  }),
);

opsIntelRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json(await getSettings());
  }),
);

const n = z.number().finite();
const on = z.object({ enabled: z.boolean().optional() });
const settingsPatch = z
  .object({
    rules: z
      .object({
        packed_not_loaded: on,
        loaded_not_delivered: on.extend({ graceMinutes: n.optional() }),
        delivered_not_placed: on.extend({ hours: n.optional() }),
        duplicate_identifier: on,
        duplicate_record: on.extend({ maxGroup: n.optional() }),
        impossible_travel: on.extend({
          maxSpeedKmh: n.optional(),
          minDistanceM: n.optional(),
          lookbackHours: n.optional(),
        }),
        zone_mismatch: on.extend({ hours: n.optional() }),
        not_seen: on.extend({ days: n.optional() }),
        multi_shipment: on,
      })
      .partial()
      .optional(),
    jobLookbackDays: n.optional(),
    storage: z
      .object({ windowDays: n, longStoredDays: n, abcA: n, abcB: n })
      .partial()
      .optional(),
    slotting: z.object({ minGainM: n, maxSuggestions: n }).partial().optional(),
    load: z
      .object({
        defaultWeightKg: n.positive(),
        defaultVolumeM3: n.positive(),
        fillFactor: n.min(0.1).max(1),
        categoryDefaults: z
          .record(
            z.string().min(1).max(120),
            z.object({ weightKg: n.positive().nullish(), volumeM3: n.positive().nullish() }),
          )
          .refine((r) => Object.keys(r).length <= 500, "At most 500 category defaults"),
      })
      .partial()
      .optional(),
  })
  .strict();

opsIntelRouter.put(
  "/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const next = await updateSettings(parse(settingsPatch, req.body));
    invalidateStorage();
    res.json(next);
  }),
);

// --- Anomalies -----------------------------------------------------------------

opsIntelRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const days = qInt(req, "days") ?? 30;
    if (days < 1 || days > 365) throw badRequest("days must be between 1 and 365.");
    res.json(await summary(days));
  }),
);

opsIntelRouter.get(
  "/anomalies",
  asyncHandler(async (req, res) => {
    const status = q(req, "status") ?? "open";
    if (!["open", "resolved", "all"].includes(status)) throw badRequest("status must be open, resolved or all.");
    const rule = qList(req, "rule");
    const unknown = rule.filter((r) => !(RULE_IDS as readonly string[]).includes(r));
    if (unknown.length) throw badRequest(`Unknown rule: ${unknown.join(", ")}.`);
    const severity = qList(req, "severity");
    if (severity.some((s) => !(SEVERITIES as readonly string[]).includes(s))) {
      throw badRequest("severity must be low, medium or high.");
    }
    res.json(
      await listAnomalies({
        status: status as "open" | "resolved" | "all",
        rule,
        severity: severity as Severity[],
        itemId: qId(req, "itemId"),
        jobId: qId(req, "jobId"),
        shipmentId: qId(req, "shipmentId"),
        locationId: qId(req, "locationId"),
        q: q(req, "q"),
        limit: qInt(req, "limit"),
        offset: qInt(req, "offset"),
      }),
    );
  }),
);

opsIntelRouter.post(
  "/anomalies/run",
  asyncHandler(async (req, res) => {
    const result = await runAnomalyRules({ trigger: "manual", userOid: currentUser(req).oid });
    if (!result) {
      throw new HttpError(409, "run_in_progress", "A run is already in progress. Try again in a moment.");
    }
    res.json(result);
  }),
);

opsIntelRouter.get(
  "/anomalies/:id",
  asyncHandler(async (req, res) => {
    res.json(await getAnomaly(param(req, "id")));
  }),
);

const resolveSchema = z.object({
  resolution: z.enum(["fixed", "dismissed"]),
  note: z
    .string()
    .trim()
    .min(1, "Say what was done, or why this is not a problem.")
    .max(1000),
});

opsIntelRouter.post(
  "/anomalies/:id/resolve",
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await resolveAnomaly(param(req, "id"), parse(resolveSchema, req.body), { oid: user.oid, name: user.name }));
  }),
);

opsIntelRouter.post(
  "/anomalies/:id/explain",
  asyncHandler(async (req, res) => {
    res.json(await explainAnomaly(param(req, "id")));
  }),
);

// --- Storage and slotting ------------------------------------------------------

opsIntelRouter.get(
  "/storage",
  asyncHandler(async (req, res) => {
    const { report } = await storageAnalysis(qBool(req, "fresh") === true);
    res.json(report);
  }),
);

opsIntelRouter.get(
  "/storage/items",
  asyncHandler(async (req, res) => {
    const abc = q(req, "abc");
    if (abc && !["A", "B", "C"].includes(abc)) throw badRequest("abc must be A, B or C.");
    const sort = q(req, "sort");
    if (sort && !["dwell", "movements", "next"].includes(sort)) throw badRequest("sort must be dwell, movements or next.");
    res.json(
      await listStorageItems({
        abc: abc as "A" | "B" | "C" | undefined,
        locationId: qId(req, "locationId"),
        longStored: qBool(req, "longStored"),
        q: q(req, "q"),
        sort: sort as "dwell" | "movements" | "next" | undefined,
        limit: qInt(req, "limit"),
        offset: qInt(req, "offset"),
      }),
    );
  }),
);

opsIntelRouter.get(
  "/slotting",
  asyncHandler(async (req, res) => {
    const { slotting } = await storageAnalysis(qBool(req, "fresh") === true);
    res.json(slotting);
  }),
);

// --- Location profiles -----------------------------------------------------------

const optNum = (schema: z.ZodNumber) => schema.nullish();
const profileSchema = z
  .object({
    role: z.enum(LOCATION_ROLES as [string, ...string[]]).nullish(),
    distanceToDockM: optNum(n.min(0).max(1_000_000)),
    lat: optNum(n.min(-90).max(90)),
    lng: optNum(n.min(-180).max(180)),
    maxKg: optNum(n.positive().max(1_000_000)),
    maxM3: optNum(n.positive().max(100_000)),
    interiorLengthM: optNum(n.positive().max(1000)),
    interiorWidthM: optNum(n.positive().max(1000)),
    interiorHeightM: optNum(n.positive().max(1000)),
    notes: z.string().max(1000).nullish(),
  })
  .strict();

opsIntelRouter.get(
  "/profiles",
  asyncHandler(async (_req, res) => {
    res.json({ profiles: await listProfiles() });
  }),
);

opsIntelRouter.put(
  "/profiles/:locationId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = parse(profileSchema, req.body) as Parameters<typeof saveProfile>[1];
    const profile = await saveProfile(param(req, "locationId"), input, currentUser(req).oid);
    invalidateStorage();
    res.json({ profile });
  }),
);

opsIntelRouter.delete(
  "/profiles/:locationId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await deleteProfile(param(req, "locationId"));
    invalidateStorage();
    res.status(204).end();
  }),
);

// --- Load planning ----------------------------------------------------------------

function planOptions(req: Request) {
  const vehicles = qList(req, "vehicles");
  const bad = vehicles.filter((v) => !UUID.test(v));
  if (bad.length) throw badRequest("vehicles must be ids of places, separated by commas.");
  if (vehicles.length > 20) throw badRequest("Plan onto at most 20 extra vehicles at once.");
  // Stop keys can hold commas (a written destination), so they come one per parameter.
  const stops = qList(req, "stops", false);
  if (stops.length > 500) throw badRequest("At most 500 stops.");
  return { vehicleLocationIds: vehicles, stops, repack: qBool(req, "repack") === true };
}

opsIntelRouter.get(
  "/load-plans/jobs/:jobId",
  asyncHandler(async (req, res) => {
    res.json(await jobLoadPlan(param(req, "jobId"), planOptions(req)));
  }),
);

opsIntelRouter.get(
  "/load-plans/jobs/:jobId/plan.pdf",
  asyncHandler(async (req, res) => {
    const { job, plan, generatedAt } = await jobLoadPlan(param(req, "jobId"), planOptions(req));
    const pdf = await loadPlanPdf({
      jobCode: job.code,
      jobName: job.name,
      generatedAt,
      timeZone: q(req, "tz"),
      plan,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="load-plan-${job.code}.pdf"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  }),
);

opsIntelRouter.get(
  "/shipments/capacity",
  asyncHandler(async (req, res) => {
    res.json({ shipments: await shipmentCapacities(qId(req, "jobId")) });
  }),
);
