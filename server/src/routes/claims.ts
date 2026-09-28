import { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { z } from "zod";
import { currentUser } from "../auth/middleware";
import { env } from "../env";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { asyncHandler, param, parse } from "../lib/http";
import { rateLimit } from "../lib/rateLimit";
import { getConfig } from "../services/config";
import {
  CLAIM_STATUSES,
  CLAIM_TYPES,
  INCIDENT_CATEGORIES,
  RESOLUTIONS,
  RESOLUTION_LABELS,
  STATUS_LABELS,
  TRANSITIONS,
  TYPE_INFO,
  addComment,
  addLines,
  assignClaim,
  availability,
  claimCandidates,
  claimPdf,
  claimXlsx,
  createClaim,
  deleteClaim,
  detectShapes,
  getClaim,
  getEvidence,
  listClaims,
  listReviewers,
  portalFileClaim,
  portalView,
  recordExport,
  removeLine,
  setStatus,
  updateClaim,
  updateLine,
  hashPortalToken,
  type ClaimActor,
} from "../services/claims";

/**
 * /api/claims, and /api/claims-portal for filing through an external portal
 * link. Both answer 404 while the "claims" feature is switched off, so a
 * disabled feature is disabled for scripts too.
 */

const actorOf = (req: Request): ClaimActor => {
  const user = currentUser(req);
  return { userOid: user.oid, name: user.name || null, role: user.role, email: user.email || null };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().uuid();
const text = (max: number) => z.string().max(max).nullish();
// Integer cents, within what a bigint column and a JavaScript number both hold exactly.
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish();
const timestamp = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Use an ISO 8601 date and time")
  .nullish();

const lineInput = z.object({
  jobItemId: uuid.nullish(),
  itemId: uuid.nullish(),
  unitId: uuid.nullish(),
  code: text(500),
  description: text(500),
  damageDescription: text(4000),
  estimatedCents: cents,
  notes: text(2000),
});

const claimFields = {
  title: z.string().min(1).max(200),
  description: text(10000),
  category: text(40),
  jobId: uuid.nullish(),
  shipmentId: uuid.nullish(),
  locationId: uuid.nullish(),
  occurredAt: timestamp,
  carrierReference: text(200),
  insurerReference: text(200),
  estimatedTotalCents: cents,
  reporterName: text(200),
  reporterEmail: text(320),
};

const createSchema = z.object({
  type: z.enum(CLAIM_TYPES),
  ...claimFields,
  relatedClaimId: uuid.nullish(),
  lines: z.array(lineInput).max(1000).optional(),
});

const patchSchema = z
  .object({
    type: z.enum(CLAIM_TYPES),
    ...claimFields,
    approvedTotalCents: cents,
    paymentReference: text(200),
    slaDueAt: timestamp,
  })
  .partial();

const linePatchSchema = z.object({
  description: text(500),
  damageDescription: text(4000),
  estimatedCents: cents,
  approvedCents: cents,
  resolution: z.enum(RESOLUTIONS).nullish(),
  notes: text(2000),
});

const statusSchema = z.object({
  status: z.enum(CLAIM_STATUSES),
  note: text(4000),
  paidTotalCents: cents,
  paymentReference: text(200),
});

const q = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

function qId(req: Request, name: string): string | undefined {
  const v = q(req, name);
  if (v === undefined || UUID.test(v)) return v;
  throw badRequest(`${name} must be an id.`);
}

function sendFile(res: Response, body: Buffer, type: string, filename: string, inline: boolean) {
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(body);
}

const claimsRouter = Router();
// A malformed id is a claim that does not exist, not a database error.
for (const name of ["id", "lineId"]) {
  claimsRouter.param(name, (_req, _res, next, value: string) => next(UUID.test(value) ? undefined : notFound("Not found")));
}

claimsRouter.get(
  "/meta",
  asyncHandler(async (_req, res) => {
    const config = await getConfig();
    res.json({
      types: CLAIM_TYPES.map((t) => TYPE_INFO[t]),
      statuses: CLAIM_STATUSES.map((s) => ({ status: s, label: STATUS_LABELS[s] })),
      resolutions: RESOLUTIONS.map((r) => ({ resolution: r, label: RESOLUTION_LABELS[r] })),
      incidentCategories: INCIDENT_CATEGORIES,
      transitions: TRANSITIONS,
      sla: { claimHours: env.CLAIMS_SLA_HOURS, incidentHours: env.INCIDENT_SLA_HOURS },
      sources: availability(await detectShapes()),
      jobs: config.features.jobs,
      currency: config.currency,
    });
  }),
);

claimsRouter.get(
  "/reviewers",
  asyncHandler(async (req, res) => {
    res.json(await listReviewers(actorOf(req)));
  }),
);

claimsRouter.get(
  "/candidates",
  asyncHandler(async (req, res) => {
    const jobId = qId(req, "jobId");
    if (!jobId) throw badRequest("Pick a job to list its lines.");
    res.json(await claimCandidates(jobId, qId(req, "shipmentId")));
  }),
);

claimsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const statuses = q(req, "status")?.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = statuses?.find((s) => !(CLAIM_STATUSES as readonly string[]).includes(s));
    if (bad) throw badRequest(`Unknown status "${bad}".`);
    const type = q(req, "type");
    if (type && !(CLAIM_TYPES as readonly string[]).includes(type)) throw badRequest(`Unknown type "${type}".`);
    const kind = q(req, "kind");
    if (kind && kind !== "claim" && kind !== "incident") throw badRequest('kind is "claim" or "incident".');
    const assignee = q(req, "assignee");
    res.json(
      await listClaims({
        status: statuses as (typeof CLAIM_STATUSES)[number][] | undefined,
        type: type as (typeof CLAIM_TYPES)[number] | undefined,
        kind: kind as "claim" | "incident" | undefined,
        jobId: qId(req, "jobId"),
        shipmentId: qId(req, "shipmentId"),
        assignee: assignee === "me" ? currentUser(req).oid : assignee,
        q: q(req, "q"),
        overdue: q(req, "overdue") === "true",
        limit: Number(q(req, "limit") ?? 200) || 200,
        offset: Number(q(req, "offset") ?? 0) || 0,
      }),
    );
  }),
);

claimsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createClaim(parse(createSchema, req.body), actorOf(req)));
  }),
);

claimsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await getClaim(param(req, "id"), actorOf(req)));
  }),
);

claimsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await updateClaim(param(req, "id"), parse(patchSchema, req.body), actorOf(req)));
  }),
);

claimsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteClaim(param(req, "id"), actorOf(req));
    res.status(204).end();
  }),
);

claimsRouter.get(
  "/:id/evidence",
  asyncHandler(async (req, res) => {
    res.json(await getEvidence(param(req, "id")));
  }),
);

claimsRouter.post(
  "/:id/lines",
  asyncHandler(async (req, res) => {
    const { lines } = parse(z.object({ lines: z.array(lineInput).min(1).max(1000) }), req.body);
    res.json(await addLines(param(req, "id"), lines, actorOf(req)));
  }),
);

claimsRouter.patch(
  "/:id/lines/:lineId",
  asyncHandler(async (req, res) => {
    res.json(await updateLine(param(req, "id"), param(req, "lineId"), parse(linePatchSchema, req.body), actorOf(req)));
  }),
);

claimsRouter.delete(
  "/:id/lines/:lineId",
  asyncHandler(async (req, res) => {
    res.json(await removeLine(param(req, "id"), param(req, "lineId"), actorOf(req)));
  }),
);

claimsRouter.post(
  "/:id/status",
  asyncHandler(async (req, res) => {
    res.json(await setStatus(param(req, "id"), parse(statusSchema, req.body), actorOf(req)));
  }),
);

claimsRouter.post(
  "/:id/assign",
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ userOid: z.string().min(1).max(300).nullable().optional(), me: z.boolean().optional() }), req.body);
    const userOid = body.me ? currentUser(req).oid : body.userOid ?? null;
    res.json(await assignClaim(param(req, "id"), { userOid }, actorOf(req)));
  }),
);

claimsRouter.post(
  "/:id/comments",
  asyncHandler(async (req, res) => {
    const { body } = parse(z.object({ body: z.string().min(1).max(10000) }), req.body);
    res.status(201).json(await addComment(param(req, "id"), body, actorOf(req)));
  }),
);

