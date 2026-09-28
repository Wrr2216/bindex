import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { badRequest, describeError, notFound } from "../lib/errors";
import { logger } from "../lib/logger";
import { currentUser, requireAdmin } from "../auth/middleware";
import { actorFromUser, publish } from "../services/event-backbone/bus";
import { eventCatalog } from "../services/event-backbone/catalog";
import { isValidPattern, parsePatternList, prefixToPattern } from "../services/event-backbone/patterns";
import {
  auditStatus,
  createCheckpoint,
  exportAuditLog,
  getAuditEntry,
  listAuditLog,
  listEventsAfter,
  verifyChain,
  type AuditFilter,
} from "../services/event-backbone/auditLog";
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listEndpoints,
  rotateSecret,
  updateEndpoint,
} from "../services/event-backbone/webhooks";
import { listDeliveries, pingEndpoint, redeliver } from "../services/event-backbone/delivery";
import { toEnvelope, type AuditEntry } from "../services/event-backbone/types";

/**
 * /api/audit-log and /api/webhooks are for administrators in a browser;
 * /api/events is the polling feed and works with a read-only API key.
 */
export const eventBackboneRouter = Router();

/**
 * requireAdmin looks at the session only, so a request carrying both an admin
 * cookie and an API key would pass it. The key is authoritative everywhere
 * else in the API, and keys are never administrators.
 */
const requireAdminSession: RequestHandler = (req, res, next) => {
  if (req.apiKeyUser) {
    res.status(403).json({ error: "This endpoint requires a browser session", code: "session_required" });
    return;
  }
  requireAdmin(req, res, next);
};

// ---- Query parsing -------------------------------------------------------------

/**
 * parse() infers its result from the schema's input type, which preprocess
 * widens to unknown; this keeps the validated output type.
 */
function parseQuery<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  return parse(schema as unknown as z.ZodType<z.output<S>>, value);
}

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalDate = z.preprocess(
  blankToUndefined,
  z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Use a date such as 2026-09-26 or a full ISO timestamp.")
    .optional(),
);
const optionalInt = (min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).optional());

const filterQuery = z.object({
  type: optionalText(500),
  subjectType: optionalText(100),
  subjectId: optionalText(200),
  actor: optionalText(200),
  from: optionalDate,
  to: optionalDate,
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toFilter(q: z.infer<typeof filterQuery>): AuditFilter {
  let types: string[] | undefined;
  if (q.type) {
    types = q.type
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map(prefixToPattern);
    const bad = types.filter((t) => !isValidPattern(t));
    if (bad.length) {
      throw badRequest(`Not a valid event type filter: ${bad.join(", ")}. Use a prefix such as item. or item.moved.`);
    }
  }
  let to: Date | undefined;
  if (q.to) {
    to = new Date(q.to);
    // A bare date means "up to the end of that day".
    if (DATE_ONLY.test(q.to)) to = new Date(to.getTime() + 24 * 60 * 60_000);
  }
  return {
    types,
    subjectType: q.subjectType,
    subjectId: q.subjectId,
    actor: q.actor,
    from: q.from ? new Date(q.from) : undefined,
    to,
  };
}

function describeFilter(f: AuditFilter): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      types: f.types,
      subjectType: f.subjectType,
      subjectId: f.subjectId,
      actor: f.actor,
      from: f.from?.toISOString(),
      to: f.to?.toISOString(),
    }).filter(([, v]) => v !== undefined),
  );
}

// ---- Audit log -------------------------------------------------------------------

const auditLog = Router();
auditLog.use(requireAdminSession);

auditLog.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = parseQuery(filterQuery.extend({ before: optionalInt(1, Number.MAX_SAFE_INTEGER), limit: optionalInt(1, 200) }), req.query);
    res.json(await listAuditLog(toFilter(q), { before: q.before, limit: q.limit }));
  }),
);

auditLog.get(
  "/status",
  asyncHandler(async (_req, res) => {
    res.json(await auditStatus());
  }),
);

auditLog.get(
  "/verify",
  asyncHandler(async (req, res) => {
    const started = Date.now();
    const result = await verifyChain();
    logger.info("audit.verify", { ok: result.ok, checked: result.checked, firstBrokenId: result.firstBrokenId, ms: Date.now() - started });
    // Recorded after the walk, so the result does not cover its own entry.
    await publish(
      "audit.verified",
      { ok: result.ok, checked: result.checked, firstBrokenId: result.firstBrokenId, headId: result.head?.id ?? null },
      { actor: actorFromUser(currentUser(req)), subject: { type: "audit_log", id: String(result.head?.id ?? 0) } },
    );
    res.json(result);
  }),
);

auditLog.post(
  "/checkpoint",
  asyncHandler(async (_req, res) => {
    const entry = await createCheckpoint(true);
    res.status(201).json(entry);
  }),
);

const CSV_COLUMNS = [
  "id",
  "occurred_at",
  "actor_kind",
  "actor_id",
  "actor_name",
  "type",
  "subject_type",
  "subject_id",
  "data",
  "prev_hash",
  "hash",
];

/**
 * CSV is for reading in a spreadsheet, so a cell that a spreadsheet would run
 * as a formula is prefixed with an apostrophe. The NDJSON export is the one to
 * verify: it carries every field exactly as hashed.
 */
