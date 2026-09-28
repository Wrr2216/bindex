import { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { currentUser, requireAdmin } from "../auth/middleware";
import { rateLimit } from "../lib/rateLimit";
import { env } from "../env";
import { getConfig } from "../services/config";
import * as crew from "../services/crew";
import { CREDENTIAL_STATUSES, CREW_POLICIES, LIGHTS, type BadgeData, type CrewActor } from "../services/crew";
import type { CrewWorker } from "../db/schema";

/**
 * /api/crew: workers, credentials, badges, check-in on jobs, timesheets. The
 * whole set answers 404 while the "crew" feature is switched off, and the
 * check-in routes also while jobs are, since check-ins belong to jobs.
 */

const actor = (req: Request): CrewActor => {
  const user = currentUser(req);
  return { userOid: user.oid, name: user.name, isAdmin: user.role === "admin" };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().uuid();
const text = (max: number) => z.string().max(max).nullish();
const dateOnly = z
  .string()
  .refine((s) => crew.isDateOnly(s), "Use a date such as 2027-03-31")
  .nullish();
const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Use an ISO 8601 date and time");
const via = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "via must be lower_snake_case");
const tzField = z.string().max(64).optional();
const breakMinutes = z.number().int().min(0).max(1440);

const q = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};
const tz = (req: Request) => crew.validTimeZone(q(req, "tz")) ?? "UTC";
const today = (req: Request) => crew.localDate(new Date(), tz(req));

function qId(req: Request, name: string): string | undefined {
  const v = q(req, name);
  if (v === undefined || UUID.test(v)) return v;
  throw badRequest(`${name} must be an id.`);
}

function qDate(req: Request, name: string): string | undefined {
  const v = q(req, name);
  if (v === undefined || crew.isDateOnly(v)) return v;
  throw badRequest(`${name} must be a date such as 2026-09-01.`);
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

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "crew";

export const crewRouter = uuidParams(Router(), "id", "jobId");

crewRouter.use(
  asyncHandler(async (_req, _res, next) => {
    if (!(await getConfig()).features.crew) {
      throw new HttpError(404, "feature_disabled", "Crew check-in is switched off. An administrator can turn it on in Settings.");
    }
    next();
  }),
);

crewRouter.get(
  "/status",
  asyncHandler(async (req, res) => {
    const config = await getConfig();
    res.json({
      verifier: { available: crew.verifierAvailable() },
      digest: { days: env.CREW_EXPIRY_ALERT_DAYS, hourUtc: env.CREW_DIGEST_HOUR_UTC },
      jobs: config.features.jobs,
      isAdmin: actor(req).isAdmin,
    });
  }),
);

// --- Credential types ----------------------------------------------------------

const credentialTypeSchema = z.object({
  key: z.string().max(40).optional(),
  name: z.string().min(1).max(80),
  description: text(500),
  validityMonths: z.number().int().min(1).max(600).nullish(),
  warnDays: z.number().int().min(0).max(365).optional(),
  active: z.boolean().optional(),
});

crewRouter.get(
  "/credential-types",
  asyncHandler(async (req, res) => {
    res.json(await crew.listCredentialTypes({ includeInactive: q(req, "all") === "true" }));
  }),
);
crewRouter.post(
  "/credential-types",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await crew.createCredentialType(parse(credentialTypeSchema, req.body)));
  }),
);
crewRouter.patch(
  "/credential-types/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const patch = parse(credentialTypeSchema.omit({ key: true }).partial().strict(), req.body);
    res.json(await crew.updateCredentialType(param(req, "id"), patch));
  }),
);
crewRouter.delete(
  "/credential-types/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await crew.deleteCredentialType(param(req, "id"));
    res.status(204).end();
  }),
);

// --- Job type policies -----------------------------------------------------------

crewRouter.get(
  "/job-types",
  asyncHandler(async (_req, res) => {
    res.json(await crew.listJobTypePolicies());
  }),
);
crewRouter.put(
  "/job-types/:id/policy",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        required: z.array(z.string().min(1).max(40)).max(50),
        policy: z.enum(CREW_POLICIES),
        overrideAdminOnly: z.boolean().optional(),
      }),
      req.body,
    );
    res.json(await crew.setJobTypePolicy(param(req, "id"), body, actor(req)));
  }),
);

