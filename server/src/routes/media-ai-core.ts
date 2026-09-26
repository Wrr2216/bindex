import { Router, raw, type Request, type Response } from "express";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { currentUser } from "../auth/middleware";
import { env } from "../env";
import { HttpError, badRequest, describeError } from "../lib/errors";
import { asyncHandler, param, parse } from "../lib/http";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";
import { aiAvailability } from "../services/ai";
import { getConfig } from "../services/config";
import {
  ATTACHMENT_KINDS,
  deleteAttachment,
  getAttachment,
  getAttachmentStream,
  getSignature,
  getSignedContent,
  listAttachments,
  listSignatures,
  saveAttachment,
  setAsPrimaryPhoto,
  sign,
  thumbnail,
  updateAttachment,
  verifySignature,
  type Attachment,
} from "../services/media-ai-core";
import {
  LOW_CONFIDENCE,
  applyDataPlate,
  readDataPlate,
  readingFound,
  takenForOwner,
} from "../services/media-ai-core/dataPlate";
import { detectMime, isInlineMime } from "../services/media-ai-core/magic";
import { contentRange, parseRange } from "../services/media-ai-core/range";
import { maxBytes, tooLarge } from "../services/media-ai-core/storage";

/**
 * T02 routes: /api/attachments, /api/signatures and /api/ai. One router so the
 * shared api.ts gains a single mount line.
 */
export const mediaAiCoreRouter = Router();

const attachmentsRouter = Router();
const signaturesRouter = Router();
const aiRouter = Router();
mediaAiCoreRouter.use("/attachments", attachmentsRouter);
mediaAiCoreRouter.use("/signatures", signaturesRouter);
mediaAiCoreRouter.use("/ai", aiRouter);

// ---- Attachments ----------------------------------------------------------

