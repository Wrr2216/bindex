import fsp from "node:fs/promises";
import path from "node:path";
import { pool } from "../../db/client";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { ownerTypes } from "./owners";
import { attachmentsRoot, removeFile, tmpRoot } from "./storage";

/**
 * Housekeeping for attachments.
 *
 * Owners are polymorphic, so there is no foreign key to cascade a delete. This
 * sweep removes the signatures and attachments of records that no longer exist,
 * and files on disk that no row points at (left by a crash mid-upload). Doing
 * it afterwards rather than in a trigger is also what lets a JSON restore,
 * which deletes and re-inserts every item inside one transaction, leave the
 * photos of the items it brings back alone.
 */

// Leave anything younger than this: an owner and its attachment may be
// created in separate steps.
const GRACE_MINUTES = 10;
// An upload still streaming in has a .part file this young at most.
const STALE_PART_MS = 6 * 60 * 60 * 1000;
const STRAY_FILE_MS = 60 * 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

export async function sweepOrphans(): Promise<{ signatures: number; attachments: number; files: number }> {
  let sigCount = 0;
  let attCount = 0;
  for (const type of ownerTypes()) {
    if (!type.table) continue;
    const idColumn = type.idColumn ?? "id";
    const missing = `NOT EXISTS (SELECT 1 FROM ${type.table} o WHERE o.${idColumn} = x.owner_id)`;
    // Signatures first: their images are held by a restricting foreign key.
    const sigs = await pool.query(
      `DELETE FROM signatures x WHERE x.owner_type = $1
         AND x.signed_at < now() - interval '${GRACE_MINUTES} minutes' AND ${missing}`,
      [type.name],
    );
    const atts = await pool.query<{ path: string | null }>(
      `DELETE FROM attachments x WHERE x.owner_type = $1
         AND x.created_at < now() - interval '${GRACE_MINUTES} minutes' AND ${missing}
         AND NOT EXISTS (SELECT 1 FROM signatures s WHERE s.attachment_id = x.id)
       RETURNING x.path`,
      [type.name],
    );
    for (const r of atts.rows) await removeFile(r.path);
    sigCount += sigs.rowCount ?? 0;
    attCount += atts.rowCount ?? 0;
  }
  const files = await sweepStrayFiles();
  if (sigCount || attCount || files) {
    logger.info("attachments.sweep.done", { signatures: sigCount, attachments: attCount, files });
  }
  return { signatures: sigCount, attachments: attCount, files };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

async function olderThan(file: string, ms: number): Promise<boolean> {
  try {
    const st = await fsp.stat(file);
    return st.isFile() && Date.now() - st.mtimeMs > ms;
  } catch {
    return false;
  }
}

async function sweepStrayFiles(): Promise<number> {
  let removed = 0;
  const tmp = tmpRoot();
  for (const name of await listDir(tmp)) {
    const file = path.join(tmp, name);
    if (await olderThan(file, STALE_PART_MS)) {
      await fsp.rm(file, { force: true });
      removed++;
    }
  }

  const root = attachmentsRoot();
  for (const bucket of await listDir(root)) {
    if (!/^[0-9a-f]{2}$/.test(bucket)) continue;
    const dir = path.join(root, bucket);
    const names = (await listDir(dir)).filter((n) => /^[0-9a-f-]{36}$/.test(n));
    if (!names.length) continue;
    const { rows } = await pool.query<{ id: string }>(`SELECT id::text FROM attachments WHERE id = ANY($1::uuid[])`, [
      names,
    ]);
    const known = new Set(rows.map((r) => r.id));
    for (const name of names) {
      if (known.has(name)) continue;
      const file = path.join(dir, name);
      if (await olderThan(file, STRAY_FILE_MS)) {
        await fsp.rm(file, { force: true });
        removed++;
      }
    }
  }
  return removed;
}

async function checkDataDir(): Promise<void> {
  try {
    await fsp.mkdir(tmpRoot(), { recursive: true });
    await fsp.access(tmpRoot(), fsp.constants.W_OK);
  } catch (err) {
    logger.warn("attachments.data_dir.unwritable", {
      dataDir: env.dataDir,
      hint: `uploads over ${env.ATTACHMENT_DB_MAX_MB} MB will fail until DATA_DIR is writable`,
      err: describeError(err),
    });
  }
}

/** Start the hourly sweep. Safe to call once at boot. */
export function startAttachmentSweeper(): void {
  void checkDataDir();
  const run = () =>
    sweepOrphans().catch((err) => logger.warn("attachments.sweep.failed", { err: describeError(err) }));
  setTimeout(run, 60_000).unref();
  setInterval(run, INTERVAL_MS).unref();
}

