/** Shapes shared by the event bus, the audit log, webhooks and the feed. */

export type ActorKind = "user" | "api_key" | "device" | "system";

/**
 * Who caused an event. `name` may be left out for users and API keys: it is
 * looked up when the event is written, so the log keeps the name as it was at
 * the time even if the account is renamed later.
 */
export type EventActor = {
  kind: ActorKind;
  id: string | null;
  name?: string | null;
};

/** The record an event is about. Ids are text so any table's key fits. */
export type EventSubject = { type: string; id: string };

export type PublishOptions = {
  /** Defaults to the system actor. */
  actor?: EventActor | null;
  subject?: EventSubject | null;
};

/** One audit_log row as the API and exports present it. */
export type AuditEntry = {
  id: number;
  /** ISO 8601, UTC, millisecond precision. Assigned by the database. */
  occurredAt: string;
  actor: { kind: ActorKind; id: string | null; name: string | null };
  type: string;
  subject: EventSubject | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

/**
 * The body of every webhook POST and every entry in the polling feed. `hash`
 * is the audit_log hash of the event, so a receiver that stores it holds an
 * independent witness to the chain.
 */
export type EventEnvelope = {
  id: number;
  type: string;
  occurredAt: string;
  subject: EventSubject | null;
  actor: { kind: ActorKind; id: string | null; name: string | null };
  data: Record<string, unknown>;
  hash: string;
};

export function toEnvelope(entry: AuditEntry): EventEnvelope {
  return {
    id: entry.id,
    type: entry.type,
    occurredAt: entry.occurredAt,
    subject: entry.subject,
    actor: entry.actor,
    data: entry.data,
    hash: entry.hash,
  };
}

/** A pg row from audit_log (bigint ids arrive as strings). */
export type AuditRow = {
  id: string | number;
  occurred_at: Date;
  actor_kind: ActorKind;
  actor_id: string | null;
  actor_name: string | null;
  type: string;
  subject_type: string | null;
  subject_id: string | null;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

export function rowToEntry(r: AuditRow): AuditEntry {
  return {
    id: Number(r.id),
    occurredAt: r.occurred_at.toISOString(),
    actor: { kind: r.actor_kind, id: r.actor_id, name: r.actor_name },
    type: r.type,
    subject: r.subject_type && r.subject_id ? { type: r.subject_type, id: r.subject_id } : null,
    data: r.data ?? {},
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
