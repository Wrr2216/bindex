import { pool } from "../../db/client";
import { env } from "../../env";
import { badRequest, notFound } from "../../lib/errors";
import { isValidPattern, MAX_PATTERNS } from "./patterns";
import { generateWebhookSecret } from "./signature";
import { checkTargetUrl } from "./transport";
import { publish } from "./bus";
import type { EventActor } from "./types";

/** Webhook endpoints: what administrators manage in Settings → Webhooks. */

type EndpointRow = {
  id: string;
  url: string;
  description: string;
  secret: string;
  event_patterns: string[];
  active: boolean;
  failure_count: number;
  disabled_at: Date | null;
  disabled_reason: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type StatsRow = {
  endpoint_id: string;
  pending: number;
  retrying: number;
  dead: number;
  last_status: string | null;
  last_response_status: number | null;
  last_at: Date | null;
};

/** What the API returns. The secret never appears after creation. */
export type WebhookEndpointInfo = {
  id: string;
  url: string;
  description: string;
  eventPatterns: string[];
  active: boolean;
  failureCount: number;
  disabledAt: string | null;
  disabledReason: string | null;
  secretHint: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  deliveries: {
    pending: number;
    retrying: number;
    dead: number;
    last: { status: string; responseStatus: number | null; at: string } | null;
  };
};

const EMPTY_STATS = { pending: 0, retrying: 0, dead: 0, last: null };

function toInfo(r: EndpointRow, s?: StatsRow): WebhookEndpointInfo {
  return {
    id: r.id,
    url: r.url,
    description: r.description,
    eventPatterns: r.event_patterns,
    active: r.active,
    failureCount: r.failure_count,
    disabledAt: r.disabled_at?.toISOString() ?? null,
    disabledReason: r.disabled_reason,
    secretHint: `${r.secret.slice(0, 6)}…${r.secret.slice(-4)}`,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deliveries: s
      ? {
          pending: s.pending,
          retrying: s.retrying,
          dead: s.dead,
          last:
            s.last_status && s.last_at
              ? { status: s.last_status, responseStatus: s.last_response_status, at: s.last_at.toISOString() }
              : null,
        }
      : EMPTY_STATS,
  };
}

/**
 * What the audit log records about an endpoint: the host but not the path or
 * query, which for many receivers (chat hooks, automation platforms) is itself
 * a credential, and the feed is readable by every signed-in user.
 */
function auditView(r: Pick<EndpointRow, "url" | "description" | "event_patterns" | "active">) {
  let host = "";
  try {
    host = new URL(r.url).host;
  } catch {
    // Stored URLs were validated; an unparseable one is recorded without a host.
  }
  return { host, description: r.description, eventPatterns: r.event_patterns, active: r.active };
}

function normalizePatterns(patterns: string[]): string[] {
  const out = [...new Set(patterns.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (out.length === 0) throw badRequest("Choose at least one event, or * for all of them.");
  if (out.length > MAX_PATTERNS) throw badRequest(`Use at most ${MAX_PATTERNS} event patterns.`);
  const bad = out.filter((p) => !isValidPattern(p));
  if (bad.length) {
    throw badRequest(
      `Not a valid event pattern: ${bad.join(", ")}. Use event names such as item.created, with * as a wildcard.`,
    );
  }
  return out;
}

function normalizeUrl(raw: string): string {
  const check = checkTargetUrl(raw.trim(), env.WEBHOOK_ALLOW_PRIVATE);
  if (!check.ok) throw badRequest(check.reason);
  return check.url.toString();
}

async function loadRow(id: string): Promise<EndpointRow> {
  const { rows } = await pool.query<EndpointRow>("SELECT * FROM webhook_endpoints WHERE id::text = $1", [id]);
  if (!rows[0]) throw notFound("Webhook endpoint not found.");
  return rows[0];
}

async function stats(ids: string[]): Promise<Map<string, StatsRow>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query<StatsRow>(
    `SELECT e.id AS endpoint_id,
            (SELECT count(*) FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'pending')::int AS pending,
            (SELECT count(*) FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'failed' AND d.next_attempt_at IS NOT NULL)::int AS retrying,
            (SELECT count(*) FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'dead')::int AS dead,
            l.status AS last_status, l.response_status AS last_response_status, l.updated_at AS last_at
       FROM webhook_endpoints e
       LEFT JOIN LATERAL (
         SELECT status, response_status, updated_at FROM webhook_deliveries d
          WHERE d.endpoint_id = e.id AND d.attempts > 0
          ORDER BY d.id DESC LIMIT 1
       ) l ON true
      WHERE e.id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.endpoint_id, r]));
}

export async function listEndpoints(): Promise<WebhookEndpointInfo[]> {
  const { rows } = await pool.query<EndpointRow>("SELECT * FROM webhook_endpoints ORDER BY created_at");
  const s = await stats(rows.map((r) => r.id));
  return rows.map((r) => toInfo(r, s.get(r.id)));
}

export async function getEndpoint(id: string): Promise<WebhookEndpointInfo> {
  const row = await loadRow(id);
  return toInfo(row, (await stats([row.id])).get(row.id));
}

/** Loads the secret too; only the delivery worker needs it. */
export async function getEndpointForDelivery(id: string): Promise<EndpointRow> {
  return loadRow(id);
}

export type EndpointInput = {
  url: string;
  description?: string;
  eventPatterns: string[];
  active?: boolean;
};

/** Returns the secret in the clear, the only time it is ever shown. */
export async function createEndpoint(
  input: EndpointInput,
  actor: EventActor,
): Promise<WebhookEndpointInfo & { secret: string }> {
  const url = normalizeUrl(input.url);
  const patterns = normalizePatterns(input.eventPatterns);
  const secret = generateWebhookSecret();
  const { rows } = await pool.query<EndpointRow>(
    `INSERT INTO webhook_endpoints (url, description, secret, event_patterns, active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [url, input.description?.trim() ?? "", secret, patterns, input.active ?? true, actor.id],
  );
  const row = rows[0]!;
  await publish("webhook.endpoint_created", auditView(row), {
    actor,
    subject: { type: "webhook_endpoint", id: row.id },
  });
  return { ...toInfo(row), secret };
}

export async function updateEndpoint(
  id: string,
  patch: Partial<EndpointInput>,
  actor: EventActor,
): Promise<WebhookEndpointInfo> {
  const existing = await loadRow(id);
  const url = patch.url === undefined ? existing.url : normalizeUrl(patch.url);
  const patterns = patch.eventPatterns === undefined ? existing.event_patterns : normalizePatterns(patch.eventPatterns);
  const description = patch.description === undefined ? existing.description : patch.description.trim();
  const active = patch.active ?? existing.active;
  const reenabled = active && !existing.active;
  const switchedOff = !active && existing.active;

  const { rows } = await pool.query<EndpointRow>(
    `UPDATE webhook_endpoints
        SET url = $2, description = $3, event_patterns = $4, active = $5,
            failure_count = CASE WHEN $6 THEN 0 ELSE failure_count END,
            disabled_at = CASE WHEN $6 THEN NULL WHEN $7 THEN now() ELSE disabled_at END,
            disabled_reason = CASE WHEN $6 THEN NULL WHEN $7 THEN 'Switched off by an administrator.' ELSE disabled_reason END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [existing.id, url, description, patterns, active, reenabled, switchedOff],
  );
  const row = rows[0]!;
  await publish(
    "webhook.endpoint_updated",
    { ...auditView(row), changed: Object.keys(patch).filter((k) => patch[k as keyof EndpointInput] !== undefined) },
    { actor, subject: { type: "webhook_endpoint", id: row.id } },
  );
  return getEndpoint(row.id);
}

export async function rotateSecret(id: string, actor: EventActor): Promise<{ secret: string }> {
  const existing = await loadRow(id);
  const secret = generateWebhookSecret();
  await pool.query("UPDATE webhook_endpoints SET secret = $2, updated_at = now() WHERE id = $1", [existing.id, secret]);
  await publish(
    "webhook.endpoint_updated",
    { ...auditView(existing), changed: ["secret"] },
    { actor, subject: { type: "webhook_endpoint", id: existing.id } },
  );
  return { secret };
}

export async function deleteEndpoint(id: string, actor: EventActor): Promise<void> {
  const existing = await loadRow(id);
  await pool.query("DELETE FROM webhook_endpoints WHERE id = $1", [existing.id]);
  await publish("webhook.endpoint_deleted", auditView(existing), {
    actor,
    subject: { type: "webhook_endpoint", id: existing.id },
  });
}
