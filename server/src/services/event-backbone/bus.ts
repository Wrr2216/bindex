import type { Pool, PoolClient } from "pg";
import { pool } from "../../db/client";
import { env } from "../../env";
import { logger } from "../../lib/logger";
import { describeError } from "../../lib/errors";
import { isValidEventType } from "./patterns";
import {
  rowToEntry,
  type AuditEntry,
  type AuditRow,
  type EventActor,
  type EventSubject,
  type PublishOptions,
} from "./types";

/**
 * The event bus. Every feature reports what happened through publish(); each
 * event becomes one row of the tamper-evident audit log and is queued for any
 * webhook endpoint whose patterns select it.
 *
 *   await publish("job.stage_changed", { from, to }, {
 *     actor: actorFromOid(userOid),
 *     subject: { type: "job", id: job.id },
 *   });
 *
 * publish() never throws and never rejects. When the event cannot be written
 * (malformed type, database down) it logs why and resolves to null, so a
 * failure to audit never fails the action being audited. Call it after your
 * own transaction has committed: it writes on its own connection, and an
 * event published from inside a transaction that later rolls back would
 * record something that did not happen.
 */

export const SYSTEM_ACTOR: EventActor = { kind: "system", id: null, name: null };

/** Types only this module may write; publish() refuses them. */
const RESERVED_TYPES = new Set(["audit.checkpoint"]);

/** Past this the payload is replaced by a note saying how big it was. */
export const MAX_DATA_BYTES = 512 * 1024;
const MAX_DEPTH = 32;

type Queryable = Pool | PoolClient;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** jsonb rejects NUL and unpaired surrogates, which JavaScript strings allow. */
function cleanString(s: string): string {
  return s.replace(/\u0000/g, "").replace(LONE_SURROGATE, "�");
}