// --- Workers ----------------------------------------------------------------------

const workerSchema = z.object({
  name: z.string().min(1).max(200),
  company: text(200),
  role: text(120),
  badgeCode: z.string().max(64).optional(),
  phone: text(60),
  active: z.boolean().optional(),
  notes: text(5000),
  photoAttachmentId: uuid.nullish(),
});

crewRouter.get(
  "/workers",
  asyncHandler(async (req, res) => {
    const active = q(req, "active") ?? "true";
    const light = q(req, "light");
    const expiring = q(req, "expiring");
    if (expiring !== undefined && !/^\d{1,4}$/.test(expiring)) throw badRequest("expiring must be a number of days.");
    res.json(
      await crew.listWorkers(
        {
          q: q(req, "q"),
          company: q(req, "company"),
          active: active === "all" ? undefined : active !== "false",
          light: light ? parse(z.enum([...LIGHTS, "none"]), light) : undefined,
          credentialType: q(req, "credentialType"),
          expiringWithin: expiring === undefined ? undefined : Number(expiring),
        },
        today(req),
      ),
    );
  }),
);
crewRouter.post(
  "/workers",
  asyncHandler(async (req, res) => {
    const input = parse(workerSchema.omit({ photoAttachmentId: true }), req.body);
    res.status(201).json(await crew.createWorker(input, actor(req)));
  }),
);
crewRouter.get(
  "/workers/by-badge/:code",
  asyncHandler(async (req, res) => {
    const code = crew.badgeCodeFromScan(param(req, "code"));
    const worker = code ? await crew.findWorkerByBadge(code) : null;
    if (!worker) throw new HttpError(404, "unknown_badge", `No worker has badge ${code ?? ""}.`);
    res.json({ id: worker.id, name: worker.name, active: worker.active });
  }),
);
crewRouter.get(
  "/workers/:id",
  asyncHandler(async (req, res) => {
    res.json(await crew.getWorker(param(req, "id"), today(req)));
  }),
);
crewRouter.patch(
  "/workers/:id",
  asyncHandler(async (req, res) => {
    res.json(await crew.updateWorker(param(req, "id"), parse(workerSchema.partial(), req.body), actor(req)));
  }),
);
crewRouter.delete(
  "/workers/:id",
  asyncHandler(async (req, res) => {
    await crew.deleteWorker(param(req, "id"), actor(req));
    res.status(204).end();
  }),
);
crewRouter.post(
  "/workers/:id/reissue-badge",
  asyncHandler(async (req, res) => {
    res.json(await crew.reissueBadge(param(req, "id"), actor(req)));
  }),
);

// Each call reaches an outside service, which may charge per check.
const verifyLimit = rateLimit({ windowMs: 60_000, max: 30, key: (req) => currentUser(req).oid });

crewRouter.post(
  "/workers/:id/verify",
  verifyLimit,
  asyncHandler(async (req, res) => {
    const worker = await crew.loadWorker(param(req, "id"));
    const result = await crew.verifyWorker(worker, await crew.credentialTypesByKey());
    res.json(result);
  }),
);

// --- Badges -----------------------------------------------------------------------

async function badgeData(worker: CrewWorker): Promise<BadgeData> {
  const config = await getConfig();
  return {
    name: worker.name,
    company: worker.company,
    role: worker.role,
    code: worker.badgeCode,
    title: config.orgName.trim() || config.appName,
    accent: config.accentColor,
    photo: await crew.badgePhoto(worker),
  };
}

const layout = (req: Request): "card" | "sheet" => (q(req, "layout") === "sheet" ? "sheet" : "card");