function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(e: AuditEntry): string {
  return [
    e.id,
    e.occurredAt,
    e.actor.kind,
    e.actor.id,
    e.actor.name,
    e.type,
    e.subject?.type,
    e.subject?.id,
    JSON.stringify(e.data),
    e.prevHash,
    e.hash,
  ]
    .map(csvCell)
    .join(",");
}

/** Resolves once the buffer has room again, so a slow download is not buffered whole. */
function write(res: Response, chunk: string): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    // A client that goes away never drains; the loop sees res.destroyed next.
    res.once("drain", done);
    res.once("close", done);
  });
}

auditLog.get(
  "/export",
  asyncHandler(async (req, res) => {
    const q = parseQuery(filterQuery.extend({ format: z.enum(["ndjson", "csv"]).default("ndjson") }), req.query);
    const filter = toFilter(q);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
    res.setHeader(
      "Content-Type",
      q.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
    );
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${stamp}.${q.format}"`);

    let rows = 0;
    let complete = false;
    try {
      if (q.format === "csv") await write(res, `${CSV_COLUMNS.join(",")}\r\n`);
      for await (const batch of exportAuditLog(filter)) {
        if (res.destroyed) break;
        const text =
          q.format === "csv"
            ? batch.map((e) => `${csvLine(e)}\r\n`).join("")
            : batch.map((e) => `${JSON.stringify(e)}\n`).join("");
        rows += batch.length;
        await write(res, text);
      }
      complete = !res.destroyed;
      res.end();
    } catch (err) {
      // Headers are gone, so there is no error response to send: cut the
      // download short, which the client sees as a failed transfer.
      logger.error("audit.export.failed", { rows, err: describeError(err) });
      res.destroy();
    }
    await publish(
      "audit.exported",
      { format: q.format, rows, complete, filter: describeFilter(filter) },
      { actor: actorFromUser(currentUser(req)), subject: { type: "audit_log", id: "export" } },
    );
  }),
);

auditLog.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(param(req, "id"));
    const entry = Number.isSafeInteger(id) && id > 0 ? await getAuditEntry(id) : null;
    if (!entry) throw notFound("Audit log entry not found.");
    res.json(entry);
  }),
);

eventBackboneRouter.use("/audit-log", auditLog);

// ---- Webhooks --------------------------------------------------------------------

const webhooks = Router();
webhooks.use(requireAdminSession);

const endpointBody = z.object({
  url: z.string().trim().min(1, "Enter the URL to deliver to.").max(2000),
  description: z.string().max(200).optional(),
  eventPatterns: z.array(z.string().max(100)).min(1, "Choose at least one event.").max(50),
  active: z.boolean().optional(),
});

webhooks.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ endpoints: await listEndpoints() });
  }),
);

webhooks.get("/catalog", (_req, res) => {
  res.json({ types: eventCatalog() });
});

webhooks.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = parse(endpointBody, req.body);
    // Includes the secret: the only time it is ever returned.
    res.status(201).json(await createEndpoint(body, actorFromUser(currentUser(req))));
  }),
);

webhooks.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await getEndpoint(param(req, "id")));
  }),
);

webhooks.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = parse(endpointBody.partial(), req.body);
    res.json(await updateEndpoint(param(req, "id"), body, actorFromUser(currentUser(req))));
  }),
);

webhooks.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteEndpoint(param(req, "id"), actorFromUser(currentUser(req)));
    res.status(204).end();
  }),
);

webhooks.post(
  "/:id/rotate-secret",
  asyncHandler(async (req, res) => {
    res.json(await rotateSecret(param(req, "id"), actorFromUser(currentUser(req))));
  }),
);

webhooks.post(
  "/:id/ping",
  asyncHandler(async (req, res) => {
    res.json(await pingEndpoint(param(req, "id"), actorFromUser(currentUser(req))));
  }),
);

const deliveriesQuery = z.object({
  status: z.preprocess(blankToUndefined, z.enum(["pending", "succeeded", "failed", "dead"]).optional()),
  before: optionalInt(1, Number.MAX_SAFE_INTEGER),
  limit: optionalInt(1, 200),
});

webhooks.get(
  "/:id/deliveries",
  asyncHandler(async (req, res) => {
    const q = parseQuery(deliveriesQuery, req.query);
    res.json(await listDeliveries(param(req, "id"), q));
  }),
);

webhooks.post(
  "/deliveries/:id/redeliver",
  asyncHandler(async (req, res) => {
    res.json(await redeliver(param(req, "id")));
  }),
);

eventBackboneRouter.use("/webhooks", webhooks);

// ---- Polling feed ------------------------------------------------------------------

const feedQuery = z.object({
  after: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
  types: optionalText(1000),
  limit: optionalInt(1, 500),
});

/**
 * Everything published, oldest first after a cursor. Any signed-in user or
 * API key may read it, like the rest of the inventory API; the audit-log
 * endpoints above add hashes and filters for administrators.
 */
eventBackboneRouter.get(
  "/events",
  asyncHandler(async (req, res) => {
    const q = parseQuery(feedQuery, req.query);
    const { patterns, invalid } = parsePatternList(q.types);
    if (invalid.length) {
      throw badRequest(`Not a valid event pattern: ${invalid.join(", ")}. Use names such as item.created, with * as a wildcard.`);
    }
    const { entries, hasMore } = await listEventsAfter(q.after, patterns, q.limit ?? 100);
    res.json({
      events: entries.map(toEnvelope),
      nextAfter: entries.length ? entries[entries.length - 1]!.id : q.after,
      hasMore,
    });
  }),
);
