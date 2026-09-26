import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pool } from "../../db/client";
import { env } from "../../env";
import { logger } from "../../lib/logger";
import { describeError } from "../../lib/errors";
import { notify } from "../../lib/notify";
import { GENESIS_HASH } from "./canonical";
import { patternToLike } from "./patterns";
import { SYSTEM_ACTOR, insertEvent } from "./bus";
import { rowToEntry, type AuditEntry, type AuditRow } from "./types";

/**
 * Reading, verifying, exporting and checkpointing the audit log. Writing is
 * the bus's job; nothing here modifies an existing row, and the database
 * would refuse if it tried.
 */

/** Same constant as the chaining trigger in migration 0025. */
const CHAIN_LOCK = 7302640025;
const VERIFY_BATCH = 5000;
const CHECKPOINT_TYPE = "audit.checkpoint";
const CHECKPOINT_INTERVAL_MS = 24 * 60 * 60_000;

// ---- Filters ---------------------------------------------------------------

export type AuditFilter = {
  /** Event patterns (`item.*`); an entry matching any of them is included. */
  types?: string[];
  subjectType?: string;
  subjectId?: string;
  /** Matches the actor id exactly or the actor name as a substring. */
  actor?: string;
  from?: Date;
  to?: Date;
};

function whereClause(f: AuditFilter, params: unknown[]): string {
  const conds: string[] = [];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    conds.push(sql(params.length));
  };
  if (f.types?.length) add((n) => `type LIKE ANY($${n}::text[])`, f.types.map(patternToLike));
  if (f.subjectType) add((n) => `subject_type = $${n}`, f.subjectType);
  if (f.subjectId) add((n) => `subject_id = $${n}`, f.subjectId);
  if (f.actor) {
    add((n) => `(actor_id = $${n} OR actor_name ILIKE '%' || $${n} || '%')`, f.actor);
  }
  if (f.from) add((n) => `occurred_at >= $${n}`, f.from);
  if (f.to) add((n) => `occurred_at < $${n}`, f.to);
  return conds.join(" AND ");
}

// ---- Viewer and feed -------------------------------------------------------