crewRouter.get(
  "/workers/:id/badge.png",
  asyncHandler(async (req, res) => {
    const worker = await crew.loadWorker(param(req, "id"));
    sendFile(res, await crew.badgePng(await badgeData(worker)), "image/png", `badge-${safeName(worker.badgeCode)}.png`, true);
  }),
);
crewRouter.get(
  "/workers/:id/badge.pdf",
  asyncHandler(async (req, res) => {
    const worker = await crew.loadWorker(param(req, "id"));
    const pdf = await crew.badgesPdf([await badgeData(worker)], layout(req));
    sendFile(res, pdf, "application/pdf", `badge-${safeName(worker.badgeCode)}.pdf`, true);
  }),
);
crewRouter.get(
  "/badges.pdf",
  asyncHandler(async (req, res) => {
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) throw badRequest("Pick at least one worker to print.");
    if (ids.length > 300) throw badRequest("Print at most 300 badges at a time.");
    if (ids.some((id) => !UUID.test(id))) throw badRequest("ids must be worker ids, separated by commas.");
    const workers = await Promise.all(ids.map((id) => crew.loadWorker(id)));
    const data = [];
    for (const w of workers) data.push(await badgeData(w));
    sendFile(res, await crew.badgesPdf(data, layout(req)), "application/pdf", "badges.pdf", true);
  }),
);

// --- Credentials ------------------------------------------------------------------

const credentialSchema = z.object({
  typeId: uuid.optional(),
  typeKey: z.string().max(40).optional(),
  issuer: text(200),
  number: text(120),
  issuedOn: dateOnly,
  expiresOn: dateOnly,
  status: z.enum(CREDENTIAL_STATUSES).optional(),
  notes: text(2000),
});

crewRouter.post(
  "/workers/:id/credentials",
  asyncHandler(async (req, res) => {
    // expiresOn left out is worked out from the type's validity; null means "does not expire".
    res.status(201).json(await crew.addCredential(param(req, "id"), parse(credentialSchema, req.body), actor(req)));
  }),
);
crewRouter.patch(
  "/credentials/:id",
  asyncHandler(async (req, res) => {
    const body = parse(credentialSchema.omit({ typeId: true, typeKey: true }).partial().strict(), req.body);
    res.json(await crew.updateCredential(param(req, "id"), body, actor(req)));
  }),
);
crewRouter.delete(
  "/credentials/:id",
  asyncHandler(async (req, res) => {
    await crew.deleteCredential(param(req, "id"), actor(req));
    res.status(204).end();
  }),
);

// --- Check-in on jobs -----------------------------------------------------------

const needsJobs = asyncHandler(async (_req, _res, next) => {
  if (!(await getConfig()).features.jobs) {
    throw new HttpError(
      404,
      "feature_disabled",
      "Checking crew in happens on jobs, and Projects, jobs and shipments are switched off. An administrator can turn them on in Settings.",
    );
  }
  next();
});
crewRouter.use(["/jobs", "/checkins", "/timesheet", "/timesheet.xlsx"], needsJobs);

const defaultVia = (req: Request) => (req.apiKeyUser ? "api" : "manual");

crewRouter.get(
  "/jobs",
  asyncHandler(async (_req, res) => {
    res.json(await crew.listCrewJobs());
  }),
);
crewRouter.get(
  "/jobs/:jobId/roster",
  asyncHandler(async (req, res) => {
    res.json(await crew.roster(param(req, "jobId"), tz(req)));
  }),
);
crewRouter.get(
  "/jobs/:jobId/candidates",
  asyncHandler(async (req, res) => {
    res.json(await crew.candidates(param(req, "jobId"), q(req, "q") ?? "", tz(req)));
  }),
);

const checkInSchema = z.object({
  code: z.string().min(1).max(500).optional(),
  workerId: uuid.optional(),
  via: via.optional(),
  tz: tzField,
  overrideReason: text(1000),
  switchJob: z.boolean().optional(),
  note: text(1000),
});

crewRouter.post(
  "/jobs/:jobId/checkins",
  asyncHandler(async (req, res) => {
    const body = parse(checkInSchema, req.body);
    if (!body.code && !body.workerId) throw badRequest("Scan a badge (code) or pick a worker (workerId).");
    const outcome = await crew.checkIn(param(req, "jobId"), { ...body, via: body.via ?? defaultVia(req) }, actor(req));
    res.status(outcome.status === "checked_in" ? 201 : 200).json(outcome);
  }),
);