function clean(value: unknown, depth: number, seen: WeakSet<object>): Json | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "string":
      return cleanString(value);
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (depth >= MAX_DEPTH) return "[too deep]";
  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  const withJson = obj as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === "function") return clean(withJson.toJSON(), depth + 1, seen);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((v) => clean(v, depth + 1, seen) ?? null);
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(obj)) {
      const c = clean(v, depth + 1, seen);
      if (c !== undefined) out[cleanString(k)] = c;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Turn whatever a caller passed into a JSON object jsonb will accept and that
 * reads back identically: Dates become ISO strings, bigints strings, NaN null,
 * undefined keys disappear, and a non-object is wrapped as { value }.
 */
export function sanitizeEventData(data: unknown): Record<string, Json> {
  const cleaned = clean(data, 0, new WeakSet());
  const obj: Record<string, Json> =
    cleaned !== null && typeof cleaned === "object" && !Array.isArray(cleaned)
      ? cleaned
      : cleaned === undefined
        ? {}
        : { value: cleaned };
  const bytes = Buffer.byteLength(JSON.stringify(obj), "utf8");
  if (bytes <= MAX_DATA_BYTES) return obj;
  return { truncated: true, bytes, keys: Object.keys(obj).slice(0, 50) };
}

/**
 * The actor behind a stored user id: `api-key:<id>` is an API key, empty is
 * the system, anything else a signed-in person. `name` is optional; users and
 * keys are looked up by id when the event is written.
 */
export function actorFromOid(oid: string | null | undefined, name?: string | null): EventActor {
  if (!oid) return SYSTEM_ACTOR;
  if (oid.startsWith("api-key:")) return { kind: "api_key", id: oid.slice("api-key:".length), name: name ?? null };
  // AUTH_MODE=trusted has no account row to look the name up in.
  if (oid === "trusted:owner") return { kind: "user", id: oid, name: name ?? env.TRUSTED_USER_NAME };
  return { kind: "user", id: oid, name: name ?? null };
}

/** The actor for a request's user (session or API key). */
export function actorFromUser(user: { oid: string; name?: string | null } | null | undefined): EventActor {
  return user ? actorFromOid(user.oid, user.name || null) : SYSTEM_ACTOR;
}

let onQueued: (() => void) | null = null;

/** Lets the delivery worker hear that new deliveries are waiting. */
export function setDeliveryListener(fn: (() => void) | null): void {
  onQueued = fn;
}

const INSERT_SQL = `
  WITH ins AS (
    INSERT INTO audit_log (actor_kind, actor_id, actor_name, type, subject_type, subject_id, data)
    VALUES (
      $1, $2,
      COALESCE($3::text, CASE $1::text
        WHEN 'user' THEN (SELECT u.name FROM users u WHERE u.oid = $2::text)
        WHEN 'api_key' THEN (SELECT 'API key: ' || k.name FROM api_keys k WHERE k.id::text = $2::text)
      END),
      $4, $5, $6, $7::jsonb
    )
    RETURNING *
  ), fan AS (
    INSERT INTO webhook_deliveries (endpoint_id, audit_log_id, event_type)
    SELECT e.id, ins.id, ins.type
      FROM webhook_endpoints e CROSS JOIN ins
     WHERE e.active AND event_type_matches(ins.type, e.event_patterns)
    RETURNING id
  )
  SELECT ins.*, (SELECT count(*)::int FROM fan) AS queued FROM ins`;

/**
 * Write one event, fanning it out to webhooks in the same statement so an
 * event is never logged without its deliveries or the other way round.
 * Throws; publish() is the non-throwing wrapper.
 */
export async function insertEvent(
  db: Queryable,
  type: string,
  data: Record<string, Json>,
  actor: EventActor,
  subject: EventSubject | null,
): Promise<AuditEntry> {
  const { rows } = await db.query<AuditRow & { queued: number }>(INSERT_SQL, [
    actor.kind,
    actor.id,
    actor.name ?? null,
    type,
    subject?.type ?? null,
    subject?.id ?? null,
    JSON.stringify(data),
  ]);
  const row = rows[0]!;
  if (row.queued > 0) onQueued?.();
  return rowToEntry(row);
}

function validSubject(subject: EventSubject | null | undefined): EventSubject | null | "invalid" {
  if (!subject) return null;
  if (typeof subject.type !== "string" || !subject.type || typeof subject.id !== "string" || !subject.id) {
    return "invalid";
  }
  return { type: cleanString(subject.type).slice(0, 100), id: cleanString(subject.id).slice(0, 200) };
}

/**
 * Record that something happened. See the module comment; the full contract
 * is in docs/event-backbone.md.
 *
 * @param type    lowercase dotted name, at least two segments (item.created)
 * @param data    what a consumer needs to act on the event without another
 *                request; JSON-serialisable, at most 512 KB
 * @param options actor (defaults to system) and subject ({ type, id })
 * @returns the stored entry, with its audit-log id and hash, or null when the
 *          event could not be written (already logged)
 */
export async function publish(
  type: string,
  data: Record<string, unknown> = {},
  options: PublishOptions = {},
): Promise<AuditEntry | null> {
  try {
    if (typeof type !== "string" || !isValidEventType(type)) {
      logger.warn("events.publish.rejected", { type, reason: "invalid_type" });
      return null;
    }
    if (RESERVED_TYPES.has(type)) {
      logger.warn("events.publish.rejected", { type, reason: "reserved_type" });
      return null;
    }
    const subject = validSubject(options.subject);
    if (subject === "invalid") {
      logger.warn("events.publish.rejected", { type, reason: "invalid_subject" });
      return null;
    }
    const actor = options.actor ?? SYSTEM_ACTOR;
    const kind = ["user", "api_key", "device", "system"].includes(actor.kind) ? actor.kind : "system";
    return await insertEvent(
      pool,
      type,
      sanitizeEventData(data),
      {
        kind,
        id: actor.id == null ? null : cleanString(String(actor.id)),
        name: actor.name == null ? null : cleanString(String(actor.name)),
      },
      subject,
    );
  } catch (err) {
    logger.error("events.publish.failed", { type, err: describeError(err) });
    return null;
  }
}

/**
 * The bridge from item history into the bus: recordEvent() in items.ts calls
 * this once per item event, so every existing event also lands in the audit
 * log as item.<action>. Deleted items keep their id as the subject, taken
 * from the detail because the item_events row no longer points at it.
 */
export function publishItemEvent(
  itemId: string | null,
  userOid: string | null,
  action: string,
  detail: Record<string, unknown>,
): Promise<AuditEntry | null> {
  const subjectId = itemId ?? (typeof detail.itemId === "string" ? detail.itemId : null);
  return publish(`item.${action}`, detail, {
    actor: actorFromOid(userOid),
    subject: subjectId ? { type: "item", id: subjectId } : null,
  });
}
