import type { PoolClient } from "pg";
import { pool } from "../../db/client";
import { env } from "../../env";
import { logger } from "../../lib/logger";
import { describeError } from "../../lib/errors";
import { getConfig } from "../config";
import { publishDetected, publishResolved, publishRun, registerOpsEventTypes, type AnomalyEventRow } from "./events";
import {
  gatherIdentities,
  gatherPositions,
  gatherRecords,
  gatherShipmentLines,
  gatherStageLines,
  gatherTransitions,
  loadPlaces,
} from "./gather";
import { RULE_IDS, enabledRules, type OpsSettings, type RuleId } from "./model";
import { reconcile, type ExistingAnomaly, type ReconcileOps } from "./reconcile";
import { PLACEHOLDER_IDENTITIES, RULE_FACTS, runRule, type Facts, type Finding } from "./rules";
import { getSettings } from "./settings";

/**
 * One pass of the anomaly rules: gather facts, run each enabled rule, work
 * out what changed against the table (reconcile.ts), write it in one
 * transaction, then publish events. Runs on a schedule and on demand; an
 * advisory lock keeps two replicas (or a click during a scheduled run) from
 * running at once.
 */

// pg_try_advisory_lock(int, int): 43 for this feature's migration, 1 for "rules".
const LOCK: [number, number] = [43, 1];

// A first run over a large instance can open thousands of anomalies. Each is
// in the table; only this many per run are also published one by one, and the
// run event carries the totals.
const MAX_EVENTS_PER_KIND = 100;
const KEEP_RUNS = 500;

export type RuleRunStat = { found: number; opened: number; cleared: number; ms: number; error?: string };

export type RunResult = {
  runId: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt: string;
  opened: number;
  updated: number;
  cleared: number;
  byRule: Partial<Record<RuleId, RuleRunStat>>;
};

type Gather = (now: Date, settings: OpsSettings) => Promise<Facts[keyof Facts]>;

const GATHER: { [K in keyof Facts]: Gather } = {
  stageLines: gatherStageLines,
  shipmentLines: () => gatherShipmentLines(),
  identities: () => gatherIdentities(PLACEHOLDER_IDENTITIES),
  records: () => gatherRecords(),
  transitions: gatherTransitions,
  positions: gatherPositions,
};

/** Run the rules now. Resolves to null when another run holds the lock. */
export async function runAnomalyRules(opts: {
  trigger: "schedule" | "manual";
  userOid?: string | null;
  now?: Date;
}): Promise<RunResult | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS ok", LOCK);
    locked = rows[0]?.ok === true;
    if (!locked) return null;
    return await runLocked(client, opts);
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1, $2)", LOCK).catch(() => undefined);
    client.release();
  }
}

async function runLocked(
  client: PoolClient,
  opts: { trigger: "schedule" | "manual"; userOid?: string | null; now?: Date },
): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const settings = await getSettings();
  const enabled = enabledRules(settings);
  const disabled = RULE_IDS.filter((r) => !enabled.includes(r));
  const {
    rows: [run],
  } = await client.query<{ id: string }>(
    "INSERT INTO ops_runs (trigger, started_at, user_oid) VALUES ($1, $2, $3) RETURNING id",
    [opts.trigger, now, opts.userOid ?? null],
  );
  const runId = run!.id;
  const byRule: Partial<Record<RuleId, RuleRunStat>> = {};

  try {
    const { places } = await loadPlaces();
    const ctx = { now, places, settings };

    // Each kind of fact is gathered once, however many rules read it. A kind
    // that fails only stops the rules that read it.
    const facts: Partial<Facts> = {};
    const failed = new Map<keyof Facts, string>();
    for (const kind of new Set(enabled.map((r) => RULE_FACTS[r]))) {
      try {
        (facts as Record<string, unknown>)[kind] = await GATHER[kind](now, settings);
      } catch (err) {
        failed.set(kind, describeError(err));
        logger.warn("ops.gather.failed", { kind, err: describeError(err) });
      }
    }

    const findings: Finding[] = [];
    const rulesRun: RuleId[] = [];
    for (const rule of enabled) {
      const started = Date.now();
      const gatherError = failed.get(RULE_FACTS[rule]);
      if (gatherError) {
        byRule[rule] = { found: 0, opened: 0, cleared: 0, ms: 0, error: gatherError };
        continue;
      }
      try {
        const found = runRule(rule, facts, ctx);
        findings.push(...found);
        rulesRun.push(rule);
        byRule[rule] = { found: found.length, opened: 0, cleared: 0, ms: Date.now() - started };
      } catch (err) {
        byRule[rule] = { found: 0, opened: 0, cleared: 0, ms: Date.now() - started, error: describeError(err) };
        logger.warn("ops.rule.failed", { rule, err: describeError(err) });
      }
    }

    const existing = await loadExisting(client, findings);
    const ops = reconcile({ findings, existing, rulesRun, rulesDisabled: disabled });
    const applied = await apply(client, ops, now);

    for (const row of applied.opened) {
      const stat = byRule[row.rule as RuleId];
      if (stat) stat.opened += 1;
    }
    for (const row of applied.cleared) {
      const stat = byRule[row.rule as RuleId];
      if (stat) stat.cleared += 1;
    }
    const finishedAt = new Date();
    const errors = Object.entries(byRule)
      .filter(([, s]) => s?.error)
      .map(([r]) => r);
    await client.query(
      `UPDATE ops_runs SET finished_at = $2, opened = $3, updated = $4, cleared = $5, by_rule = $6::jsonb, error = $7
        WHERE id = $1`,
      [
        runId,
        finishedAt,
        applied.opened.length,
        applied.refreshed,
        applied.cleared.length,
        JSON.stringify(byRule),
        errors.length ? `Rules that failed: ${errors.join(", ")}` : null,
      ],
    );

    const result: RunResult = {
      runId,
      trigger: opts.trigger,
      startedAt: now.toISOString(),
      finishedAt: finishedAt.toISOString(),
      opened: applied.opened.length,
      updated: applied.refreshed,
      cleared: applied.cleared.length,
      byRule,
    };
    logger.info("ops.run.done", {
      runId,
      trigger: opts.trigger,
      opened: result.opened,
      cleared: result.cleared,
      updated: result.updated,
      ms: finishedAt.getTime() - now.getTime(),
    });

    // After commit, as publish() asks.
    for (const row of applied.opened.slice(0, MAX_EVENTS_PER_KIND)) await publishDetected(row);
    for (const row of applied.cleared.slice(0, MAX_EVENTS_PER_KIND)) {
      await publishResolved(row, "cleared", row.note, null);
    }
    if (applied.opened.length || applied.cleared.length) {
      await publishRun(runId, {
        trigger: opts.trigger,
        opened: result.opened,
        cleared: result.cleared,
        truncated: applied.opened.length > MAX_EVENTS_PER_KIND || applied.cleared.length > MAX_EVENTS_PER_KIND,
        byRule,
      });
    }

    await housekeeping();
    return result;
  } catch (err) {
    await pool
      .query("UPDATE ops_runs SET finished_at = now(), error = $2, by_rule = $3::jsonb WHERE id = $1", [
        runId,
        describeError(err).slice(0, 2000),
        JSON.stringify(byRule),
      ])
      .catch(() => undefined);
    throw err;
  }
}

