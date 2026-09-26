import { Router, type Request, type RequestHandler, type Response } from "express";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { currentUser, requireAdmin } from "../auth/middleware";
import { env } from "../env";
import { HttpError, badRequest, describeError, notFound } from "../lib/errors";
import { asyncHandler, param, parse } from "../lib/http";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";
import { getConfig } from "../services/config";
import { stageList } from "../services/jobs-core";
import {
  DEFAULT_CONTRIBUTOR_STAGES,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  NOTE_CONDITIONS,
  PORTAL_ROLES,
  PORTAL_SCOPES,
  addNote,
  addPhoto,
  checkPass,
  createGrant,
  documents,
  findGrantByTokenHash,
  flaggedLines,
  getGrant,
  grantActivity,
  grantState,
  hashSecret,
  lineDetail,
  listGrants,
  listLines,
  loadScope,
  looksLikeToken,
  mailAvailable,
  normalizeCode,
  openFile,
  overview,
  portalScan,
  recordAccess,
  recordDenied,
  reissueGrant,
  revokeGrant,
  searchTargets,
  sendCode,
  sessionInfo,
  setNotify,
  signHandoff,
  touchGrant,
  updateGrant,
  verifyCode,
  type GrantState,
  type PortalContext,
} from "../services/portal";
import { grantNotes } from "../services/portal";
import type { PortalGrant } from "../db/schema";

/**
 * T15 routes.
 *
 * `portalRouter` is /api/portal: what a portal link's page calls. It is
 * mounted in index.ts before the session middleware, so a portal request
 * never reads, creates or extends a Bindex session, and trusted mode's
 * automatic owner never applies to it. The link token travels in the
 * X-Portal-Token header (never the query string, which ends up in logs), and
 * a verified browser's pass in X-Portal-Pass.
 *
 * `portalAdminRouter` is /api/portal-grants: administrators managing links,
 * mounted with the rest of the API behind the session.
 */

/**
 * parse() infers its result from the schema's input type, which defaults and
 * transforms widen; this keeps the validated output type.
 */
function parseOut<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  return parse(schema as unknown as z.ZodType<z.output<S>>, value);
}

// ---- Public: rate limits ----------------------------------------------------

const presentedToken = (req: Request): string | null => {
  const header = req.get("x-portal-token");
  if (header) return header.trim();
  const auth = req.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
};

/** Keyed by the token's hash, so a limit follows the link and not the network. */
const byToken = (req: Request): string | null => {
  const token = presentedToken(req);
  return looksLikeToken(token) ? hashSecret(token) : null;
};

// Everything from one address: generous for a crew scanning behind one NAT.
const addressLimit = rateLimit({ windowMs: 60_000, max: 300, key: (req) => req.ip ?? "unknown" });
// Counted only when a link is refused (see refuse()), to slow guessing.
const refusedLimit = rateLimit({ windowMs: 15 * 60_000, max: 30, key: (req) => req.ip ?? "unknown" });
const writeLimit = rateLimit({ windowMs: 60_000, max: 120, key: byToken });
const uploadLimit = rateLimit({ windowMs: 60_000, max: 30, key: byToken });
const codeSendLimit = rateLimit({ windowMs: 15 * 60_000, max: 5, key: byToken });
const codeTryLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, key: byToken });
const codeTryAddressLimit = rateLimit({ windowMs: 15 * 60_000, max: 30, key: (req) => req.ip ?? "unknown" });

/** Run a limiter by hand; resolves to its 429 when over the limit. */
function count(limiter: RequestHandler, req: Request, res: Response): Promise<unknown> {
  return new Promise((resolve) => limiter(req, res, (err?: unknown) => resolve(err ?? null)));
}

// ---- Public: authentication ------------------------------------------------------

type Locals = { grant: PortalGrant; ctx: PortalContext | null };

const locals = (res: Response): Locals => {
  const l = res.locals.portal as Locals | undefined;
  if (!l) throw new Error("portal route reached without authentication");
  return l;
};

/** The verified context; routes other than the code ones require it. */
const ctxOf = (res: Response): PortalContext => {
  const { ctx } = locals(res);
  if (!ctx) throw new HttpError(401, "code_required", "Enter the code we emailed you to open this link.");
  return ctx;
};