/** A query parameter, or the matching x-attachment-* header (URI-encoded). */
function field(req: Request, name: string): string | undefined {
  const q = req.query[name];
  if (typeof q === "string") return q;
  const header = req.get(`x-attachment-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  if (header === undefined) return undefined;
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

const optionalInt = z.coerce.number().int().positive().max(2 ** 31 - 1).optional();

const uploadSchema = z.object({
  ownerType: z.string().min(1).max(40),
  ownerId: z.string().uuid("ownerId must be the id (a UUID) of the record the file belongs to"),
  kind: z.enum(ATTACHMENT_KINDS).optional(),
  stage: z.string().max(40).optional(),
  caption: z.string().max(500).optional(),
  type: z.string().max(120).optional(),
  filename: z.string().max(200).optional(),
  width: optionalInt,
  height: optionalInt,
  durationMs: optionalInt,
});

function parseMeta(req: Request): Record<string, unknown> | undefined {
  const rawMeta = field(req, "meta");
  if (!rawMeta) return undefined;
  try {
    const meta = JSON.parse(rawMeta) as unknown;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) return meta as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw badRequest("x-attachment-meta must be a JSON object.");
}

// Upload: the file is the raw request body and is streamed straight through,
// never parsed into memory. Describe it with query parameters or
// x-attachment-* headers. Send Content-Type application/octet-stream with the
// real type in `type` if anything between you and us might parse the body.
attachmentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parse(uploadSchema, {
      ownerType: field(req, "ownerType"),
      ownerId: field(req, "ownerId"),
      kind: field(req, "kind") || undefined,
      stage: field(req, "stage"),
      caption: field(req, "caption"),
      type: field(req, "type"),
      filename: field(req, "filename"),
      width: field(req, "width"),
      height: field(req, "height"),
      durationMs: field(req, "durationMs"),
    });
    if ((req as { _body?: boolean })._body) {
      throw badRequest("Send the file itself as the request body, with Content-Type application/octet-stream.");
    }
    const length = Number(req.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes()) {
      // Refuse without reading hundreds of megabytes first.
      res.setHeader("Connection", "close");
      throw tooLarge(maxBytes());
    }
    const meta = parseMeta(req);
    const saved = await saveAttachment({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      kind: input.kind,
      stage: input.stage,
      caption: input.caption,
      mime: input.type || req.get("content-type"),
      stream: req,
      expectedSize: Number.isFinite(length) ? length : null,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
      meta: input.filename ? { ...meta, filename: input.filename } : meta,
      createdBy: currentUser(req).oid,
    });
    res.status(201).json(saved);
  }),
);

const listSchema = z.object({
  ownerType: z.string().min(1).max(40),
  ownerId: z.string().uuid(),
  kind: z.string().optional(),
  stage: z.string().max(40).optional(),
});

attachmentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = parse(listSchema, req.query);
    const kinds = q.kind
      ?.split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const bad = kinds?.find((k) => !(ATTACHMENT_KINDS as readonly string[]).includes(k));
    if (bad) throw badRequest(`Unknown kind "${bad}". Use ${ATTACHMENT_KINDS.join(", ")}.`);
    res.json(
      await listAttachments(q.ownerType, q.ownerId, {
        kind: kinds as (typeof ATTACHMENT_KINDS)[number][] | undefined,
        stage: q.stage,
      }),
    );
  }),
);

function downloadName(a: Attachment): string {
  const given = typeof a.meta.filename === "string" ? a.meta.filename : "";
  const ext = a.mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
  const safe = given.replace(/[^\w.\- ]+/g, "_").trim().slice(0, 120);
  return safe || `${a.kind}-${a.id.slice(0, 8)}.${ext}`;
}

function describeFile(res: Response, a: Attachment): void {
  res.setHeader("Content-Type", a.mime);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", `"${a.sha256}"`);
  // An attachment's bytes never change. no-transform keeps the compression
  // middleware away from ranged responses.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable, no-transform");
  res.setHeader(
    "Content-Disposition",
    `${isInlineMime(a.mime) ? "inline" : "attachment"}; filename="${downloadName(a)}"`,
  );
}

// Stream a file, honouring Range so a phone can seek in a video.
attachmentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    if (req.method === "HEAD") {
      const a = await getAttachment(id);
      if (!a) throw new HttpError(404, "not_found", "Attachment not found. It may have been deleted.");
      describeFile(res, a);
      const range = parseRange(req.get("range"), a.sizeBytes);
      if (range === "unsatisfiable") {
        res.status(416).setHeader("Content-Range", `bytes */${a.sizeBytes}`);
      } else if (range) {
        res.status(206).setHeader("Content-Range", contentRange(range, a.sizeBytes));
        res.setHeader("Content-Length", String(range.end - range.start + 1));
      } else {
        res.setHeader("Content-Length", String(a.sizeBytes));
      }
      res.end();
      return;
    }

    const etag = req.get("if-none-match");
    if (etag && !req.get("range")) {
      const cached = await getAttachment(id);
      if (cached && etag === `"${cached.sha256}"`) {
        describeFile(res, cached);
        res.status(304).end();
        return;
      }
    }

    const opened = await getAttachmentStream(id, req.get("range"));
    describeFile(res, opened.attachment);
    if (opened.status === 416) {
      res.status(416).setHeader("Content-Range", `bytes */${opened.size}`);
      res.end();
      return;
    }
    res.status(opened.status);
    res.setHeader("Content-Length", String(opened.range.end - opened.range.start + 1));
    if (opened.status === 206) res.setHeader("Content-Range", contentRange(opened.range, opened.size));
    try {
      await pipeline(opened.stream, res);
    } catch (err) {
      // A player that seeks abandons the request it was reading; that is normal.
      logger.debug("attachments.stream.aborted", { id, err: describeError(err) });
    }
  }),
);

attachmentsRouter.get(
  "/:id/thumb",
  asyncHandler(async (req, res) => {
    const w = Math.min(1024, Math.max(64, Number(req.query.w) || 320));
    const thumb = await thumbnail(param(req, "id"), w);
    if (!thumb) throw new HttpError(404, "no_preview", "There is no preview for this file.");
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("ETag", `"${thumb.attachment.sha256}-${w}"`);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(thumb.bytes);
  }),
);

const patchSchema = z.object({
  caption: z.string().max(500).nullish(),
  stage: z.string().max(40).nullish(),
  meta: z.record(z.unknown()).optional(),
});

attachmentsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const p = parse(patchSchema, req.body);
    res.json(await updateAttachment(param(req, "id"), p));
  }),
);

// Make an item's photo attachment its main photo.
attachmentsRouter.post(
  "/:id/primary",
  asyncHandler(async (req, res) => {
    res.json(await setAsPrimaryPhoto(param(req, "id")));
  }),
);

attachmentsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteAttachment(param(req, "id"));
    res.status(204).end();
  }),
);

// ---- Signatures -----------------------------------------------------------

const signSchema = z.object({
  ownerType: z.string().min(1).max(40),
  ownerId: z.string().uuid(),
  signerName: z.string().min(1, "Enter the signer's name").max(200),
  signerEmail: z.string().max(320).nullish(),
  signerRole: z.string().max(120).nullish(),
  statement: z.string().min(1).max(4000),
  content: z.unknown().refine((v) => v !== undefined, "content is required: the JSON of what is being signed"),
  // PNG from the signature pad, as a data URL or bare base64.
  image: z.string().max(800_000).nullish(),
});

function decodeImage(value: string | null | undefined): Buffer | null {
  if (!value) return null;
  const b64 = value.replace(/^data:[^;,]+;base64,/, "");
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length) throw badRequest("The signature image could not be read. Sign again.");
  return bytes;
}

signaturesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parse(signSchema, req.body);
    const signature = await sign({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      signerName: input.signerName,
      signerEmail: input.signerEmail,
      signerRole: input.signerRole,
      statement: input.statement,
      content: input.content,
      image: decodeImage(input.image),
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      signedByUser: currentUser(req).oid,
    });
    res.status(201).json(signature);
  }),
);

signaturesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ ownerType: z.string().min(1).max(40), ownerId: z.string().uuid() }), req.query);
    res.json(await listSignatures(q.ownerType, q.ownerId));
  }),
);

signaturesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const signature = await getSignature(param(req, "id"));
    if (!signature) throw new HttpError(404, "not_found", "Signature not found.");
    res.json({ ...signature, content: await getSignedContent(signature.id) });
  }),
);

signaturesRouter.post(
  "/:id/verify",
  asyncHandler(async (req, res) => {
    const { content } = parse(z.object({ content: z.unknown() }), req.body);
    res.json(await verifySignature(param(req, "id"), content));
  }),
);

// ---- AI -------------------------------------------------------------------

aiRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const config = await getConfig();
    res.json({ ...aiAvailability(), aiCapture: config.features.aiCapture });
  }),
);

async function requireAiCapture(): Promise<void> {
  const config = await getConfig();
  if (!config.features.aiCapture) {
    throw new HttpError(403, "feature_disabled", "Reading labels is switched off. An administrator can turn on AI capture in Settings.");
  }
}

// Vision calls cost money; one person tapping repeatedly should not run up a bill.
const dataPlateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  key: (req) => `data-plate:${currentUser(req).oid}`,
});

const ownerQuery = z.object({
  ownerType: z.enum(["item", "unit"]).optional(),
  ownerId: z.string().uuid().optional(),
});

// Read a label photo. Returns the reading for review; saves nothing.
aiRouter.post(
  "/data-plate",
  dataPlateLimit,
  raw({ type: () => true, limit: "25mb" }),
  asyncHandler(async (req, res) => {
    await requireAiCapture();
    const owner = parse(ownerQuery, req.query);
    const bytes = req.body as unknown;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw badRequest("Send the label photo as the request body.");
    const mime = detectMime(bytes.subarray(0, 4100), req.get("content-type"));
    if (!mime?.startsWith("image/")) {
      throw new HttpError(415, "unsupported_type", "That is not a photo. Take a picture of the label and try again.");
    }
    if (!env.llmVisionConfigured) {
      res.json({ available: false, found: false, reading: null, taken: null, lowConfidence: LOW_CONFIDENCE });
      return;
    }

    const reading = await readDataPlate({ mime, bytes }, { user: currentUser(req).oid, ...owner });
    const found = readingFound(reading);
    const taken = reading ? await takenForOwner(reading, owner) : null;
    logger.info("ai.data_plate.read", { found, ownerType: owner.ownerType, ownerId: owner.ownerId });
    res.json({
      available: true,
      found,
      reading,
      taken,
      lowConfidence: LOW_CONFIDENCE,
      ...(found
        ? {}
        : { message: "No label could be read. Try again closer, straight on, and without glare." }),
    });
  }),
);

const applySchema = z.object({
  ownerType: z.enum(["item", "unit"]),
  ownerId: z.string().uuid(),
  brand: z.string().max(200).nullish(),
  model: z.string().max(200).nullish(),
  serial: z.string().max(200).nullish(),
  mac: z.string().max(200).nullish(),
  assetTag: z.string().max(200).nullish(),
  partNumber: z.string().max(200).nullish(),
});

// Save the fields a person accepted from a reading.
aiRouter.post(
  "/data-plate/apply",
  asyncHandler(async (req, res) => {
    await requireAiCapture();
    const input = parse(applySchema, req.body);
    res.json(await applyDataPlate(input, currentUser(req).oid));
  }),
);
