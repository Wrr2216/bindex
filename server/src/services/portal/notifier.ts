import type { PoolClient } from "pg";
import { pool } from "../../db/client";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { publish } from "../event-backbone";
import { mailAvailable, sendMail } from "./mailer";
import {
  NOTIFY_TYPE_LIKE,
  composeMilestoneEmail,
  dueToSend,
  noticeFromEvent,
  type MilestoneNotice,
  type NotifyEvent,
} from "./milestones";
import { portalActor } from "./policy";

/**
 * Milestone emails. The event bus is the audit log, so this listens by
 * reading it: every 30 seconds it takes the events after its cursor whose type
 * matters (shipment status, job completion, and any `geofence.*` the GPS
 * feature publishes, installed or not), turns each into a milestone for the
 * grants that follow it, and emails each person what is waiting for them at
 * most once per PORTAL_NOTIFY_INTERVAL_MIN.
 *
 * - De-duplicated: one row per grant and milestone key, so a shipment that
 *   goes back to loaded and out again does not email twice.
 * - Throttled: milestones inside a person's interval wait and go out together.
 * - Safe with several replicas: the cursor row is locked while read, and each
 *   grant's pending rows are locked while sent.
 * - Nothing older than a day is sent, so switching email on after a long time
 *   does not unleash a backlog.
 */

const POLL_MS = 30_000;
const BATCH = 500;
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_ATTEMPTS = 5;

type EventRow = {
  id: string;
  type: string;
  occurred_at: Date;
  subject_type: string | null;
  subject_id: string | null;
  data: Record<string, unknown>;
};

type GrantRow = { id: string; grantee_name: string; grantee_org: string | null };

async function followers(client: PoolClient, n: MilestoneNotice): Promise<GrantRow[]> {
  let { shipmentId, jobId } = n;
  if (!shipmentId && !jobId && n.itemId) {
    // A tracker on one item: the open job line it is on says which delivery it is.
    const { rows } = await client.query<{ job_id: string; shipment_id: string | null }>(
      `SELECT ji.job_id, ji.shipment_id FROM job_items ji JOIN jobs j ON j.id = ji.job_id
        WHERE ji.item_id = $1 AND j.status IN ('planned', 'in_progress')
        ORDER BY ji.updated_at DESC LIMIT 1`,
      [n.itemId],
    );
    shipmentId = rows[0]?.shipment_id ?? null;
    jobId = rows[0]?.job_id ?? null;
  }
  if (shipmentId && !jobId) {
    const { rows } = await client.query<{ job_id: string }>("SELECT job_id FROM shipments WHERE id = $1", [shipmentId]);
    jobId = rows[0]?.job_id ?? null;
  }
  if (!shipmentId && !jobId) return [];
  const { rows } = await client.query<GrantRow>(
    `SELECT g.id, g.grantee_name, g.grantee_org FROM portal_grants g
      WHERE g.notify AND g.grantee_email IS NOT NULL AND g.revoked_at IS NULL
        AND g.token_hash IS NOT NULL AND g.expires_at > now()
        AND (($1::uuid IS NOT NULL AND g.shipment_id = $1::uuid)
          OR ($2::uuid IS NOT NULL AND g.job_id = $2::uuid)
          OR ($2::uuid IS NOT NULL AND g.project_id = (SELECT project_id FROM jobs WHERE id = $2::uuid)))`,
    [shipmentId, jobId],
  );
  return rows;
}