const invalidLink = () =>
  new HttpError(401, "link_invalid", "This link does not work. Check you have the whole link, or ask whoever shared it for a new one.");

const STATE_ERRORS: Record<Exclude<GrantState, "active">, () => HttpError> = {
  revoked: () => new HttpError(401, "link_revoked", "This link has been switched off. Ask whoever shared it if you still need access."),
  expired: () => new HttpError(401, "link_expired", "This link has expired. Ask whoever shared it for a new one."),
  no_link: invalidLink,
};

const info = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.get("user-agent") ?? null,
  method: req.method,
  path: req.path,
});

/** Routes a browser may call before it has entered the emailed code. */
const BEFORE_CODE = new Set(["/session", "/code", "/code/verify"]);

const authenticate: RequestHandler = asyncHandler(async (req, res, next) => {
  if (!(await getConfig()).features.portal) {
    throw new HttpError(404, "portal_unavailable", "The portal is not available on this server.");
  }
  const refuse = async (grant: PortalGrant | null, reason: string, error: HttpError) => {
    recordDenied(grant, reason, info(req));
    const limited = await count(refusedLimit, req, res);
    throw limited instanceof HttpError ? limited : error;
  };

  const token = presentedToken(req);
  if (!looksLikeToken(token)) return refuse(null, token ? "malformed" : "missing", invalidLink());
  const grant = await findGrantByTokenHash(hashSecret(token));
  if (!grant) return refuse(null, "unknown", invalidLink());
  const state = grantState(grant);
  if (state !== "active") return refuse(grant, state, STATE_ERRORS[state]());

  const verified = !grant.requireCode || (await checkPass(grant.id, req.get("x-portal-pass")));
  if (!verified && !BEFORE_CODE.has(req.path)) {
    return refuse(grant, "code_required", new HttpError(401, "code_required", "Enter the code we emailed you to open this link."));
  }
  const ctx = verified ? { grant, scope: await loadScope(grant) } : null;
  res.locals.portal = { grant, ctx } satisfies Locals;
  await touchGrant(grant.id);
  recordAccess(grant, info(req));
  next();
});

// ---- Public: routes ----------------------------------------------------------------

export const portalRouter = Router();

portalRouter.use((_req, res, next) => {
  // Nothing a link shows belongs in a shared cache or a search index.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});
portalRouter.use(addressLimit);
portalRouter.use(authenticate);

portalRouter.get(
  "/session",
  asyncHandler(async (_req, res) => {
    const { grant, ctx } = locals(res);
    res.json(await sessionInfo(grant, ctx?.scope ?? null));
  }),
);

portalRouter.post(
  "/code",
  codeSendLimit,
  asyncHandler(async (_req, res) => {
    res.json(await sendCode(locals(res).grant));
  }),
);

const codeSchema = z.object({ code: z.string().max(20) });

portalRouter.post(
  "/code/verify",
  codeTryLimit,
  codeTryAddressLimit,
  asyncHandler(async (req, res) => {
    const { grant } = locals(res);
    if (!grant.requireCode) throw badRequest("This link does not use a code.");
    const code = normalizeCode(parse(codeSchema, req.body).code);
    if (!code) throw badRequest("The code is six digits.");
    res.json(await verifyCode(grant, code, { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null }));
  }),
);

portalRouter.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    res.json(await overview(ctxOf(res)));
  }),
);

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const text = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
const itemsQuery = z.object({
  q: text(200),
  stage: text(40),
  room: text(300),
  floor: text(100),
  department: text(200),
  shipmentId: z.preprocess(blank, z.string().uuid().optional()),
  flag: z.preprocess(blank, z.enum(["flagged", "high_value", "exception", "noted"]).optional()),
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(200).optional()),
  offset: z.preprocess(blank, z.coerce.number().int().min(0).max(1_000_000).optional()),
});

portalRouter.get(
  "/items",
  asyncHandler(async (req, res) => {
    const q = parseOut(itemsQuery, req.query);
    res.json(await listLines(ctxOf(res), q));
  }),
);

portalRouter.get(
  "/items/:lineId",
  asyncHandler(async (req, res) => {
    res.json(await lineDetail(ctxOf(res), param(req, "lineId")));
  }),
);

portalRouter.get(
  "/flagged",
  asyncHandler(async (_req, res) => {
    res.json(await flaggedLines(ctxOf(res)));
  }),
);