const checkOutSchema = z.object({
  at: timestamp.nullish(),
  breakMinutes: breakMinutes.optional(),
  note: text(1000),
});

crewRouter.post(
  "/jobs/:jobId/checkout",
  asyncHandler(async (req, res) => {
    const body = parse(checkOutSchema.extend({ code: z.string().min(1).max(500).optional(), workerId: uuid.optional() }), req.body);
    if (!body.code && !body.workerId) throw badRequest("Scan a badge (code) or pick a worker (workerId).");
    res.json(await crew.checkOutByCode(param(req, "jobId"), body, actor(req)));
  }),
);
crewRouter.post(
  "/jobs/:jobId/checkout-all",
  asyncHandler(async (req, res) => {
    res.json(await crew.checkOutAll(param(req, "jobId"), parse(checkOutSchema, req.body ?? {}), actor(req)));
  }),
);
crewRouter.post(
  "/checkins/:id/checkout",
  asyncHandler(async (req, res) => {
    res.json(await crew.checkOut(param(req, "id"), parse(checkOutSchema, req.body ?? {}), actor(req)));
  }),
);
crewRouter.patch(
  "/checkins/:id",
  asyncHandler(async (req, res) => {
    const body = parse(
      z
        .object({
          checkedInAt: timestamp.optional(),
          checkedOutAt: timestamp.nullable().optional(),
          breakMinutes: breakMinutes.optional(),
          notes: text(2000),
        })
        .strict(),
      req.body,
    );
    res.json(await crew.updateCheckin(param(req, "id"), body, actor(req)));
  }),
);
crewRouter.delete(
  "/checkins/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await crew.deleteCheckin(param(req, "id"), actor(req));
    res.status(204).end();
  }),
);

// --- Timesheets and expiry ---------------------------------------------------------

function timesheetFilters(req: Request): crew.TimesheetFilters {
  return {
    jobId: qId(req, "jobId"),
    workerId: qId(req, "workerId"),
    from: qDate(req, "from"),
    to: qDate(req, "to"),
    tz: tz(req),
  };
}

crewRouter.get(
  "/timesheet",
  asyncHandler(async (req, res) => {
    const rows = await crew.timesheetRows(timesheetFilters(req));
    res.json({
      rows,
      roster: crew.rosterFromRows(rows),
      totals: { minutes: rows.reduce((s, r) => s + r.minutes, 0), shifts: rows.length, workers: new Set(rows.map((r) => r.workerId)).size },
    });
  }),
);
crewRouter.get(
  "/timesheet.xlsx",
  asyncHandler(async (req, res) => {
    const filters = timesheetFilters(req);
    const config = await getConfig();
    let scope = "All jobs";
    if (filters.jobId) {
      const roster = await crew.roster(filters.jobId, filters.tz);
      scope = `${roster.job.code} ${roster.job.name}`;
    }
    const title = `${config.orgName.trim() || config.appName}: crew timesheet, ${scope}`;
    const body = await crew.timesheetXlsx(filters, title);
    const name = ["timesheet", filters.jobId ? scope.split(" ")[0] : "all", filters.from, filters.to].filter(Boolean).join("-");
    sendFile(res, body, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `${safeName(name)}.xlsx`, false);
  }),
);

crewRouter.get(
  "/expiring",
  asyncHandler(async (req, res) => {
    const days = q(req, "days");
    if (days !== undefined && !/^\d{1,4}$/.test(days)) throw badRequest("days must be a number.");
    res.json(await crew.expiringCredentials(days === undefined ? env.CREW_EXPIRY_ALERT_DAYS || 30 : Number(days), today(req)));
  }),
);
crewRouter.post(
  "/expiry-digest",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ tz: tzField }), req.body ?? {});
    res.json(await crew.sendCrewDigest({ force: true, tz: crew.validTimeZone(body.tz) ?? undefined }));
  }),
);

// A worker, credential type or job that does not exist reaches the database as
// a foreign key; answer with what to fix, not a 500.
const referenceErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  next(crew.isForeignKeyViolation(err) ? badRequest("That refers to a record that no longer exists. Refresh and try again.") : err);
};
crewRouter.use(referenceErrors);