/**
 * The rows reconcile needs: every open row, every dismissed row whose
 * condition has not yet gone away, and the latest row of each problem found
 * this time.
 */
async function loadExisting(client: PoolClient, findings: Finding[]): Promise<ExistingAnomaly[]> {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (rule, key) id, rule, key, sticky, occurrences, occurred_at, resolved_at, resolution, cleared_at
       FROM ops_anomalies
      WHERE resolved_at IS NULL
         OR (resolution = 'dismissed' AND cleared_at IS NULL)
         OR (rule, key) IN (SELECT r, k FROM unnest($1::text[], $2::text[]) AS f(r, k))
      ORDER BY rule, key, (resolved_at IS NULL) DESC, first_seen_at DESC, created_at DESC`,
    [findings.map((f) => f.rule), findings.map((f) => f.key)],
  );
  return rows.map((r) => ({
    id: r.id,
    rule: r.rule,
    key: r.key,
    sticky: r.sticky,
    occurrences: r.occurrences,
    occurredAt: r.occurred_at ? new Date(r.occurred_at) : null,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
    resolution: r.resolution,
    clearedAt: r.cleared_at ? new Date(r.cleared_at) : null,
  }));
}

/** Columns an event needs, as `returning("a.")` inside a statement that joins another row source. */
const returning = (p = "") =>
  `${p}id, ${p}rule, ${p}key, ${p}severity, ${p}title, ${p}subject_type AS "subjectType",
   ${p}subject_id AS "subjectId", ${p}item_id AS "itemId", ${p}job_id AS "jobId",
   ${p}shipment_id AS "shipmentId", ${p}location_id AS "locationId", ${p}link`;

const FINDING_COLUMNS = `rule text, key text, severity text, subject_type text, subject_id text, item_id uuid,
  unit_id uuid, job_id uuid, shipment_id uuid, location_id uuid, title text, detail jsonb, link text,
  sticky boolean, occurred_at timestamptz`;

const findingRecord = (f: Finding) => ({
  rule: f.rule,
  key: f.key,
  severity: f.severity,
  subject_type: f.subjectType,
  subject_id: f.subjectId,
  item_id: f.itemId,
  unit_id: f.unitId,
  job_id: f.jobId,
  shipment_id: f.shipmentId,
  location_id: f.locationId,
  title: f.title,
  detail: f.detail,
  link: f.link,
  sticky: f.sticky,
  occurred_at: f.occurredAt,
});

const CLEAR_NOTE = {
  not_found: "No longer found by a run.",
  rule_disabled: "The rule was switched off.",
} as const;

type Applied = {
  opened: (AnomalyEventRow & { reopenedFrom: string | null })[];
  refreshed: number;
  cleared: (AnomalyEventRow & { note: string })[];
};

async function apply(client: PoolClient, ops: ReconcileOps, now: Date): Promise<Applied> {
  await client.query("BEGIN");
  try {
    const opened = ops.insert.length
      ? (
          await client.query(
            `INSERT INTO ops_anomalies (rule, key, severity, subject_type, subject_id, item_id, unit_id, job_id,
                                        shipment_id, location_id, title, detail, link, sticky, occurred_at,
                                        first_seen_at, last_seen_at, reopened_from)
             SELECT x.rule, x.key, x.severity, x.subject_type, x.subject_id, x.item_id, x.unit_id, x.job_id,
                    x.shipment_id, x.location_id, x.title, coalesce(x.detail, '{}'::jsonb), x.link, x.sticky,
                    x.occurred_at, $2, $2, x.reopened_from
               FROM jsonb_to_recordset($1::jsonb) AS x(${FINDING_COLUMNS}, reopened_from uuid)
             ON CONFLICT (rule, key) WHERE resolved_at IS NULL DO NOTHING
             RETURNING ${returning()}, reopened_from AS "reopenedFrom"`,
            [
              JSON.stringify(ops.insert.map((i) => ({ ...findingRecord(i.finding), reopened_from: i.reopenedFrom }))),
              now,
            ],
          )
        ).rows
      : [];

    let refreshed = 0;
    if (ops.refresh.length) {
      const res = await client.query(
        `UPDATE ops_anomalies a
            SET severity = x.severity, title = x.title, detail = coalesce(x.detail, '{}'::jsonb), link = x.link,
                subject_type = x.subject_type, subject_id = x.subject_id, item_id = x.item_id, unit_id = x.unit_id,
                job_id = x.job_id, shipment_id = x.shipment_id, location_id = x.location_id,
                occurrences = x.occurrences, occurred_at = x.occurred_at, last_seen_at = $2, updated_at = now()
           FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, occurrences integer, ${FINDING_COLUMNS})
          WHERE a.id = x.id AND a.resolved_at IS NULL`,
        [
          JSON.stringify(
            ops.refresh.map((r) => ({
              ...findingRecord(r.finding),
              id: r.id,
              occurrences: r.occurrences,
              occurred_at: r.occurredAt,
            })),
          ),
          now,
        ],
      );
      refreshed = res.rowCount ?? 0;
    }

    if (ops.touch.length) {
      await client.query("UPDATE ops_anomalies SET last_seen_at = $2 WHERE id = ANY($1::uuid[])", [ops.touch, now]);
    }

    const cleared = ops.clear.length
      ? (
          await client.query(
            `UPDATE ops_anomalies a
                SET resolved_at = $2, resolution = 'cleared', resolution_note = x.note,
                    resolved_by = NULL, resolved_by_name = NULL, updated_at = now()
               FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, note text)
              WHERE a.id = x.id AND a.resolved_at IS NULL
              RETURNING ${returning("a.")}, x.note`,
            [JSON.stringify(ops.clear.map((c) => ({ id: c.id, note: CLEAR_NOTE[c.reason] }))), now],
          )
        ).rows
      : [];

    if (ops.markCleared.length) {
      await client.query(
        `UPDATE ops_anomalies SET cleared_at = $2, updated_at = now()
          WHERE id = ANY($1::uuid[]) AND resolution = 'dismissed' AND cleared_at IS NULL`,
        [ops.markCleared, now],
      );
    }
    await client.query("COMMIT");
    return { opened, refreshed, cleared };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function housekeeping(): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM ops_runs WHERE id IN (SELECT id FROM ops_runs ORDER BY started_at DESC OFFSET ${KEEP_RUNS})`,
    );
    // Profiles have no foreign key (see the migration); drop those whose place is gone.
    await pool.query(
      "DELETE FROM ops_location_profiles p WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = p.location_id)",
    );
  } catch (err) {
    logger.warn("ops.housekeeping.failed", { err: describeError(err) });
  }
}

let started = false;

/**
 * Run the rules every OPS_INTEL_INTERVAL_MIN minutes while the feature is on.
 * Safe in every replica: whichever takes the lock runs, the others skip.
 */
export function startOpsIntel(): void {
  registerOpsEventTypes();
  if (started) return;
  started = true;
  const minutes = env.OPS_INTEL_INTERVAL_MIN;
  if (minutes <= 0) {
    logger.info("ops.schedule.disabled", {});
    return;
  }
  const tick = async () => {
    try {
      if (!(await getConfig()).features.opsIntel) return;
      const result = await runAnomalyRules({ trigger: "schedule" });
      if (!result) logger.info("ops.run.skipped", { reason: "another run holds the lock" });
    } catch (err) {
      logger.warn("ops.run.failed", { err: describeError(err) });
    }
  };
  // The first run waits for the server to settle after boot.
  setTimeout(() => void tick(), 90_000).unref();
  setInterval(() => void tick(), minutes * 60_000).unref();
  logger.info("ops.schedule.enabled", { intervalMinutes: minutes });
}