portalRouter.get(
  "/documents",
  asyncHandler(async (_req, res) => {
    res.json(await documents(ctxOf(res)));
  }),
);

portalRouter.get(
  "/files/:id",
  asyncHandler(async (req, res) => {
    const raw = Number(req.query.thumb);
    const thumb = Number.isFinite(raw) && raw > 0 ? Math.min(1024, Math.max(64, Math.round(raw))) : undefined;
    const file = await openFile(ctxOf(res), param(req, "id"), thumb);
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Disposition", `${file.inline ? "inline" : "attachment"}; filename="${file.filename}"`);
    if (file.kind === "bytes") {
      res.send(file.bytes);
      return;
    }
    res.setHeader("Content-Length", String(file.size));
    try {
      await pipeline(file.stream, res);
    } catch (err) {
      logger.debug("portal.file.aborted", { err: describeError(err) });
    }
  }),
);

portalRouter.post(
  "/notifications",
  asyncHandler(async (req, res) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const ctx = ctxOf(res);
    res.json({ notify: await setNotify(ctx.grant, enabled) });
  }),
);

const scanSchema = z.object({
  codes: z.array(z.string().max(500)).min(1).max(500),
  stage: z.string().min(1).max(40),
  shipmentId: z.string().uuid().nullish(),
  note: z.string().max(500).nullish(),
});

portalRouter.post(
  "/scan",
  writeLimit,
  asyncHandler(async (req, res) => {
    res.json(await portalScan(ctxOf(res), parse(scanSchema, req.body)));
  }),
);

const noteSchema = z.object({
  body: z.string().min(1).max(2000),
  condition: z.enum(NOTE_CONDITIONS).nullish(),
});

portalRouter.post(
  "/items/:lineId/notes",
  writeLimit,
  asyncHandler(async (req, res) => {
    const input = parse(noteSchema, req.body);
    res.status(201).json(await addNote(ctxOf(res), param(req, "lineId"), input));
  }),
);

const photoQuery = z.object({
  stage: text(40),
  caption: text(500),
  type: text(120),
});

// The body is the photo itself, streamed. Send it as application/octet-stream
// with the real type in ?type=, as for /api/attachments.
portalRouter.post(
  "/items/:lineId/photos",
  uploadLimit,
  asyncHandler(async (req, res) => {
    const q = parseOut(photoQuery, req.query);
    if ((req as { _body?: boolean })._body) {
      throw badRequest("Send the photo itself as the request body, with Content-Type application/octet-stream.");
    }
    const length = Number(req.get("content-length"));
    const saved = await addPhoto(ctxOf(res), param(req, "lineId"), {
      body: req,
      mime: q.type || req.get("content-type") || null,
      contentLength: Number.isFinite(length) ? length : null,
      stage: q.stage,
      caption: q.caption,
    });
    res.status(201).json(saved);
  }),
);

const handoffSchema = z.object({
  signerName: z.string().min(1).max(200),
  signerRole: z.string().max(200).nullish(),
  image: z.string().max(800_000),
  shipmentId: z.string().uuid().nullish(),
});

portalRouter.post(
  "/handoff",
  writeLimit,
  asyncHandler(async (req, res) => {
    const input = parse(handoffSchema, req.body);
    res.status(201).json(
      await signHandoff(ctxOf(res), { ...input, ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null }),
    );
  }),
);

// Anything else under /api/portal ends here, rather than falling through to
// the session and the main API.
portalRouter.use((_req, res) => {
  res.status(404).json({ error: "Not found", code: "not_found" });
});

// ---- Administrators ------------------------------------------------------------------

/**
 * requireAdmin reads the session only, so a request carrying an admin cookie
 * and an API key would pass it; the key is authoritative elsewhere, and keys
 * never manage who outside can see inside.
 */