/** Newest first, paged by id: pass the returned nextBefore to get older ones. */
export async function listAuditLog(
  filter: AuditFilter,
  page: { before?: number; limit?: number } = {},
): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
  const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
  const params: unknown[] = [];
  const conds = [whereClause(filter, params)].filter(Boolean);
  if (page.before) {
    params.push(page.before);
    conds.push(`id < $${params.length}`);
  }
  params.push(limit + 1);
  const { rows } = await pool.query<AuditRow>(
    `SELECT * FROM audit_log ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
      ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map(rowToEntry);
  return { entries, nextBefore: more ? entries[entries.length - 1]!.id : null };
}

/**
 * Oldest first after a cursor, for systems that poll instead of receiving
 * webhooks. Keep the last id you processed and pass it back as `after`.
 */
export async function listEventsAfter(
  after: number,
  types: string[],
  limit = 100,
): Promise<{ entries: AuditEntry[]; hasMore: boolean }> {
  const n = Math.min(Math.max(limit, 1), 500);
  const params: unknown[] = [after];
  let typeCond = "";
  if (types.length) {
    params.push(types.map(patternToLike));
    typeCond = `AND type LIKE ANY($${params.length}::text[])`;
  }
  params.push(n + 1);
  const { rows } = await pool.query<AuditRow>(
    `SELECT * FROM audit_log WHERE id > $1 ${typeCond} ORDER BY id LIMIT $${params.length}`,
    params,
  );
  return { entries: rows.slice(0, n).map(rowToEntry), hasMore: rows.length > n };
}

export async function getAuditEntry(id: number): Promise<AuditEntry | null> {
  const { rows } = await pool.query<AuditRow>("SELECT * FROM audit_log WHERE id = $1", [id]);
  return rows[0] ? rowToEntry(rows[0]) : null;
}

/** Ascending batches for an export, so a large log never sits in memory. */
export async function* exportAuditLog(filter: AuditFilter, batch = 1000): AsyncGenerator<AuditEntry[]> {
  let after = 0;
  for (;;) {
    const params: unknown[] = [];
    const where = whereClause(filter, params);
    params.push(after, batch);
    const { rows } = await pool.query<AuditRow>(
      `SELECT * FROM audit_log WHERE ${where ? `${where} AND ` : ""}id > $${params.length - 1}
        ORDER BY id LIMIT $${params.length}`,
      params,
    );
    if (rows.length === 0) return;
    const entries = rows.map(rowToEntry);
    yield entries;
    after = entries[entries.length - 1]!.id;
    if (rows.length < batch) return;
  }
}

// ---- Checkpoints -------------------------------------------------------------

function signingKey(): Buffer {
  if (env.AUDIT_SIGNING_KEY) return Buffer.from(env.AUDIT_SIGNING_KEY, "utf8");
  // Derived rather than used directly, so the session secret itself never
  // signs anything that leaves the server.
  return createHmac("sha256", env.SESSION_SECRET).update("bindex.audit.checkpoint.key").digest();
}

/** Short fingerprint of the signing key, stored with each signature. */
export function signingKeyId(): string {
  return createHash("sha256").update(signingKey()).digest("hex").slice(0, 16);
}

export type CheckpointFacts = { headId: number; headHash: string; count: number };

export function signCheckpoint(f: CheckpointFacts): string {
  return createHmac("sha256", signingKey())
    .update(`bindex.audit.checkpoint.v1|${f.headId}|${f.headHash}|${f.count}`)
    .digest("hex");
}

export type CheckpointData = CheckpointFacts & { keyId: string; signature: string };

export type CheckpointCheck = "valid" | "invalid" | "unknown_key";

export function checkCheckpoint(data: Record<string, unknown>): CheckpointCheck {
  const { headId, headHash, count, keyId, signature } = data;
  if (
    typeof headId !== "number" ||
    typeof headHash !== "string" ||
    typeof count !== "number" ||
    typeof signature !== "string"
  ) {
    return "invalid";
  }
  if (keyId !== signingKeyId()) return "unknown_key";
  const expected = Buffer.from(signCheckpoint({ headId, headHash, count }), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? "valid" : "invalid";
}

/**
 * Append a signed audit.checkpoint recording the head hash and row count, and
 * send the same facts out through notify() so a copy of the head exists
 * outside this database. Without `force`, does nothing when the last
 * checkpoint is recent or nothing has happened since it, which also keeps
 * several replicas from writing one each.
 */
export async function createCheckpoint(force = false): Promise<AuditEntry | null> {
  // Count the bulk of the log before taking the lock: rows are append-only
  // and ids are handed out under the lock, so nothing can appear below a head
  // already seen, and only the tail needs counting while writers wait.
  const pre = await pool.query<{ id: string | null; n: string }>(
    `SELECT (SELECT max(id) FROM audit_log) AS id,
            (SELECT count(*) FROM audit_log) AS n`,
  );
  const seenHead = Number(pre.rows[0]?.id ?? 0);

  const client = await pool.connect();
  let entry: AuditEntry | null = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CHAIN_LOCK]);
    const { rows } = await client.query<{ id: string; hash: string; type: string; occurred_at: Date }>(
      "SELECT id, hash, type, occurred_at FROM audit_log ORDER BY id DESC LIMIT 1",
    );
    const head = rows[0];
    if (!force) {
      const last = await client.query<{ occurred_at: Date }>(
        "SELECT occurred_at FROM audit_log WHERE type = $1 ORDER BY id DESC LIMIT 1",
        [CHECKPOINT_TYPE],
      );
      const lastAt = last.rows[0]?.occurred_at.getTime() ?? 0;
      const nothingNew = !head || head.type === CHECKPOINT_TYPE;
      if (nothingNew || Date.now() - lastAt < CHECKPOINT_INTERVAL_MS - 60 * 60_000) {
        await client.query("ROLLBACK");
        return null;
      }
    }
    const tail = await client.query<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE id > $1", [seenHead]);
    const facts: CheckpointFacts = {
      headId: head ? Number(head.id) : 0,
      headHash: head?.hash ?? GENESIS_HASH,
      count: Number(pre.rows[0]?.n ?? 0) + Number(tail.rows[0]?.n ?? 0),
    };
    const data: CheckpointData = { ...facts, keyId: signingKeyId(), signature: signCheckpoint(facts) };
    entry = await insertEvent(client, CHECKPOINT_TYPE, data, SYSTEM_ACTOR, {
      type: "audit_log",
      id: String(facts.headId),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  logger.info("audit.checkpoint.created", { id: entry.id, headId: entry.data.headId, count: entry.data.count });
  void notify({
    title: "Audit log checkpoint",
    message: `Checkpoint #${entry.id}: ${String(entry.data.count)} entries through #${String(entry.data.headId)}, head ${String(entry.data.headHash)}, checkpoint hash ${entry.hash}.`,
    priority: "low",
  }).catch((err) => logger.warn("audit.checkpoint.notify_failed", { err: describeError(err) }));
  return entry;
}

