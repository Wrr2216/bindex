import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { HttpError, badRequest, describeError, notFound } from "../lib/errors";
import { logger } from "../lib/logger";
import { currentUser } from "../auth/middleware";
import { getConfig } from "../services/config";
import {
  MUTATING_METHODS,
  claimIdempotencyKey,
  answerToKeep,
  parseIdempotencyKey,
  releaseIdempotencyKey,
  requestFingerprint,
  storeIdempotentAnswer,
} from "../services/offline-field/idempotency";
import { buildSnapshot } from "../services/offline-field/snapshot";
import { planQueue } from "../services/offline-field/world";
import { addFieldNote, listFieldNotes } from "../services/offline-field/notes";
import { loadServiceWorker } from "../services/offline-field/serviceWorker";

// ---- Idempotency-Key -------------------------------------------------------

const toBuffer = (body: unknown): Buffer | null => {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  // res.send(object) passes the object on to res.json, which calls send again
  // with the serialized string; that second call is the one kept.
  return null;
};

/**
 * Record a response's outcome at the moment the route produces it, not when it
 * is delivered. In a dead zone the connection often drops mid-request while
 * the route carries on and commits the change; the device's retry must then
 * find the stored answer, not a released key. Routes answer with res.json or
 * res.send, which end in res.end; a route that streams with res.write is
 * remembered without its body.
 */
function watchResponse(
  res: Response,
  onAnswer: (status: number, body: Buffer | null, streamed: boolean) => void,
): void {
  let body: Buffer | null = null;
  let streamed = false;
  let settled = false;

  const send = res.send.bind(res);
  res.send = (chunk?: unknown) => {
    const buf = toBuffer(chunk);
    if (buf) body = buf;
    return send(chunk);
  };
  const mutable = res as unknown as {
    write: (...args: unknown[]) => boolean;
    end: (...args: unknown[]) => Response;
  };
  const write = mutable.write.bind(res);
  mutable.write = (...args) => {
    streamed = true;
    return write(...args);
  };
  const end = mutable.end.bind(res);
  mutable.end = (...args) => {
    if (!settled) {
      settled = true;
      onAnswer(res.statusCode, body, streamed);
    }
    return end(...args);
  };
}

/**
 * Honour an Idempotency-Key on any state-changing /api request. Mounted once,
 * after authentication, so every route is covered without opting in; requests
 * without the header pass straight through. See services/offline-field/idempotency.ts.
 */
export const idempotency: RequestHandler = (req: Request, res: Response, next) => {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const parsed = parseIdempotencyKey(req.get("idempotency-key"));
  if (parsed === null) return next();
  if (parsed === "invalid") {
    return next(badRequest("Idempotency-Key must be 1 to 255 visible characters, such as a UUID."));
  }
  const key = parsed;
  const principal = currentUser(req).oid;
  const path = req.originalUrl;
  const fingerprint = requestFingerprint({
    method: req.method,
    path,
    body: req.body,
    contentType: req.get("content-type"),
    contentLength: req.get("content-length"),
  });

  claimIdempotencyKey(principal, key, req.method, path, fingerprint)
    .then((outcome) => {
      if (outcome.kind === "replay") {
        logger.info("idempotency.replayed", { method: req.method, path, status: outcome.status });
        res.status(outcome.status).set("Idempotent-Replayed", "true");
        if (outcome.contentType) res.set("Content-Type", outcome.contentType);
        if (outcome.body.length) res.end(outcome.body);
        else res.end();
        return;
      }
      if (outcome.kind === "mismatch") {
        throw new HttpError(
          422,
          "idempotency_key_reused",
          "That Idempotency-Key was already used for a different request. Send a new key with each new change.",
        );
      }
      if (outcome.kind === "in_progress") {
        throw new HttpError(
          409,
          "idempotency_in_progress",
          "The first request with this Idempotency-Key is still running. Try again in a moment.",
        );
      }
      // A route that never answers (a crash, a hang) leaves the key pending;
      // it is taken over once stale, see claimIdempotencyKey.
      watchResponse(res, (status, body, streamed) => {
        const keep = answerToKeep(status, streamed, body?.length ?? 0);
        const contentType = String(res.getHeader("content-type") ?? "") || null;
        const done =
          keep === "release"
            ? releaseIdempotencyKey(principal, key)
            : storeIdempotentAnswer(
                principal,
                key,
                status,
                keep === "body" ? contentType : null,
                keep === "body" && body ? body : Buffer.alloc(0),
              );
        done.catch((err) =>
          logger.warn("idempotency.finish_failed", { path, err: describeError(err) }),
        );
      });
      next();
    })
    .catch(next);
};