/** The viewer's time zone for printed timestamps. */
const tz = (req: Request) => q(req, "tz") ?? "UTC";

claimsRouter.get(
  "/:id/claim.pdf",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const { code, pdf } = await claimPdf(id, tz(req));
    await recordExport(id, "pdf", actorOf(req));
    sendFile(res, pdf, "application/pdf", `${code}.pdf`, true);
  }),
);

claimsRouter.get(
  "/:id/claim.xlsx",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const { code, xlsx } = await claimXlsx(id, tz(req));
    await recordExport(id, "xlsx", actorOf(req));
    sendFile(res, xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `${code}.xlsx`, false);
  }),
);

// A location, job or item id that does not exist reaches the database as a
// foreign key; answer with what to fix, not a 500.
const referenceErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 10; depth++) {
    const e = cur as { code?: unknown; detail?: unknown; cause?: unknown };
    if (e.code === "23503") {
      const column = /Key \(([a-z_]+)\)/.exec(String(e.detail ?? ""))?.[1] ?? "linked record";
      const words = column.replace(/_id$/, "").replace(/_/g, " ");
      return next(badRequest(`${words.charAt(0).toUpperCase()}${words.slice(1)} not found. Pick one that exists.`));
    }
    cur = e.cause;
  }
  next(err);
};

const featureGate = asyncHandler(async (_req, _res, next) => {
  if (!(await getConfig()).features.claims) {
    throw new HttpError(
      404,
      "feature_disabled",
      "Claims and incidents are switched off. An administrator can turn them on in Settings.",
    );
  }
  next();
});

export const claimsApiRouter = Router();
claimsApiRouter.use("/claims", featureGate, claimsRouter, referenceErrors);

// --- Portal ------------------------------------------------------------------------

const portalBody = z.object({
  type: z.enum(CLAIM_TYPES),
  title: text(200),
  description: z.string().min(1, "Say what happened").max(10000),
  occurredAt: timestamp,
  contactEmail: text(320),
  lines: z
    .array(
      z.object({
        jobItemId: uuid,
        damageDescription: text(4000),
        estimatedCents: cents,
      }),
    )
    .max(500),
});

/**
 * The link token travels in the X-Portal-Token header (or as a bearer token),
 * never in the URL, which ends up in logs; a browser that entered an emailed
 * code sends its pass in X-Portal-Pass. The same as the portal's own API.
 */
const presentedToken = (req: Request): string | null => {
  const header = req.get("x-portal-token")?.trim();
  if (header) return header;
  const auth = req.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7).trim() || null : null;
};
const presentedPass = (req: Request): string | null => req.get("x-portal-pass")?.trim() || null;

// Keyed on the token (hashed, so the limiter's memory holds no live tokens) and
// the caller's address, so one leaked link cannot be hammered from anywhere.
const portalKey = (req: Request) => `${req.ip}:${hashPortalToken(presentedToken(req) ?? "").slice(0, 16)}`;
const portalReadLimit = rateLimit({ windowMs: 60_000, max: 60, key: portalKey });
const portalFileLimit = rateLimit({ windowMs: 10 * 60_000, max: 5, key: portalKey });

/**
 * Mounted before the session middleware, like the portal: a link is its own
 * credential, and a portal request never reads or creates a session. The
 * service checks the link on every request and answers as the portal does:
 * 404 when there is no portal, 401 for a link that does not work, has been
 * revoked or has expired, or still needs its emailed code.
 */
export const claimsPortalRouter = Router();
claimsPortalRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});
claimsPortalRouter.use(featureGate);
claimsPortalRouter.get(
  "/",
  portalReadLimit,
  asyncHandler(async (req, res) => {
    res.json(await portalView(presentedToken(req), presentedPass(req)));
  }),
);
claimsPortalRouter.post(
  "/claims",
  portalFileLimit,
  asyncHandler(async (req, res) => {
    res.status(201).json(await portalFileClaim(presentedToken(req), parse(portalBody, req.body), presentedPass(req)));
  }),
);