// ---- Verification ------------------------------------------------------------

export type VerifyResult = {
  ok: boolean;
  /** Rows whose hash and link were confirmed before any break. */
  checked: number;
  firstBrokenId: number | null;
  reason: string | null;
  head: { id: number; hash: string } | null;
  /**
   * Set when older entries were archived: the retained log starts at a signed
   * checkpoint whose prev_hash is the hash of the last archived entry.
   */
  anchor: { id: number; archivedHeadId: number; archivedHeadHash: string; archivedCount: number } | null;
  checkpoints: { checked: number; invalid: number[]; unknownKey: number[] };
};

type BatchResult = {
  n: number;
  last_id: string | null;
  last_hash: string | null;
  broken_id: string | null;
  ok_before: number;
};

/**
 * Recompute every hash in SQL, in id order and in batches, and check each
 * row's prev_hash against the row before it. Also checks the signature on
 * every checkpoint.
 */
export async function verifyChain(): Promise<VerifyResult> {
  const checkpoints = await verifyCheckpoints();
  const result: VerifyResult = {
    ok: true,
    checked: 0,
    firstBrokenId: null,
    reason: null,
    head: null,
    anchor: null,
    checkpoints,
  };

  const firstRes = await pool.query<AuditRow>("SELECT * FROM audit_log ORDER BY id LIMIT 1");
  const first = firstRes.rows[0];
  if (!first) return finish(result);

  if (first.prev_hash !== GENESIS_HASH) {
    const d = first.data;
    const anchored =
      first.type === CHECKPOINT_TYPE && d.headHash === first.prev_hash && checkCheckpoint(d) === "valid";
    if (!anchored) {
      return finish({
        ...result,
        ok: false,
        firstBrokenId: Number(first.id),
        reason:
          "The log does not start at the beginning, and its first entry is not a valid signed checkpoint. Entries may have been removed.",
      });
    }
    result.anchor = {
      id: Number(first.id),
      archivedHeadId: Number(d.headId),
      archivedHeadHash: String(d.headHash),
      archivedCount: Number(d.count),
    };
  }

  let after = Number(first.id) - 1;
  let expectedPrev = first.prev_hash;
  for (;;) {
    const { rows } = await pool.query<BatchResult>(
      `WITH b AS (
         SELECT a.id, a.prev_hash, a.hash,
                encode(digest(a.prev_hash || audit_log_canonical(a), 'sha256'), 'hex') AS computed,
                coalesce(lag(a.hash) OVER (ORDER BY a.id), $2) AS expected_prev
           FROM audit_log a
          WHERE a.id > $1
          ORDER BY a.id
          LIMIT $3
       ), bad AS (
         SELECT min(id) AS id FROM b WHERE computed <> hash OR prev_hash <> expected_prev
       )
       SELECT (SELECT count(*) FROM b)::int AS n,
              (SELECT id FROM b ORDER BY id DESC LIMIT 1) AS last_id,
              (SELECT hash FROM b ORDER BY id DESC LIMIT 1) AS last_hash,
              (SELECT id FROM bad) AS broken_id,
              (SELECT count(*) FROM b, bad WHERE b.id < bad.id)::int AS ok_before`,
      [after, expectedPrev, VERIFY_BATCH],
    );
    const batch = rows[0]!;
    if (batch.broken_id !== null) {
      return finish({
        ...result,
        ok: false,
        checked: result.checked + batch.ok_before,
        firstBrokenId: Number(batch.broken_id),
        reason: "This entry does not match its hash, or does not link to the entry before it.",
      });
    }
    result.checked += batch.n;
    if (batch.n === 0 || batch.last_id === null) break;
    after = Number(batch.last_id);
    expectedPrev = batch.last_hash!;
    result.head = { id: after, hash: expectedPrev };
    if (batch.n < VERIFY_BATCH) break;
  }
  return finish(result);
}