// ---- Session routes: /api/offline ------------------------------------------

export const offlineFieldRouter = Router();

/**
 * Taking data offline follows the feature switch. Planning and notes do not:
 * a device may still hold changes queued before the switch went off, and those
 * are never thrown away.
 */
const requireOfflineFeature: RequestHandler = (_req, _res, next) => {
  getConfig()
    .then((config) => {
      if (!config.features.offline) {
        next(notFound("Offline field mode is switched off. An administrator can turn it on in Settings."));
        return;
      }
      next();
    })
    .catch(next);
};

const snapshotQuery = z.object({ locationId: z.string().uuid().optional() });

// The copy a device takes offline: a location and everything below it, or,
// without a location, the whole instance when it is small enough.
offlineFieldRouter.get(
  "/snapshot",
  requireOfflineFeature,
  asyncHandler(async (req, res) => {
    const { locationId } = parse(snapshotQuery, req.query);
    const snapshot = await buildSnapshot({ locationId: locationId ?? null });
    logger.info("offline.snapshot", {
      locationId: locationId ?? "all",
      items: snapshot.items.length,
      user: currentUser(req).oid,
    });
    res.set("Cache-Control", "no-store");
    res.json(snapshot);
  }),
);

const uuid = z.string().uuid();
const nullableUuid = uuid.nullable();
const planActionSchema = z.object({
  id: z.string().min(1).max(100),
  seq: z.number().int().nonnegative(),
  type: z.enum([
    "move",
    "checkout",
    "checkin",
    "spot_check",
    "verify_apply",
    "audit_apply",
    "note",
    "photo",
  ]),
  itemId: nullableUuid.optional(),
  unitId: nullableUuid.optional(),
  locationId: nullableUuid.optional(),
  entityId: nullableUuid.optional(),
  to: z
    .object({ locationId: nullableUuid.optional(), parentItemId: nullableUuid.optional() })
    .optional(),
  base: z
    .object({
      locationId: nullableUuid.optional(),
      parentItemId: nullableUuid.optional(),
      // An entity id, or "unknown" for a check-out whose holder was deleted.
      holderId: z.string().max(64).nullable().optional(),
    })
    .nullable()
    .optional(),
  itemIds: z.array(uuid).max(20000).optional(),
  force: z.boolean().optional(),
  held: z.boolean().optional(),
});
const planSchema = z.object({ actions: z.array(planActionSchema).max(2000) });

// Which queued changes can be sent now, in what order, and which need a
// person. Read-only: the device replays the changes itself, each with its
// Idempotency-Key, through the ordinary routes.
offlineFieldRouter.post(
  "/plan",
  asyncHandler(async (req, res) => {
    const { actions } = parse(planSchema, req.body);
    const ids = new Set(actions.map((a) => a.id));
    if (ids.size !== actions.length) throw badRequest("Each queued change needs its own id.");
    const results = await planQueue(actions);
    const count = (v: string) => results.filter((r) => r.verdict === v).length;
    logger.info("offline.plan", {
      actions: actions.length,
      send: count("send"),
      conflict: count("conflict"),
      skip: count("skip"),
      user: currentUser(req).oid,
    });
    res.json({ results });
  }),
);

const noteSchema = z.object({
  text: z.string().trim().min(1, "Write something first.").max(2000),
  unitId: uuid.nullish(),
  writtenAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date")
    .nullish(),
});

offlineFieldRouter.get(
  "/items/:id/notes",
  asyncHandler(async (req, res) => {
    res.json({ notes: await listFieldNotes(parse(uuid, param(req, "id"))) });
  }),
);

offlineFieldRouter.post(
  "/items/:id/notes",
  asyncHandler(async (req, res) => {
    const input = parse(noteSchema, req.body);
    const note = await addFieldNote({
      itemId: parse(uuid, param(req, "id")),
      unitId: input.unitId ?? null,
      text: input.text,
      writtenAt: input.writtenAt ?? null,
      userOid: currentUser(req).oid,
    });
    res.status(201).json(note);
  }),
);

// ---- Before authentication -------------------------------------------------

export const offlineFieldPublicRouter = Router();

// The service worker, stamped with this build. Served before the static files,
// which would otherwise hand out the unstamped copy.
offlineFieldPublicRouter.get("/sw.js", (_req, res, next) => {
  const sw = loadServiceWorker();
  if (!sw) return next();
  res.type("application/javascript");
  // Browsers already revalidate workers daily; no-cache makes every update
  // check see a new deploy straight away.
  res.set("Cache-Control", "no-cache");
  res.set("Service-Worker-Allowed", "/");
  res.send(sw.body);
});
