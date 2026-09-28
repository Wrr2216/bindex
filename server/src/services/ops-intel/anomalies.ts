import { pool } from "../../db/client";
import { env } from "../../env";
import { conflict, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { actorFromOid } from "../event-backbone";
import { chatJson } from "../enrichment/model";
import { publishResolved } from "./events";
import { RULES, isRuleId, type Severity } from "./model";

/** The anomaly queue: listing, detail, resolving, counts and trends. */

export type AnomalyView = {
  id: string;
  rule: string;
  ruleTitle: string;
  key: string;
  severity: Severity;
  subjectType: string;
  subjectId: string;
  itemId: string | null;
  unitId: string | null;
  jobId: string | null;
  shipmentId: string | null;
  locationId: string | null;
  title: string;
  detail: Record<string, unknown>;
  link: string | null;
  sticky: boolean;
  occurrences: number;
  occurredAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolution: "fixed" | "dismissed" | "cleared" | null;
  resolutionNote: string | null;
  reopenedFrom: string | null;
  explanation: string | null;
};

const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

function view(r: Record<string, unknown>): AnomalyView {
  const rule = r.rule as string;
  return {
    id: r.id as string,
    rule,
    ruleTitle: isRuleId(rule) ? RULES[rule].title : rule,
    key: r.key as string,
    severity: r.severity as Severity,
    subjectType: r.subject_type as string,
    subjectId: r.subject_id as string,
    itemId: (r.item_id as string) ?? null,
    unitId: (r.unit_id as string) ?? null,
    jobId: (r.job_id as string) ?? null,
    shipmentId: (r.shipment_id as string) ?? null,
    locationId: (r.location_id as string) ?? null,
    title: r.title as string,
    detail: (r.detail as Record<string, unknown>) ?? {},
    link: (r.link as string) ?? null,
    sticky: Boolean(r.sticky),
    occurrences: Number(r.occurrences),
    occurredAt: isoOrNull(r.occurred_at),
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    clearedAt: isoOrNull(r.cleared_at),
    resolvedAt: isoOrNull(r.resolved_at),
    resolvedBy: (r.resolved_by as string) ?? null,
    resolvedByName: (r.resolved_by_name as string) ?? null,
    resolution: (r.resolution as AnomalyView["resolution"]) ?? null,
    resolutionNote: (r.resolution_note as string) ?? null,
    reopenedFrom: (r.reopened_from as string) ?? null,
    explanation: (r.explanation as string) ?? null,
  };
}

export type AnomalyFilters = {
  status?: "open" | "resolved" | "all";
  rule?: string[];
  severity?: Severity[];
  itemId?: string;
  jobId?: string;
  shipmentId?: string;
  locationId?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

export async function listAnomalies(f: AnomalyFilters): Promise<{ anomalies: AnomalyView[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: (n: string) => string, value: unknown) => {
    params.push(value);
    where.push(clause(`$${params.length}`));
  };
  const status = f.status ?? "open";
  if (status === "open") where.push("resolved_at IS NULL");
  if (status === "resolved") where.push("resolved_at IS NOT NULL");
  if (f.rule?.length) add((n) => `rule = ANY(${n}::text[])`, f.rule);
  if (f.severity?.length) add((n) => `severity = ANY(${n}::text[])`, f.severity);
  if (f.itemId) add((n) => `item_id = ${n}::uuid`, f.itemId);
  if (f.jobId) add((n) => `job_id = ${n}::uuid`, f.jobId);
  if (f.shipmentId) add((n) => `shipment_id = ${n}::uuid`, f.shipmentId);
  if (f.locationId) add((n) => `location_id = ${n}::uuid`, f.locationId);
  if (f.q) add((n) => `title ILIKE ${n}`, `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Open work is sorted by how bad it is; history by when it ended.
  const order =
    status === "open"
      ? "CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, first_seen_at DESC, id"
      : "coalesce(resolved_at, first_seen_at) DESC, id";
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const [rows, count] = await Promise.all([
    pool.query(`SELECT * FROM ops_anomalies ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params),
    pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ops_anomalies ${whereSql}`, params),
  ]);
  return { anomalies: rows.rows.map(view), total: count.rows[0]?.n ?? 0 };
}

export async function getAnomaly(id: string): Promise<AnomalyView & { history: AnomalyView[] }> {
  const { rows } = await pool.query("SELECT * FROM ops_anomalies WHERE id = $1", [id]);
  if (!rows[0]) throw notFound("That anomaly does not exist.");
  const a = view(rows[0]);
  // Earlier and later rows for the same problem: fixed, then found again.
  const { rows: others } = await pool.query(
    "SELECT * FROM ops_anomalies WHERE rule = $1 AND key = $2 AND id <> $3 ORDER BY first_seen_at DESC LIMIT 20",
    [a.rule, a.key, a.id],
  );
  return { ...a, history: others.map(view) };
}

/**
 * A person closes an anomaly: fixed (the problem was dealt with; if a run
 * still finds it, it opens again) or dismissed (not a problem; it stays quiet
 * while the condition lasts). Either way their name and reason are kept.
 */
export async function resolveAnomaly(
  id: string,
  input: { resolution: "fixed" | "dismissed"; note: string },
  who: { oid: string; name: string },
): Promise<AnomalyView> {
  const { rows } = await pool.query(
    `UPDATE ops_anomalies
        SET resolved_at = now(), resolution = $2, resolution_note = $3,
            resolved_by = $4, resolved_by_name = $5, updated_at = now(),
            -- An event that was dismissed is over; only conditions wait to clear.
            cleared_at = CASE WHEN sticky AND $2 = 'dismissed' THEN now() ELSE NULL END
      WHERE id = $1 AND resolved_at IS NULL
      RETURNING *`,
    [id, input.resolution, input.note.trim(), who.oid, who.name],
  );
  if (!rows[0]) {
    const exists = await pool.query("SELECT resolved_at FROM ops_anomalies WHERE id = $1", [id]);
    if (!exists.rows[0]) throw notFound("That anomaly does not exist.");
    throw conflict("That anomaly is already resolved. Refresh the list.");
  }
  const a = view(rows[0]);
  await publishResolved(a, input.resolution, a.resolutionNote, actorFromOid(who.oid, who.name));
  return a;
}

export type OpsSummary = {
  open: { total: number; bySeverity: Record<Severity, number>; byRule: Record<string, number> };
  oldestOpenAt: string | null;
  trend: { day: string; opened: number; resolved: number }[];
  lastRun: {
    id: string;
    trigger: string;
    startedAt: string;
    finishedAt: string | null;
    opened: number;
    cleared: number;
    error: string | null;
  } | null;
};

/** Counts for the dashboard, and opened against resolved per day for the last `days`. */
export async function summary(days = 30): Promise<OpsSummary> {
  const [bySev, byRule, oldest, trend, run] = await Promise.all([
    pool.query<{ severity: Severity; n: number }>(
      "SELECT severity, count(*)::int AS n FROM ops_anomalies WHERE resolved_at IS NULL GROUP BY severity",
    ),
    pool.query<{ rule: string; n: number }>(
      "SELECT rule, count(*)::int AS n FROM ops_anomalies WHERE resolved_at IS NULL GROUP BY rule",
    ),
    pool.query<{ at: Date | null }>("SELECT min(first_seen_at) AS at FROM ops_anomalies WHERE resolved_at IS NULL"),
    pool.query<{ day: string; opened: number; resolved: number }>(
      `WITH days AS (
         SELECT generate_series(date_trunc('day', now() - make_interval(days => $1::int - 1)),
                                date_trunc('day', now()), interval '1 day') AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM ops_anomalies a
                WHERE a.first_seen_at >= d.day AND a.first_seen_at < d.day + interval '1 day')::int AS opened,
              (SELECT count(*) FROM ops_anomalies a
                WHERE a.resolved_at >= d.day AND a.resolved_at < d.day + interval '1 day')::int AS resolved
         FROM days d ORDER BY d.day`,
      [days],
    ),
    pool.query("SELECT * FROM ops_runs ORDER BY started_at DESC LIMIT 1"),
  ]);
  const bySeverity: Record<Severity, number> = { low: 0, medium: 0, high: 0 };
  for (const r of bySev.rows) bySeverity[r.severity] = r.n;
  const r = run.rows[0];
  return {
    open: {
      total: bySev.rows.reduce((s, x) => s + x.n, 0),
      bySeverity,
      byRule: Object.fromEntries(byRule.rows.map((x) => [x.rule, x.n])),
    },
    oldestOpenAt: oldest.rows[0]?.at ? iso(oldest.rows[0].at) : null,
    trend: trend.rows,
    lastRun: r
      ? {
          id: r.id,
          trigger: r.trigger,
          startedAt: iso(r.started_at),
          finishedAt: isoOrNull(r.finished_at),
          opened: r.opened,
          cleared: r.cleared,
          error: r.error ?? null,
        }
      : null,
  };
}

export const explanationsAvailable = (): boolean => env.llmConfigured;

const EXPLAIN_SYSTEM = [
  "You explain warehouse and logistics anomalies to a supervisor on the floor.",
  "You get the rule that fired, what it checks, and the facts it found.",
  'Reply with one JSON object: {"explanation": "..."}.',
  "The explanation is two to four short, plain sentences: what happened, the most likely cause, and what to check first.",
  "Use only the facts given. Do not invent names, codes, numbers or places. No markdown.",
].join(" ");

/**
 * An optional plain-language explanation from the language model. The rule
 * and its facts are the record; this is a convenience, cached on the row, and
 * absent (available: false) when no model is configured.
 */
export async function explainAnomaly(id: string): Promise<{ available: boolean; explanation: string | null }> {
  const { rows } = await pool.query("SELECT * FROM ops_anomalies WHERE id = $1", [id]);
  if (!rows[0]) throw notFound("That anomaly does not exist.");
  const a = view(rows[0]);
  if (!explanationsAvailable()) return { available: false, explanation: null };
  if (a.explanation) return { available: true, explanation: a.explanation };
  const info = isRuleId(a.rule) ? RULES[a.rule] : null;
  const reply = await chatJson({
    event: "ops.explain",
    system: EXPLAIN_SYSTEM,
    user: JSON.stringify({
      rule: a.rule,
      ruleTitle: info?.title ?? a.rule,
      ruleChecks: info?.description ?? null,
      usualFix: info?.fix ?? null,
      severity: a.severity,
      title: a.title,
      facts: a.detail,
      firstSeenAt: a.firstSeenAt,
      lastSeenAt: a.lastSeenAt,
    }),
    maxTokens: 400,
    context: { anomalyId: a.id, rule: a.rule },
  });
  const raw = reply?.explanation;
  const explanation = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 2000) : null;
  if (explanation) {
    await pool
      .query("UPDATE ops_anomalies SET explanation = $2 WHERE id = $1", [a.id, explanation])
      .catch((err) => logger.warn("ops.explain.store_failed", { err: String(err) }));
  }
  return { available: true, explanation };
}
