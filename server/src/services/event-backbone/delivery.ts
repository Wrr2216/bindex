import { pool } from "../../db/client";
import { env } from "../../env";
import { badRequest, describeError, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { notify } from "../../lib/notify";
import { getConfig } from "../config";
import { publish, setDeliveryListener, SYSTEM_ACTOR } from "./bus";
import {
  AUTO_DISABLE_AFTER,
  DELIVERY_LEASE_MS,
  DELIVERY_RETENTION_DAYS,
  DELIVERY_TIMEOUT_MS,
  isSuccessStatus,
  nextRetryDelayMs,
} from "./policy";
import { SIGNATURE_HEADER, signatureHeader } from "./signature";
import { checkTargetUrl, postJson, type PostResult } from "./transport";
import { rowToEntry, toEnvelope, type AuditRow, type EventActor, type EventEnvelope } from "./types";

/**
 * Sending webhooks. Deliveries are rows, queued in the same statement that
 * logs the event (see bus.ts). Every app replica runs this worker; each claims
 * due rows with FOR UPDATE SKIP LOCKED and a short lease, so no two replicas
 * send the same delivery, and a replica that dies mid-send only delays it
 * until the lease runs out.
 */

const BATCH = 10;
const POLL_MS = 5_000;
const USER_AGENT = "Bindex-Webhooks/1";

type DeliveryRow = {
  id: string;
  endpoint_id: string;
  audit_log_id: string | null;
  event_type: string;
  status: "pending" | "succeeded" | "failed" | "dead";
  attempts: number;
  next_attempt_at: Date | null;
  locked_until: Date | null;
  response_status: number | null;
  response_ms: number | null;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type DeliveryInfo = {
  id: number;
  endpointId: string;
  auditLogId: number | null;
  eventType: string;
  /**
   * pending: not tried yet. failed: the last attempt failed; retried at
   * nextAttemptAt unless that is null. succeeded and dead are final.
   */
  status: DeliveryRow["status"];
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseMs: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toInfo(r: DeliveryRow): DeliveryInfo {
  return {
    id: Number(r.id),
    endpointId: r.endpoint_id,
    auditLogId: r.audit_log_id === null ? null : Number(r.audit_log_id),
    eventType: r.event_type,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at?.toISOString() ?? null,
    responseStatus: r.response_status,
    responseMs: r.response_ms,
    lastError: r.last_error,
    deliveredAt: r.delivered_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

type Target = { id: string; url: string; secret: string };

/** Sign and send one body. Never throws. */
async function send(target: Target, deliveryId: string, eventType: string, body: string): Promise<PostResult> {
  const check = checkTargetUrl(target.url, env.WEBHOOK_ALLOW_PRIVATE);
  if (!check.ok) return { status: null, ms: 0, error: check.reason, body: "" };
  return postJson(
    check.url,
    body,
    {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-Bindex-Event": eventType,
      "X-Bindex-Delivery": deliveryId,
      [SIGNATURE_HEADER]: signatureHeader(target.secret, body, Math.floor(Date.now() / 1000)),
    },
    { timeoutMs: DELIVERY_TIMEOUT_MS, allowPrivate: env.WEBHOOK_ALLOW_PRIVATE },
  );
}

function describeFailure(r: PostResult): string {
  if (r.error) return r.error.slice(0, 500);
  const snippet = r.body.replace(/\s+/g, " ").trim().slice(0, 300);
  return `HTTP ${r.status ?? "?"}${snippet ? `: ${snippet}` : ""}`;
}

/**
 * Store the outcome of one attempt and move the endpoint's failure streak.
 * With `retry` false (a test ping) a failure is final but still counts
 * against the endpoint, since it says the receiver is not answering.
 */
async function recordOutcome(d: DeliveryRow, result: PostResult, retry: boolean): Promise<DeliveryRow> {
  const attempts = d.attempts + 1;
  if (isSuccessStatus(result.status) && !result.error) {
    const { rows } = await pool.query<DeliveryRow>(
      `UPDATE webhook_deliveries
          SET status = 'succeeded', attempts = $2, response_status = $3, response_ms = $4,
              last_error = NULL, next_attempt_at = NULL, locked_until = NULL,
              delivered_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [d.id, attempts, result.status, result.ms],
    );
    await pool.query(
      "UPDATE webhook_endpoints SET failure_count = 0 WHERE id = $1 AND failure_count <> 0",
      [d.endpoint_id],
    );
    return rows[0]!;
  }

  const delay = retry ? nextRetryDelayMs(attempts) : null;
  const status = retry && delay === null ? "dead" : "failed";
  const { rows } = await pool.query<DeliveryRow>(
    `UPDATE webhook_deliveries
        SET status = $2, attempts = $3, response_status = $4, response_ms = $5, last_error = $6,
            next_attempt_at = CASE WHEN $7::bigint IS NULL THEN NULL
                                   ELSE now() + ($7::bigint * interval '1 millisecond') END,
            locked_until = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [d.id, status, attempts, result.status, result.ms, describeFailure(result), delay],
  );
  await countFailure(d.endpoint_id);
  return rows[0]!;
}

/** One more consecutive failure; the one that reaches the limit switches the endpoint off. */
async function countFailure(endpointId: string): Promise<void> {
  const reason = `Switched off after ${AUTO_DISABLE_AFTER} failed deliveries in a row.`;
  const { rows } = await pool.query<{ id: string; url: string; description: string; event_patterns: string[]; failure_count: number; was_active: boolean; active: boolean }>(
    `WITH old AS (SELECT id, active FROM webhook_endpoints WHERE id = $1 FOR UPDATE)
     UPDATE webhook_endpoints e
        SET failure_count = e.failure_count + 1,
            active = CASE WHEN e.failure_count + 1 >= $2 THEN false ELSE e.active END,
            disabled_at = CASE WHEN e.failure_count + 1 >= $2 AND e.active THEN now() ELSE e.disabled_at END,
            disabled_reason = CASE WHEN e.failure_count + 1 >= $2 AND e.active THEN $3 ELSE e.disabled_reason END,
            updated_at = now()
       FROM old
      WHERE e.id = old.id
      RETURNING e.id, e.url, e.description, e.event_patterns, e.failure_count, old.active AS was_active, e.active`,
    [endpointId, AUTO_DISABLE_AFTER, reason],
  );
  const ep = rows[0];
  if (!ep || !ep.was_active || ep.active) return;

  let host = "";
  try {
    host = new URL(ep.url).host;
  } catch {
    // Validated on save; nothing useful to add if it somehow is not a URL.
  }
  logger.warn("webhooks.endpoint.auto_disabled", { id: ep.id, host, failures: ep.failure_count });
  await publish(
    "webhook.endpoint_disabled",
    { host, description: ep.description, eventPatterns: ep.event_patterns, failureCount: ep.failure_count, reason },
    { actor: SYSTEM_ACTOR, subject: { type: "webhook_endpoint", id: ep.id } },
  );
  const { appName } = await getConfig().catch(() => ({ appName: "Bindex" }));
  void notify({
    title: `${appName}: webhook switched off`,
    message: `The webhook to ${host || "an endpoint"}${ep.description ? ` (${ep.description})` : ""} failed ${ep.failure_count} times in a row and was switched off. Fix the receiver, then turn it back on in Settings, Webhooks; waiting deliveries resume.`,
    priority: "high",
  }).catch((err) => logger.warn("webhooks.notify_failed", { err: describeError(err) }));
}

const CLAIM_SQL = `
  UPDATE webhook_deliveries d
     SET locked_until = now() + ($2::bigint * interval '1 millisecond')
    FROM (
      SELECT d2.id
        FROM webhook_deliveries d2
        JOIN webhook_endpoints e ON e.id = d2.endpoint_id
       WHERE d2.status IN ('pending', 'failed')
         AND d2.next_attempt_at <= now()
         AND (d2.locked_until IS NULL OR d2.locked_until < now())
         AND e.active
       ORDER BY d2.next_attempt_at, d2.id
       LIMIT $1
       FOR UPDATE OF d2 SKIP LOCKED
    ) due
   WHERE d.id = due.id
  RETURNING d.*`;

/**
 * Claim and send up to `limit` due deliveries. Returns how many were claimed,
 * so a caller can keep going while there is a backlog.
 */
export async function runDeliveryBatch(limit = BATCH): Promise<number> {
  const { rows: claimed } = await pool.query<DeliveryRow>(CLAIM_SQL, [limit, DELIVERY_LEASE_MS]);
  if (claimed.length === 0) return 0;

  const endpointIds = [...new Set(claimed.map((d) => d.endpoint_id))];
  const eventIds = [...new Set(claimed.map((d) => d.audit_log_id).filter((v): v is string => v !== null))];
  const [endpoints, events] = await Promise.all([
    pool.query<Target>("SELECT id, url, secret FROM webhook_endpoints WHERE id = ANY($1::uuid[])", [endpointIds]),
    pool.query<AuditRow>("SELECT * FROM audit_log WHERE id = ANY($1::bigint[])", [eventIds]),
  ]);
  const endpointById = new Map(endpoints.rows.map((e) => [e.id, e]));
  const eventById = new Map(events.rows.map((e) => [String(e.id), e]));

  await Promise.all(
    claimed.map(async (d) => {
      try {
        const target = endpointById.get(d.endpoint_id);
        const event = d.audit_log_id ? eventById.get(d.audit_log_id) : undefined;
        if (!target || !event) {
          await pool.query(
            `UPDATE webhook_deliveries SET status = 'dead', next_attempt_at = NULL, locked_until = NULL,
                    last_error = 'The event or endpoint no longer exists.', updated_at = now()
              WHERE id = $1`,
            [d.id],
          );
          return;
        }
        const body = JSON.stringify(toEnvelope(rowToEntry(event)));
        const result = await send(target, d.id, d.event_type, body);
        const after = await recordOutcome(d, result, true);
        logger.info("webhooks.delivery", {
          id: d.id,
          endpoint: d.endpoint_id,
          type: d.event_type,
          status: after.status,
          http: result.status,
          ms: result.ms,
        });
      } catch (err) {
        // The lease runs out and the delivery is claimed again later.
        logger.warn("webhooks.delivery.error", { id: d.id, err: describeError(err) });
      }
    }),
  );
  return claimed.length;
}

// ---- On-demand sends ---------------------------------------------------------

/**
 * A ping is not an event: it is sent once to one endpoint, is not written to
 * the audit log, and has id 0 and a null hash so a receiver can tell it apart.
 */
export type PingEnvelope = Omit<EventEnvelope, "hash"> & { hash: null };

async function insertLeased(endpointId: string, auditLogId: string | null, eventType: string, retryable: boolean) {
  const { rows } = await pool.query<DeliveryRow>(
    `INSERT INTO webhook_deliveries (endpoint_id, audit_log_id, event_type, next_attempt_at, locked_until)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END, now() + ($5::bigint * interval '1 millisecond'))
     RETURNING *`,
    [endpointId, auditLogId, eventType, retryable, DELIVERY_LEASE_MS],
  );
  return rows[0]!;
}

async function loadTarget(endpointId: string): Promise<Target> {
  const { rows } = await pool.query<Target>(
    "SELECT id, url, secret FROM webhook_endpoints WHERE id::text = $1",
    [endpointId],
  );
  if (!rows[0]) throw notFound("Webhook endpoint not found.");
  return rows[0];
}

/** Send a test event now and report what the receiver said. */
export async function pingEndpoint(endpointId: string, actor: EventActor): Promise<DeliveryInfo> {
  const target = await loadTarget(endpointId);
  const { appName } = await getConfig();
  const delivery = await insertLeased(target.id, null, "webhook.ping", false);
  const envelope: PingEnvelope = {
    id: 0,
    type: "webhook.ping",
    occurredAt: new Date().toISOString(),
    subject: { type: "webhook_endpoint", id: target.id },
    actor: { kind: actor.kind, id: actor.id, name: actor.name ?? null },
    data: { message: `Test delivery from ${appName}. No action is needed.` },
    hash: null,
  };
  const result = await send(target, delivery.id, "webhook.ping", JSON.stringify(envelope));
  return toInfo(await recordOutcome(delivery, result, false));
}

/**
 * Send an event to an endpoint again, as a new delivery so the original's
 * history stays in the log. Receivers should deduplicate on the event id.
 */
export async function redeliver(deliveryId: string): Promise<DeliveryInfo> {
  if (!/^\d+$/.test(deliveryId)) throw notFound("Delivery not found.");
  const { rows } = await pool.query<DeliveryRow>("SELECT * FROM webhook_deliveries WHERE id = $1", [deliveryId]);
  const old = rows[0];
  if (!old) throw notFound("Delivery not found.");
  if (!old.audit_log_id) throw badRequest("A test ping cannot be sent again. Send a new one instead.");
  const event = await pool.query<AuditRow>("SELECT * FROM audit_log WHERE id = $1", [old.audit_log_id]);
  if (!event.rows[0]) throw badRequest("That event is no longer in the audit log.");
  const target = await loadTarget(old.endpoint_id);

  const delivery = await insertLeased(target.id, old.audit_log_id, old.event_type, true);
  const body = JSON.stringify(toEnvelope(rowToEntry(event.rows[0])));
  const result = await send(target, delivery.id, delivery.event_type, body);
  const after = await recordOutcome(delivery, result, true);
  if (after.status === "succeeded") {
    // The event is delivered now, so the original's scheduled retry would only
    // send it again. One already being sent is left to finish.
    await pool.query(
      `UPDATE webhook_deliveries
          SET next_attempt_at = NULL, updated_at = now(),
              last_error = coalesce(last_error || ' ', '') || $2
        WHERE id = $1 AND status = 'failed' AND next_attempt_at IS NOT NULL
          AND (locked_until IS NULL OR locked_until < now())`,
      [old.id, `Sent again as delivery ${after.id}.`],
    );
  }
  return toInfo(after);
}

export async function listDeliveries(
  endpointId: string,
  opts: { status?: DeliveryRow["status"]; before?: number; limit?: number } = {},
): Promise<{ deliveries: DeliveryInfo[]; nextBefore: number | null }> {
  const target = await loadTarget(endpointId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [target.id];
  const conds = ["endpoint_id = $1"];
  if (opts.status) {
    params.push(opts.status);
    conds.push(`status = $${params.length}`);
  }
  if (opts.before) {
    params.push(opts.before);
    conds.push(`id < $${params.length}`);
  }
  params.push(limit + 1);
  const { rows } = await pool.query<DeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE ${conds.join(" AND ")} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  const deliveries = rows.slice(0, limit).map(toInfo);
  return { deliveries, nextBefore: rows.length > limit ? deliveries[deliveries.length - 1]!.id : null };
}

/** Finished deliveries past the retention window. */
export async function pruneDeliveries(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM webhook_deliveries
      WHERE updated_at < now() - ($1::int * interval '1 day')
        AND (status IN ('succeeded', 'dead') OR (status = 'failed' AND next_attempt_at IS NULL))`,
    [DELIVERY_RETENTION_DAYS],
  );
  return rowCount ?? 0;
}

// ---- Worker ------------------------------------------------------------------

let pollTimer: NodeJS.Timeout | null = null;
let kickTimer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;

/** Drain everything that is due. Overlapping calls fold into one extra pass. */
export async function drainDeliveries(): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      while ((await runDeliveryBatch(BATCH)) === BATCH) {
        // A full batch means there may be more waiting.
      }
    } while (rerun);
  } catch (err) {
    logger.warn("webhooks.worker.failed", { err: describeError(err) });
  } finally {
    running = false;
  }
}

function kick(): void {
  if (kickTimer) return;
  // A short delay lets a burst of events go out in one batch.
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void drainDeliveries();
  }, 50);
  kickTimer.unref();
}

/**
 * Start sending. Events published in this process are sent straight away;
 * the poll picks up retries and anything queued by another replica.
 */
export function startDeliveryWorker(pollMs = POLL_MS): void {
  if (pollTimer) return;
  setDeliveryListener(kick);
  pollTimer = setInterval(() => void drainDeliveries(), pollMs);
  pollTimer.unref();
  kick();
}

export function stopDeliveryWorker(): void {
  setDeliveryListener(null);
  if (pollTimer) clearInterval(pollTimer);
  if (kickTimer) clearTimeout(kickTimer);
  pollTimer = null;
  kickTimer = null;
}
