import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { PoolClient } from "pg";
import { db, pool } from "../../db/client";
import {
  attachments,
  signatures,
  type AttachmentKind,
  type AttachmentRow,
} from "../../db/tables/media-ai-core";
import { HttpError, badRequest, conflict, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { savePhoto } from "../photos";
import { assertOwner } from "./owners";
import { detectMime, imageSize, inferKind, kindAccepts } from "./magic";
import { parseRange, type ByteRange } from "./range";
import { absolutePath, commitTmp, dbMaxBytes, maxBytes, receive, removeFile, tooLarge } from "./storage";
import { renderJpeg } from "./imaging";

/**
 * Photos, video, audio, documents and signature images attached to any record.
 *
 * This is the stable surface other features build on; see
 * docs/media-ai-core.md. Callers never touch the table or the disk directly:
 * they save through saveAttachment, read through getAttachmentStream, and let
 * this module decide where the bytes live.
 */

export const ATTACHMENT_KINDS = ["photo", "video", "audio", "document", "signature"] as const;
export type { AttachmentKind };

/** An attachment as the API returns it: everything except where the bytes are. */
export type Attachment = Omit<AttachmentRow, "bytes" | "path"> & {
  /** Streams the file, with Range support. */
  url: string;
  /** A small JPEG preview, for photos only. */
  thumbUrl: string | null;
};

export type SaveAttachmentInput = {
  ownerType: string;
  ownerId: string;
  /** Inferred from the detected file type when omitted. */
  kind?: AttachmentKind;
  /** Free text such as before, after, pack, delivery, label. Stored lowercase. */
  stage?: string | null;
  caption?: string | null;
  /** The type the client declared. Checked against the bytes, which win. */
  mime?: string | null;
  /** Exactly one of bytes or stream. A stream is never held in memory whole. */
  bytes?: Buffer;
  stream?: Readable;
  /** Content-Length when known, so an oversized upload is refused before it is read. */
  expectedSize?: number | null;
  /** Hints for video and audio, which the server does not decode. Image sizes are read from the file. */
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  meta?: Record<string, unknown>;
  createdBy: string | null;
};

export type ListAttachmentsOptions = {
  kind?: AttachmentKind | AttachmentKind[];
  stage?: string | null;
};

const MAX_META_BYTES = 16 * 1024;

const cleanStage = (stage: string | null | undefined): string | null => {
  const s = stage?.trim().toLowerCase();
  if (!s) return null;
  if (s.length > 40) throw badRequest("Keep the stage under 40 characters, such as before, after or delivery.");
  return s;
};

const cleanCaption = (caption: string | null | undefined): string | null => {
  const c = caption?.trim();
  if (!c) return null;
  if (c.length > 500) throw badRequest("Keep the caption under 500 characters.");
  return c;
};

function cleanMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (meta === undefined) return {};
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw badRequest("Attachment meta must be a JSON object.");
  }
  if (Buffer.byteLength(JSON.stringify(meta)) > MAX_META_BYTES) {
    throw badRequest("Attachment meta is limited to 16 KB. Store large results in your own table.");
  }
  return meta;
}

const positiveInt = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) && n > 0 && n < 2 ** 31 ? Math.round(n) : null;

// Columns safe to return; the bytes and the disk path never leave this module.
const PUBLIC_COLUMNS = {
  id: attachments.id,
  ownerType: attachments.ownerType,
  ownerId: attachments.ownerId,
  kind: attachments.kind,
  stage: attachments.stage,
  caption: attachments.caption,
  mime: attachments.mime,
  sizeBytes: attachments.sizeBytes,
  sha256: attachments.sha256,
  storage: attachments.storage,
  width: attachments.width,
  height: attachments.height,
  durationMs: attachments.durationMs,
  meta: attachments.meta,
  createdBy: attachments.createdBy,
  createdAt: attachments.createdAt,
};

type PublicRow = Omit<AttachmentRow, "bytes" | "path">;

