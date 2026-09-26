import { createHash } from "node:crypto";
import { pool } from "../../db/client";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";

/**
 * Idempotency-Key support for every state-changing /api request. The HTTP side
 * lives in routes/offline-field.ts; this is the store behind it.
 *
 * A device working offline queues its changes and replays them when it gets a
 * connection back. Some of those replays follow a request that did reach the
 * server but whose response was lost on the way back, so each change carries
 * a key the device generated when the change was made. The first request with
 * a key runs normally; its answer is stored, and any later request from the
 * same caller with the same key gets that stored answer back without running
 * again.
 *
 * Semantics follow the IETF httpapi Idempotency-Key draft:
 * - only successful (2xx) answers are kept. A rejected or failed request
 *   changed nothing, so its key is released and a retry runs for real;
 * - the same key on a different request (method, path or body) is a 422;
 * - a key whose first request is still running is a 409.
 */

export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TTL_SECONDS = 24 * 60 * 60;
// A claim this old with no answer belongs to a request that died with its
// process. Longer than Node's own five-minute request timeout.
const STALE_PENDING_SECONDS = 10 * 60;
// A bigger answer is remembered as having succeeded, without its body.
const MAX_STORED_BYTES = 8 * 1024 * 1024;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * Read the header. The draft sends it as a structured-field string, so a
 * quoted value is accepted as well as a bare one. Returns null when absent and
 * "invalid" when present but unusable.
 */
export function parseIdempotencyKey(raw: string | undefined): string | null | "invalid" {
  if (raw === undefined) return null;
  let value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  if (value.length < 1 || value.length > 255) return "invalid";
  // Visible ASCII only: the key goes into logs and a text column.
  if (!/^[\x21-\x7e]+$/.test(value)) return "invalid";
  return value;
}

export type FingerprintInput = {
  method: string;
  path: string;
  /** The parsed JSON body, when the global parser read one. */
  body: unknown;
  contentType?: string | null;
  contentLength?: string | null;
};

/**
 * Identify a request well enough to tell a genuine retry from a key reused on
 * something else. A JSON body is hashed as parsed; a raw upload (a photo) is
 * still unread at this point, so its type and length stand in for it.
 */
export function requestFingerprint(input: FingerprintInput): string {
  const body =
    input.body !== undefined
      ? `json:${JSON.stringify(input.body)}`
      : `raw:${input.contentType ?? ""}:${input.contentLength ?? ""}`;
  return createHash("sha256")
    .update(`${input.method.toUpperCase()} ${input.path}\n${body}`)
    .digest("hex");
}

export type StoredRow = {
  fingerprint: string;
  state: "pending" | "done";
  status: number | null;
  contentType: string | null;
  body: Buffer | null;
};

export type ClaimOutcome =
  | { kind: "claimed" }
  | { kind: "replay"; status: number; contentType: string | null; body: Buffer }
  | { kind: "mismatch" }
  | { kind: "in_progress" };

/** What to do with a key that someone else already claimed. Pure, for tests. */
export function decideExisting(row: StoredRow, fingerprint: string): ClaimOutcome {
  if (row.fingerprint !== fingerprint) return { kind: "mismatch" };
  if (row.state !== "done" || row.status === null) return { kind: "in_progress" };
  return {
    kind: "replay",
    status: row.status,
    contentType: row.contentType,
    body: row.body ?? Buffer.alloc(0),
  };
}

/**
 * What to keep once the first request has answered. Pure, for tests.
 *
 * A success must never run twice, so it is always kept, if need be without a
 * body that was streamed or too large to hold. Anything else changed nothing
 * and is released for a real retry.
 */
export function answerToKeep(status: number, streamed: boolean, bytes: number): "body" | "empty" | "release" {
  if (status < 200 || status >= 300) return "release";
  return !streamed && bytes <= MAX_STORED_BYTES ? "body" : "empty";
}

let lastPrune = 0;

function pruneExpired(): void {
  const now = Date.now();
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  pool
    .query("DELETE FROM idempotency_keys WHERE expires_at < now()")
    .then((r) => {
      if (r.rowCount) logger.info("idempotency.pruned", { rows: r.rowCount });
    })
    .catch((err) => logger.warn("idempotency.prune_failed", { err: describeError(err) }));
}

/**
 * Claim a key for this request, atomically. An expired key, or one stuck
 * pending by a request that never finished, is taken over. Anything else that
 * already holds the key decides the answer.
 */
export async function claimIdempotencyKey(
  principal: string,
  key: string,
  method: string,
  path: string,
  fingerprint: string,
): Promise<ClaimOutcome> {
  pruneExpired();
  // Two passes cover the race where the holder releases the key between our
  // failed insert and our read.
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await pool.query(
      `INSERT INTO idempotency_keys (principal, key, method, path, fingerprint, state, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', now() + make_interval(secs => $6))
       ON CONFLICT (principal, key) DO UPDATE
         SET method = EXCLUDED.method, path = EXCLUDED.path, fingerprint = EXCLUDED.fingerprint,
             state = 'pending', status = NULL, content_type = NULL, body = NULL,
             created_at = now(), expires_at = EXCLUDED.expires_at
         WHERE idempotency_keys.expires_at < now()
            OR (idempotency_keys.state = 'pending'
                AND idempotency_keys.created_at < now() - make_interval(secs => $7))
       RETURNING 1`,
      [principal, key, method, path, fingerprint, TTL_SECONDS, STALE_PENDING_SECONDS],
    );
    if (inserted.rowCount) return { kind: "claimed" };

    const { rows } = await pool.query<{
      fingerprint: string;
      state: "pending" | "done";
      status: number | null;
      content_type: string | null;
      body: Buffer | null;
    }>(
      `SELECT fingerprint, state, status, content_type, body
         FROM idempotency_keys WHERE principal = $1 AND key = $2`,
      [principal, key],
    );
    const row = rows[0];
    if (row) {
      return decideExisting(
        {
          fingerprint: row.fingerprint,
          state: row.state,
          status: row.status,
          contentType: row.content_type,
          body: row.body,
        },
        fingerprint,
      );
    }
  }
  return { kind: "in_progress" };
}

export async function storeIdempotentAnswer(
  principal: string,
  key: string,
  status: number,
  contentType: string | null,
  body: Buffer,
): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
        SET state = 'done', status = $3, content_type = $4, body = $5
      WHERE principal = $1 AND key = $2`,
    [principal, key, status, contentType, body],
  );
}

export async function releaseIdempotencyKey(principal: string, key: string): Promise<void> {
  await pool.query(
    `DELETE FROM idempotency_keys WHERE principal = $1 AND key = $2 AND state = 'pending'`,
    [principal, key],
  );
}