const requireAdminSession: RequestHandler = (req, res, next) => {
  if (req.apiKeyUser) {
    res.status(403).json({ error: "This endpoint requires a browser session", code: "session_required" });
    return;
  }
  requireAdmin(req, res, next);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const portalAdminRouter = Router();

portalAdminRouter.use(
  asyncHandler(async (_req, _res, next) => {
    if (!(await getConfig()).features.portal) {
      throw new HttpError(
        404,
        "feature_disabled",
        "The external portal is switched off. An administrator can turn it on in Settings.",
      );
    }
    next();
  }),
);
portalAdminRouter.use(requireAdminSession);
portalAdminRouter.param("id", (_req, _res, next, value: string) => next(UUID.test(value) ? undefined : notFound("Portal link not found.")));

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Use an ISO 8601 date and time")
  .transform((s) => new Date(s));
const optionalText = (max: number) => z.string().max(max).nullish();

const grantBody = z.object({
  scope: z.enum(PORTAL_SCOPES),
  targetId: z.string().uuid(),
  role: z.enum(PORTAL_ROLES).default("viewer"),
  granteeName: z.string().min(1).max(200),
  granteeEmail: z.string().email().max(320).nullish().or(z.literal("")),
  granteeOrg: optionalText(200),
  expiresAt: isoDate,
  showValues: z.boolean().optional(),
  showDocuments: z.boolean().optional(),
  allowedStages: z.array(z.string().max(40)).max(20).nullish(),
  requireCode: z.boolean().optional(),
  notify: z.boolean().optional(),
  note: optionalText(2000),
  sendEmail: z.boolean().optional(),
  baseUrl: z.string().max(300).nullish(),
});

const grantPatch = grantBody
  .omit({ scope: true, targetId: true, sendEmail: true, baseUrl: true })
  .partial();

const listQuery = z.object({
  state: z.preprocess(blank, z.enum(["active", "inactive"]).optional()),
  scope: z.preprocess(blank, z.enum(PORTAL_SCOPES).optional()),
  targetId: z.preprocess(blank, z.string().uuid().optional()),
  q: text(200),
});

portalAdminRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listGrants(parseOut(listQuery, req.query)));
  }),
);

portalAdminRouter.get("/status", (_req, res) => {
  res.json({
    mailAvailable: mailAvailable(),
    // In trusted mode anyone who can reach the server is its owner, so a
    // portal link adds nothing an outsider could not already do.
    trustedMode: env.trustedAuth,
    baseUrl: env.APP_BASE_URL,
    highValue: env.PORTAL_HIGH_VALUE,
    notifyIntervalMinutes: env.PORTAL_NOTIFY_INTERVAL_MIN,
    defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
    maxExpiryDays: MAX_EXPIRY_DAYS,
    defaultStages: DEFAULT_CONTRIBUTOR_STAGES,
    stages: stageList()
      .filter((s) => s.name !== "pending")
      .map((s) => ({ name: s.name, label: s.label, kind: s.kind })),
  });
});

portalAdminRouter.get(
  "/targets",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
    res.json(await searchTargets(q));
  }),
);

portalAdminRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { sendEmail, baseUrl, granteeEmail, ...input } = parseOut(grantBody, req.body);
    const issued = await createGrant({ ...input, granteeEmail: granteeEmail || null }, currentUser(req).oid, {
      baseUrl,
      sendEmail,
    });
    res.status(201).json(issued);
  }),
);

portalAdminRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await getGrant(param(req, "id")));
  }),
);

portalAdminRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { granteeEmail, ...patch } = parseOut(grantPatch, req.body);
    res.json(
      await updateGrant(
        param(req, "id"),
        { ...patch, ...(granteeEmail !== undefined ? { granteeEmail: granteeEmail || null } : {}) },
        currentUser(req).oid,
      ),
    );
  }),
);

portalAdminRouter.post(
  "/:id/revoke",
  asyncHandler(async (req, res) => {
    res.json(await revokeGrant(param(req, "id"), currentUser(req).oid));
  }),
);

portalAdminRouter.post(
  "/:id/reissue",
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ sendEmail: z.boolean().optional(), baseUrl: z.string().max(300).nullish() }), req.body ?? {});
    res.json(await reissueGrant(param(req, "id"), currentUser(req).oid, body));
  }),
);

portalAdminRouter.get(
  "/:id/activity",
  asyncHandler(async (req, res) => {
    const before = Number(req.query.before);
    res.json(await grantActivity(param(req, "id"), Number.isInteger(before) && before > 0 ? before : undefined));
  }),
);

portalAdminRouter.get(
  "/:id/notes",
  asyncHandler(async (req, res) => {
    res.json(await grantNotes(param(req, "id")));
  }),
);