function finish(r: VerifyResult): VerifyResult {
  const badCheckpoints = r.checkpoints.invalid.length > 0;
  return {
    ...r,
    ok: r.ok && !badCheckpoints,
    reason: r.reason ?? (badCheckpoints ? "A checkpoint signature does not verify." : null),
  };
}

async function verifyCheckpoints(): Promise<VerifyResult["checkpoints"]> {
  const { rows } = await pool.query<{ id: string; prev_hash: string; data: Record<string, unknown> }>(
    "SELECT id, prev_hash, data FROM audit_log WHERE type = $1 ORDER BY id",
    [CHECKPOINT_TYPE],
  );
  const out: VerifyResult["checkpoints"] = { checked: rows.length, invalid: [], unknownKey: [] };
  for (const r of rows) {
    const check = checkCheckpoint(r.data);
    // Written under the chain lock, so the head it names is the row it follows.
    if (check === "invalid" || r.data.headHash !== r.prev_hash) out.invalid.push(Number(r.id));
    else if (check === "unknown_key") out.unknownKey.push(Number(r.id));
  }
  return out;
}

// ---- Status ------------------------------------------------------------------

export type AuditStatus = {
  count: number;
  head: { id: number; hash: string; occurredAt: string } | null;
  firstId: number | null;
  lastCheckpoint: { id: number; occurredAt: string; headId: number; count: number } | null;
};

export async function auditStatus(): Promise<AuditStatus> {
  const { rows } = await pool.query<{
    n: string;
    first_id: string | null;
    head_id: string | null;
    head_hash: string | null;
    head_at: Date | null;
    cp_id: string | null;
    cp_at: Date | null;
    cp_data: Record<string, unknown> | null;
  }>(
    `SELECT (SELECT count(*) FROM audit_log) AS n,
            (SELECT min(id) FROM audit_log) AS first_id,
            h.id AS head_id, h.hash AS head_hash, h.occurred_at AS head_at,
            c.id AS cp_id, c.occurred_at AS cp_at, c.data AS cp_data
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (SELECT id, hash, occurred_at FROM audit_log ORDER BY id DESC LIMIT 1) h ON true
       LEFT JOIN LATERAL (SELECT id, occurred_at, data FROM audit_log WHERE type = $1 ORDER BY id DESC LIMIT 1) c ON true`,
    [CHECKPOINT_TYPE],
  );
  const r = rows[0]!;
  return {
    count: Number(r.n),
    firstId: r.first_id === null ? null : Number(r.first_id),
    head:
      r.head_id === null
        ? null
        : { id: Number(r.head_id), hash: r.head_hash!, occurredAt: r.head_at!.toISOString() },
    lastCheckpoint:
      r.cp_id === null
        ? null
        : {
            id: Number(r.cp_id),
            occurredAt: r.cp_at!.toISOString(),
            headId: Number(r.cp_data?.headId ?? 0),
            count: Number(r.cp_data?.count ?? 0),
          },
  };
}