function present(row: PublicRow): Attachment {
  return {
    ...row,
    url: `/api/attachments/${row.id}`,
    thumbUrl: row.mime.startsWith("image/") ? `/api/attachments/${row.id}/thumb` : null,
  };
}

/**
 * Store a file against a record. Validates the owner, detects the real type
 * from the bytes, and puts small files in Postgres and large ones on disk.
 *
 * Pass `client` to insert inside a transaction you already hold. Files saved
 * that way are limited to ATTACHMENT_DB_MAX_MB, since a file on disk cannot be
 * rolled back.
 */
export async function saveAttachment(input: SaveAttachmentInput, client?: PoolClient): Promise<Attachment> {
  if (!input.bytes === !input.stream) throw new Error("saveAttachment needs exactly one of bytes or stream");
  const stage = cleanStage(input.stage);
  const caption = cleanCaption(input.caption);
  const meta = cleanMeta(input.meta);
  if (input.kind && !ATTACHMENT_KINDS.includes(input.kind)) {
    throw badRequest(`kind must be one of ${ATTACHMENT_KINDS.join(", ")}.`);
  }

  // Inside a caller's transaction the file has to go to the database: a file
  // on disk could not be rolled back with it.
  const limit = client ? dbMaxBytes() : maxBytes();
  if (input.expectedSize && input.expectedSize > limit) throw tooLarge(limit);

  try {
    await assertOwner(input.ownerType, input.ownerId);
  } catch (err) {
    // Read and discard the body so the error reaches the client.
    input.stream?.resume();
    throw err;
  }

  const got = await receive((input.bytes ?? input.stream)!, { spillOver: dbMaxBytes(), max: limit });

  try {
    if (got.size === 0) throw badRequest("The upload was empty. Choose the file again.");
    const mime = detectMime(got.head, input.mime);
    if (!mime) {
      throw new HttpError(
        415,
        "unsupported_type",
        "That file type is not supported. Upload a photo (JPEG, PNG, HEIC, WebP), a video (MP4, MOV, WebM), audio, or a PDF.",
      );
    }
    const kind = input.kind ?? inferKind(mime);
    if (!kindAccepts(kind, mime)) {
      throw badRequest(`A ${kind} cannot be a ${mime} file. Pick a different file or change the kind.`);
    }

    let width = positiveInt(input.width);
    let height = positiveInt(input.height);
    if (mime.startsWith("image/")) {
      // JPEG headers can run past the sniffed bytes when a phone embeds a
      // large preview, so read further when we have to.
      const header = got.bytes ?? (got.tmpPath ? await readHeadAbs(got.tmpPath, 256 * 1024) : got.head);
      const info = imageSize(header);
      if (info) {
        const swap = info.orientation >= 5;
        width = swap ? info.height : info.width;
        height = swap ? info.width : info.height;
      }
    }

    const id = randomUUID();
    const path = got.tmpPath ? await commitTmp(got.tmpPath, id) : null;
    got.tmpPath = null;

    const values = [
      id,
      input.ownerType,
      input.ownerId,
      kind,
      stage,
      caption,
      mime,
      got.size,
      got.sha256,
      path ? "disk" : "db",
      path ? null : got.bytes,
      path,
      width,
      height,
      positiveInt(input.durationMs),
      JSON.stringify(meta),
      input.createdBy,
    ];
    try {
      await (client ?? pool).query(
        `INSERT INTO attachments
           (id, owner_type, owner_id, kind, stage, caption, mime, size_bytes, sha256, storage,
            bytes, path, width, height, duration_ms, meta, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        values,
      );
    } catch (err) {
      await removeFile(path);
      throw err;
    }

    logger.info("attachments.saved", {
      id,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      kind,
      mime,
      bytes: got.size,
      storage: path ? "disk" : "db",
    });
    const saved = await getAttachment(id, client);
    return saved!;
  } finally {
    if (got.tmpPath) await fsp.rm(got.tmpPath, { force: true });
  }
}

async function readHeadAbs(abs: string, n: number): Promise<Buffer> {
  const handle = await fsp.open(abs, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Attachments of one record, oldest first, so before/after photos read in order. */
export async function listAttachments(
  ownerType: string,
  ownerId: string,
  opts: ListAttachmentsOptions = {},
): Promise<Attachment[]> {
  const conds: SQL[] = [eq(attachments.ownerType, ownerType), eq(attachments.ownerId, ownerId)];
  const kinds = opts.kind === undefined ? [] : Array.isArray(opts.kind) ? opts.kind : [opts.kind];
  if (kinds.length) conds.push(inArray(attachments.kind, kinds));
  const stage = cleanStage(opts.stage);
  if (stage) conds.push(eq(attachments.stage, stage));
  const rows = await db
    .select(PUBLIC_COLUMNS)
    .from(attachments)
    .where(and(...conds))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  return rows.map(present);
}

export async function getAttachment(id: string, client?: PoolClient): Promise<Attachment | null> {
  if (!isUuid(id)) return null;
  if (client) {
    const { rows } = await client.query(
      `SELECT id, owner_type AS "ownerType", owner_id AS "ownerId", kind, stage, caption, mime,
              size_bytes::float8 AS "sizeBytes", sha256, storage, width, height,
              duration_ms AS "durationMs", meta, created_by AS "createdBy", created_at AS "createdAt"
         FROM attachments WHERE id = $1`,
      [id],
    );
    return rows[0] ? present(rows[0] as PublicRow) : null;
  }
  const [row] = await db.select(PUBLIC_COLUMNS).from(attachments).where(eq(attachments.id, id)).limit(1);
  return row ? present(row) : null;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export type AttachmentStream =
  | {
      status: 200 | 206;
      attachment: Attachment;
      stream: Readable;
      /** The bytes being sent, inclusive; the whole file for a 200. */
      range: ByteRange;
      size: number;
    }
  | { status: 416; attachment: Attachment; size: number };

/**
 * Open an attachment for reading, honouring an HTTP Range header. Database
 * files are sliced in SQL and disk files are read from an offset, so a seek
 * into a long video reads only what it asks for.
 */
export async function getAttachmentStream(id: string, rangeHeader?: string | null): Promise<AttachmentStream> {
  const [row] = isUuid(id)
    ? await db
        .select({ ...PUBLIC_COLUMNS, path: attachments.path })
        .from(attachments)
        .where(eq(attachments.id, id))
        .limit(1)
    : [];
  if (!row) throw notFound("Attachment not found. It may have been deleted.");
  const { path, ...pub } = row;
  const attachment = present(pub);
  const size = row.sizeBytes;

  const parsed = parseRange(rangeHeader, size);
  if (parsed === "unsatisfiable") return { status: 416, attachment, size };
  const range = parsed ?? { start: 0, end: size - 1 };
  const status = parsed ? 206 : 200;

  if (row.storage === "disk") {
    const abs = absolutePath(path!);
    try {
      await fsp.access(abs, fs.constants.R_OK);
    } catch {
      logger.error("attachments.file.missing", { id, path });
      throw notFound("The file for this attachment is missing from storage. Restore DATA_DIR from a backup.");
    }
    const stream = size === 0 ? Readable.from([]) : fs.createReadStream(abs, { start: range.start, end: range.end });
    return { status, attachment, stream, range, size };
  }

  // substring() is 1-based.
  const { rows } = await pool.query<{ chunk: Buffer }>(
    `SELECT substring(bytes FROM $2::int FOR $3::int) AS chunk FROM attachments WHERE id = $1`,
    [id, range.start + 1, range.end - range.start + 1],
  );
  const chunk = rows[0]?.chunk;
  if (!chunk) throw notFound("Attachment not found. It may have been deleted.");
  return { status, attachment, stream: Readable.from([chunk]), range, size };
}

/**
 * The whole file in memory. For callers that need to process an attachment
 * (thumbnails, a vision model, a PDF): refuses files over `limit` bytes.
 */
export async function readAttachmentBytes(id: string, limit = 64 * 1024 * 1024): Promise<{ attachment: Attachment; bytes: Buffer }> {
  const opened = await getAttachmentStream(id);
  if (opened.status === 416) throw notFound("Attachment is empty.");
  if (opened.size > limit) {
    opened.stream.destroy();
    throw badRequest(`That file is too large to process here (over ${Math.round(limit / 1024 / 1024)} MB).`);
  }
  const parts: Buffer[] = [];
  for await (const part of opened.stream) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array));
  return { attachment: opened.attachment, bytes: Buffer.concat(parts) };
}

/** Change what an attachment is labelled as; the file itself never changes. */
export async function updateAttachment(
  id: string,
  patch: { caption?: string | null; stage?: string | null; meta?: Record<string, unknown> },
): Promise<Attachment> {
  const set: Partial<AttachmentRow> = {};
  if (patch.caption !== undefined) set.caption = cleanCaption(patch.caption);
  if (patch.stage !== undefined) set.stage = cleanStage(patch.stage);
  if (patch.meta !== undefined) set.meta = cleanMeta(patch.meta);
  if (Object.keys(set).length && isUuid(id)) {
    await db.update(attachments).set(set).where(eq(attachments.id, id));
  }
  const updated = await getAttachment(id);
  if (!updated) throw notFound("Attachment not found. It may have been deleted.");
  return updated;
}

/**
 * Remove an attachment and its file. A signature image is part of a signed
 * record and is refused; it goes when its owner does.
 */
export async function deleteAttachment(id: string): Promise<void> {
  if (!isUuid(id)) throw notFound("Attachment not found. It may have been deleted.");
  const [signed] = await db
    .select({ id: signatures.id })
    .from(signatures)
    .where(eq(signatures.attachmentId, id))
    .limit(1);
  if (signed) throw conflict("This image belongs to a signature and cannot be deleted on its own.");
  const [gone] = await db
    .delete(attachments)
    .where(eq(attachments.id, id))
    .returning({ path: attachments.path });
  if (!gone) throw notFound("Attachment not found. It may have been deleted.");
  await removeFile(gone.path);
  logger.info("attachments.deleted", { id });
}

/**
 * Remove every attachment and signature of one record. For features that
 * delete their own records and want the files gone at once rather than at the
 * next sweep.
 */
export async function deleteAttachmentsForOwner(ownerType: string, ownerId: string): Promise<number> {
  if (!isUuid(ownerId)) return 0;
  await db
    .delete(signatures)
    .where(and(eq(signatures.ownerType, ownerType), eq(signatures.ownerId, ownerId)));
  const gone = await db
    .delete(attachments)
    .where(and(eq(attachments.ownerType, ownerType), eq(attachments.ownerId, ownerId)))
    .returning({ path: attachments.path });
  for (const g of gone) await removeFile(g.path);
  return gone.length;
}

/**
 * Make an item's photo attachment its main photo. Copies the bytes through the
 * existing photo path, so everything that shows an item's picture keeps
 * working unchanged.
 */
export async function setAsPrimaryPhoto(id: string) {
  const meta = await getAttachment(id);
  if (!meta) throw notFound("Attachment not found. It may have been deleted.");
  if (meta.ownerType !== "item") throw badRequest("Only a photo attached to the item itself can be its main photo.");
  if (!meta.mime.startsWith("image/")) throw badRequest("Only a photo can be the main photo.");
  const { bytes } = await readAttachmentBytes(id, 32 * 1024 * 1024);
  return savePhoto(meta.ownerId, meta.mime, bytes);
}

/** A small JPEG preview of a photo attachment, or null when it cannot be drawn. */
export async function thumbnail(id: string, width: number): Promise<{ attachment: Attachment; bytes: Buffer } | null> {
  const meta = await getAttachment(id);
  if (!meta) throw notFound("Attachment not found. It may have been deleted.");
  if (!meta.mime.startsWith("image/")) return null;
  const { bytes } = await readAttachmentBytes(id, 64 * 1024 * 1024);
  const jpeg = await renderJpeg(bytes, { maxEdge: width, quality: 78 });
  return jpeg ? { attachment: meta, bytes: jpeg } : null;
}
