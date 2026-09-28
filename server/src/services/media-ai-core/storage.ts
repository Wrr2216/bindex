import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { Readable } from "node:stream";
import { env } from "../../env";
import { HttpError, describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { SNIFF_BYTES } from "./magic";

/**
 * Where attachment bytes physically go.
 *
 * Small files are kept in memory while they arrive and end up in Postgres.
 * Once an upload passes the database threshold it is spilled to a temporary
 * file under DATA_DIR and continues streaming there, so a 500 MB video costs a
 * few chunks of memory, never its own size. The sha256 and the leading bytes
 * used for type detection are taken on the way through, in the same pass.
 */

export const MB = 1024 * 1024;
export const dbMaxBytes = () => Math.floor(env.ATTACHMENT_DB_MAX_MB * MB);
export const maxBytes = () => Math.floor(env.ATTACHMENT_MAX_MB * MB);

const ROOT = "attachments";
const TMP = path.posix.join(ROOT, "tmp");

/** Resolve a stored relative path, refusing anything that would leave DATA_DIR. */
export function absolutePath(rel: string): string {
  const root = path.resolve(env.dataDir);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error(`Attachment path escapes DATA_DIR: ${rel}`);
  return abs;
}

/** Final resting place of a disk attachment, relative to DATA_DIR. */
export function relativePathFor(id: string): string {
  return path.posix.join(ROOT, id.slice(0, 2), id);
}

export const attachmentsRoot = () => absolutePath(ROOT);
export const tmpRoot = () => absolutePath(TMP);

export function tooLarge(limit: number): HttpError {
  const size = limit >= MB ? `${Math.round(limit / MB)} MB` : `${Math.max(1, Math.round(limit / 1024))} KB`;
  return new HttpError(
    413,
    "too_large",
    `That file is larger than the ${size} this server accepts. Trim it, or ask an administrator to raise ATTACHMENT_MAX_MB.`,
  );
}

function storageUnavailable(err: unknown): HttpError {
  logger.error("attachments.storage.unwritable", { dataDir: env.dataDir, err: describeError(err) });
  return new HttpError(
    507,
    "storage_unavailable",
    `Files over ${env.ATTACHMENT_DB_MAX_MB} MB are stored on disk, and ${env.dataDir} is not writable. ` +
      "Mount a writable volume there or set DATA_DIR.",
  );
}

export type Received = {
  size: number;
  sha256: string;
  /** The first SNIFF_BYTES bytes, for type detection. */
  head: Buffer;
  /** The whole file, when it fits in the database. */
  bytes: Buffer | null;
  /** Otherwise the absolute path of the temporary file holding it. */
  tmpPath: string | null;
};

async function openTmp(): Promise<{ file: string; out: fs.WriteStream }> {
  const file = path.join(tmpRoot(), `${randomUUID()}.part`);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const out = fs.createWriteStream(file, { flags: "wx" });
    // Errors reach the caller through the drain and finish waits below. Without
    // a listener, a write that completes after an aborted upload destroyed the
    // stream would raise an unhandled 'error' and take the process down.
    out.on("error", () => undefined);
    await once(out, "open");
    return { file, out };
  } catch (err) {
    throw storageUnavailable(err);
  }
}

async function discard(spill: { file: string; out: fs.WriteStream }): Promise<void> {
  spill.out.destroy();
  if (!spill.out.closed) await once(spill.out, "close").catch(() => undefined);
  await fsp.rm(spill.file, { force: true });
}

/**
 * Take in a whole upload, from a buffer or a stream. Throws 413 as soon as the
 * running total passes `max`, and removes any partial file on every failure,
 * including the client hanging up half way.
 */
export async function receive(
  source: Buffer | Readable,
  opts: { spillOver: number; max: number },
): Promise<Received> {
  if (Buffer.isBuffer(source)) {
    if (source.length > opts.max) throw tooLarge(opts.max);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const head = source.subarray(0, SNIFF_BYTES);
    if (source.length <= opts.spillOver) return { size: source.length, sha256, head, bytes: source, tmpPath: null };
    const spill = await openTmp();
    try {
      spill.out.end(source);
      await finished(spill.out);
    } catch (err) {
      await discard(spill);
      throw storageUnavailable(err);
    }
    return { size: source.length, sha256, head, bytes: null, tmpPath: spill.file };
  }

  const hash = createHash("sha256");
  const pending: Buffer[] = [];
  const headParts: Buffer[] = [];
  let headLen = 0;
  let size = 0;
  let spill: { file: string; out: fs.WriteStream } | null = null;

  const write = async (chunk: Buffer) => {
    if (!spill!.out.write(chunk)) await once(spill!.out, "drain");
  };

  try {
    for await (const raw of source) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      size += chunk.length;
      if (size > opts.max) throw tooLarge(opts.max);
      hash.update(chunk);
      if (headLen < SNIFF_BYTES) {
        const part = chunk.subarray(0, SNIFF_BYTES - headLen);
        headParts.push(part);
        headLen += part.length;
      }
      if (spill) {
        await write(chunk);
        continue;
      }
      pending.push(chunk);
      if (size > opts.spillOver) {
        spill = await openTmp();
        for (const held of pending.splice(0)) await write(held);
      }
    }
    if (spill) {
      spill.out.end();
      await finished(spill.out);
    }
  } catch (err) {
    source.destroy();
    if (spill) await discard(spill);
    throw err;
  }

  return {
    size,
    sha256: hash.digest("hex"),
    head: Buffer.concat(headParts),
    bytes: spill ? null : Buffer.concat(pending),
    tmpPath: spill?.file ?? null,
  };
}

/** Move a received temporary file to its permanent path; returns that path relative to DATA_DIR. */
export async function commitTmp(tmpPath: string, id: string): Promise<string> {
  const rel = relativePathFor(id);
  const abs = absolutePath(rel);
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.rename(tmpPath, abs);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true });
    throw storageUnavailable(err);
  }
  return rel;
}

export async function removeFile(rel: string | null): Promise<void> {
  if (!rel) return;
  try {
    await fsp.rm(absolutePath(rel), { force: true });
  } catch (err) {
    logger.warn("attachments.file.remove_failed", { path: rel, err: describeError(err) });
  }
}

/** Read the first `n` bytes of a stored file. */
export async function readHead(rel: string, n: number): Promise<Buffer> {
  const handle = await fsp.open(absolutePath(rel), "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