/** Read new events into pending notifications. Returns how many events were read. */
async function collect(now: Date): Promise<{ read: number; queued: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const state = await client.query<{ last_event_id: string }>(
      "SELECT last_event_id FROM portal_notifier_state WHERE id = 1 FOR UPDATE SKIP LOCKED",
    );
    if (!state.rows[0]) {
      // Either another replica holds the row, or this is the first run. On the
      // first run, start from now: nobody is emailed about the past.
      await client.query(
        `INSERT INTO portal_notifier_state (id, last_event_id)
         SELECT 1, COALESCE(max(id), 0) FROM audit_log ON CONFLICT (id) DO NOTHING`,
      );
      await client.query("COMMIT");
      return { read: 0, queued: 0 };
    }
    const after = Number(state.rows[0].last_event_id);
    const { rows } = await client.query<EventRow>(
      `SELECT id, type, occurred_at, subject_type, subject_id, data FROM audit_log
        WHERE id > $1 AND type LIKE ANY($2::text[]) ORDER BY id LIMIT $3`,
      [after, NOTIFY_TYPE_LIKE, BATCH],
    );
    let queued = 0;
    for (const r of rows) {
      if (now.getTime() - r.occurred_at.getTime() > MAX_AGE_MS) continue;
      const ev: NotifyEvent = {
        id: Number(r.id),
        type: r.type,
        occurredAt: r.occurred_at,
        subject: r.subject_type && r.subject_id ? { type: r.subject_type, id: r.subject_id } : null,
        data: r.data ?? {},
      };
      const notice = noticeFromEvent(ev);
      if (!notice) continue;
      for (const g of await followers(client, notice)) {
        const res = await client.query(
          `INSERT INTO portal_notifications (grant_id, milestone_key, title, event_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (grant_id, milestone_key) DO NOTHING`,
          [g.id, notice.key, notice.title.slice(0, 300), ev.id, ev.occurredAt],
        );
        queued += res.rowCount ?? 0;
      }
    }
    if (rows.length) {
      await client.query("UPDATE portal_notifier_state SET last_event_id = $1, updated_at = now() WHERE id = 1", [
        rows[rows.length - 1]!.id,
      ]);
    }
    await client.query("COMMIT");
    return { read: rows.length, queued };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

type Due = {
  grant_id: string;
  grantee_name: string;
  grantee_org: string | null;
  grantee_email: string | null;
  scope: string;
  active: boolean;
  label: string | null;
  last_sent: Date | null;
};

/** Email each person whose throttle window has passed everything waiting for them. */
async function deliver(now: Date): Promise<number> {
  const { rows } = await pool.query<Due>(
    `SELECT g.id AS grant_id, g.grantee_name, g.grantee_org, g.grantee_email, g.scope,
            (g.notify AND g.grantee_email IS NOT NULL AND g.revoked_at IS NULL
              AND g.token_hash IS NOT NULL AND g.expires_at > now()) AS active,
            COALESCE(
              (SELECT p.name || ' (' || p.code || ')' FROM projects p WHERE p.id = g.project_id),
              (SELECT j.name || ' (' || j.code || ')' FROM jobs j WHERE j.id = g.job_id),
              (SELECT s.name || ' (' || s.code || ')' FROM shipments s WHERE s.id = g.shipment_id)) AS label,
            (SELECT max(sent_at) FROM portal_notifications s WHERE s.grant_id = g.id AND s.status = 'sent') AS last_sent
       FROM portal_grants g
      WHERE EXISTS (SELECT 1 FROM portal_notifications n WHERE n.grant_id = g.id AND n.status = 'pending')`,
  );
  if (!rows.length) return 0;
  const config = await getConfig();
  let sent = 0;
  for (const g of rows) {
    if (!g.active) {
      // Revoked, expired or switched off since it was queued: never send.
      await pool.query(
        "UPDATE portal_notifications SET status = 'skipped' WHERE grant_id = $1 AND status = 'pending'",
        [g.grant_id],
      );
      continue;
    }
    if (!dueToSend(g.last_sent, now, env.PORTAL_NOTIFY_INTERVAL_MIN)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const pending = await client.query<{ id: string; title: string; occurred_at: Date; attempts: number }>(
        `SELECT id, title, occurred_at, attempts FROM portal_notifications
          WHERE grant_id = $1 AND status = 'pending' ORDER BY occurred_at FOR UPDATE SKIP LOCKED`,
        [g.grant_id],
      );
      if (!pending.rows.length) {
        await client.query("COMMIT");
        continue;
      }
      const ids = pending.rows.map((p) => p.id);
      const mail = composeMilestoneEmail({
        appName: config.appName,
        orgName: config.orgName,
        granteeName: g.grantee_name,
        scopeLabel: g.label ?? "your delivery",
        milestones: pending.rows.map((p) => ({ title: p.title, occurredAt: p.occurred_at })),
      });
      const ok = await sendMail({ to: g.grantee_email!, ...mail }, config.appName, "portal.notify_mail");
      if (ok) {
        await client.query(
          "UPDATE portal_notifications SET status = 'sent', sent_at = $2, attempts = attempts + 1 WHERE id = ANY($1::uuid[])",
          [ids, now],
        );
        sent += 1;
      } else {
        await client.query(
          `UPDATE portal_notifications
              SET attempts = attempts + 1,
                  status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
                  error = 'The mail server did not accept the message.'
            WHERE id = ANY($1::uuid[])`,
          [ids, MAX_ATTEMPTS],
        );
      }
      await client.query("COMMIT");
      if (ok) {
        await publish(
          "portal.notification_sent",
          { milestones: pending.rows.map((p) => p.title), count: ids.length },
          {
            actor: portalActor({ id: g.grant_id, granteeName: g.grantee_name, granteeOrg: g.grantee_org }),
            subject: { type: "portal_grant", id: g.grant_id },
          },
        );
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.warn("portal.notify.failed", { grantId: g.grant_id, err: describeError(err) });
    } finally {
      client.release();
    }
  }
  return sent;
}

/** Codes and passes past their time, which no request can use any more. */
async function sweep(): Promise<void> {
  await pool.query("DELETE FROM portal_codes WHERE expires_at < now()");
  await pool.query("DELETE FROM portal_passes WHERE expires_at < now() - interval '1 day'");
}

/** One pass: collect new milestones, then send what is due. Exported for tests. */
export async function runNotifierOnce(now: Date = new Date()): Promise<{ read: number; queued: number; sent: number }> {
  if (!(await getConfig()).features.portal || !mailAvailable()) return { read: 0, queued: 0, sent: 0 };
  let read = 0;
  let queued = 0;
  // Catch up in batches, but within one tick.
  for (let i = 0; i < 20; i++) {
    const r = await collect(now);
    read += r.read;
    queued += r.queued;
    if (r.read < BATCH) break;
  }
  const sent = await deliver(now);
  return { read, queued, sent };
}

let started = false;

export function startPortalNotifier(pollMs = POLL_MS): void {
  if (started) return;
  started = true;
  let running = false;
  let lastSweep = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runNotifierOnce();
      if (r.queued || r.sent) logger.info("portal.notify.tick", r);
      if (Date.now() - lastSweep > 60 * 60_000) {
        lastSweep = Date.now();
        await sweep();
      }
    } catch (err) {
      logger.warn("portal.notify.tick_failed", { err: describeError(err) });
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 20_000).unref();
  setInterval(() => void tick(), pollMs).unref();
  logger.info("portal.notifier.started", { mail: mailAvailable() });
}
