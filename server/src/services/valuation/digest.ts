import type { PoolClient } from "pg";
import { pool } from "../../db/client";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { notify } from "../../lib/notify";
import { getConfig } from "../config";
import { SYSTEM_ACTOR, publish } from "../event-backbone";
import { daysBetween, today } from "./parse";
import { serviceStatus, type ServicePlanLike, type ServiceStatus } from "./schedule";
import { getValuationSettings, type ValuationSettings } from "./settings";

/**
 * The daily reminder: warranties about to end and service falling due. Each
 * warranty end date and each service due point is announced once, as an event
 * (for webhooks) and in the notification digest (Pushover, Wazuh); the Due
 * list on the Valuation screen shows everything open whether or not it has
 * been announced.
 */

export type WarrantyDue = {
  kind: "warranty";
  itemId: string;
  unitId: string | null;
  name: string;
  warrantyEnds: string;
  daysLeft: number;
  provider: string | null;
  /** Not announced yet. */
  isNew: boolean;
};

export type ServiceDue = {
  kind: "service";
  itemId: string;
  unitId: string | null;
  name: string;
  planId: string;
  planName: string;
  status: ServiceStatus;
  isNew: boolean;
};

export type DueList = { warranty: WarrantyDue[]; service: ServiceDue[] };

export type WarrantyRow = {
  itemId: string;
  unitId: string | null;
  name: string;
  warrantyEnds: string;
  warrantyProvider: string | null;
  warrantyAlertedFor: string | null;
};

export type PlanRow = ServicePlanLike & {
  id: string;
  itemId: string;
  unitId: string | null;
  name: string;
  planName: string;
  alertedFor: string | null;
  usageHours: number | null;
};

/** What is due, from rows already loaded. Pure, so the windows and the once-only rule are tested directly. */
export function selectDue(warranties: WarrantyRow[], plans: PlanRow[], settings: ValuationSettings, now = new Date()): DueList {
  const day = today(now);
  const warranty = warranties
    .map((w) => ({ w, daysLeft: daysBetween(day, w.warrantyEnds) }))
    .filter(({ daysLeft }) => daysLeft >= 0 && daysLeft <= settings.warrantyAlertDays)
    .map(({ w, daysLeft }): WarrantyDue => ({
      kind: "warranty",
      itemId: w.itemId,
      unitId: w.unitId,
      name: w.name,
      warrantyEnds: w.warrantyEnds,
      daysLeft,
      provider: w.warrantyProvider,
      isNew: w.warrantyAlertedFor !== w.warrantyEnds,
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));

  const service = plans
    .map((p): ServiceDue => {
      const status = serviceStatus(p, p.usageHours, { now, soonDays: settings.serviceSoonDays, soonPercent: settings.serviceSoonPercent });
      return { kind: "service", itemId: p.itemId, unitId: p.unitId, name: p.name, planId: p.id, planName: p.planName, status, isNew: p.alertedFor !== status.dueKey };
    })
    .filter((s) => s.status.state === "soon" || s.status.state === "overdue")
    .sort((a, b) => (a.status.state === b.status.state ? 0 : a.status.state === "overdue" ? -1 : 1) || a.name.localeCompare(b.name));
  return { warranty, service };
}

const NAME = `CASE WHEN u.id IS NULL THEN i.name ELSE i.name || ' (' || coalesce(u.label, u.serial, u.asset_code) || ')' END`;

async function loadRows(executor: Pick<PoolClient, "query">, alertDays: number): Promise<{ warranties: WarrantyRow[]; plans: PlanRow[] }> {
  const [w, p] = await Promise.all([
    executor.query<WarrantyRow>(
      `SELECT p.item_id AS "itemId", p.unit_id AS "unitId", ${NAME} AS name,
              p.warranty_ends::text AS "warrantyEnds", p.warranty_provider AS "warrantyProvider",
              p.warranty_alerted_for::text AS "warrantyAlertedFor"
         FROM valuation_profiles p
         JOIN items i ON i.id = p.item_id
         LEFT JOIN item_units u ON u.id = p.unit_id
        WHERE p.warranty_ends IS NOT NULL
          AND p.warranty_ends BETWEEN current_date - 1 AND current_date + $1::int + 1`,
      [alertDays],
    ),
    executor.query<PlanRow>(
      `SELECT s.id, s.item_id AS "itemId", s.unit_id AS "unitId", ${NAME} AS name, s.name AS "planName",
              s.interval_days AS "intervalDays", s.interval_hours::float8 AS "intervalHours",
              s.starts_at AS "startsAt", s.starts_hours::float8 AS "startsHours",
              s.last_done_at AS "lastDoneAt", s.last_done_hours::float8 AS "lastDoneHours",
              s.active, s.alerted_for AS "alertedFor", pr.usage_hours::float8 AS "usageHours"
         FROM service_plans s
         JOIN items i ON i.id = s.item_id
         LEFT JOIN item_units u ON u.id = s.unit_id
         LEFT JOIN valuation_profiles pr ON pr.item_id = s.item_id AND pr.unit_id IS NOT DISTINCT FROM s.unit_id
        WHERE s.active`,
    ),
  ]);
  return { warranties: w.rows, plans: p.rows };
}

/** Everything open now, announced or not, for the Due list. */
export async function listDue(now = new Date()): Promise<DueList> {
  const settings = await getValuationSettings();
  const { warranties, plans } = await loadRows(pool, settings.warrantyAlertDays);
  return selectDue(warranties, plans, settings, now);
}

const describeService = (s: ServiceDue) => {
  const st = s.status;
  const when =
    st.reason === "hours" && st.hoursLeft !== null
      ? st.hoursLeft <= 0
        ? `${-st.hoursLeft} h overdue`
        : `due in ${st.hoursLeft} h of use`
      : st.daysLeft !== null
        ? st.daysLeft < 0
          ? `${-st.daysLeft}d overdue`
          : st.daysLeft === 0
            ? "due today"
            : `due in ${st.daysLeft}d`
        : "due";
  return `${s.name}: ${s.planName} ${when}`;
};

// Any fixed number; it only has to be the same in every replica.
const DIGEST_LOCK = 0x7419_0001;

/**
 * Announce what has newly fallen due. Safe to run from every replica and as
 * often as wanted: a transaction-level advisory lock lets one run at a time,
 * and each announcement is marked in the same transaction, so nothing is sent
 * twice.
 */
export async function runDigest(now = new Date()): Promise<{ announced: number; notified: boolean; skipped?: "locked" }> {
  const settings = await getValuationSettings();
  const client = await pool.connect();
  let fresh: DueList;
  let open: DueList;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [DIGEST_LOCK]);
    if (!rows[0]?.ok) {
      await client.query("ROLLBACK");
      return { announced: 0, notified: false, skipped: "locked" };
    }
    const loaded = await loadRows(client, settings.warrantyAlertDays);
    open = selectDue(loaded.warranties, loaded.plans, settings, now);
    fresh = { warranty: open.warranty.filter((w) => w.isNew), service: open.service.filter((s) => s.isNew) };
    for (const w of fresh.warranty) {
      await client.query(
        `UPDATE valuation_profiles SET warranty_alerted_for = warranty_ends
          WHERE item_id = $1 AND unit_id IS NOT DISTINCT FROM $2`,
        [w.itemId, w.unitId],
      );
    }
    for (const s of fresh.service) {
      await client.query(`UPDATE service_plans SET alerted_for = $2 WHERE id = $1`, [s.planId, s.status.dueKey]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  for (const w of fresh.warranty) {
    await publish(
      "warranty.expiring",
      { itemId: w.itemId, unitId: w.unitId, name: w.name, warrantyEnds: w.warrantyEnds, daysLeft: w.daysLeft, provider: w.provider },
      { actor: SYSTEM_ACTOR, subject: { type: "item", id: w.itemId } },
    );
  }
  for (const s of fresh.service) {
    await publish(
      "service.due",
      {
        itemId: s.itemId,
        unitId: s.unitId,
        name: s.name,
        planId: s.planId,
        planName: s.planName,
        state: s.status.state,
        dueAt: s.status.dueAt?.toISOString() ?? null,
        dueHours: s.status.dueHours,
        daysLeft: s.status.daysLeft,
        hoursLeft: s.status.hoursLeft,
      },
      { actor: SYSTEM_ACTOR, subject: { type: "item", id: s.itemId } },
    );
  }

  const announced = fresh.warranty.length + fresh.service.length;
  let notified = false;
  if (announced && settings.notify) {
    const lines = [
      ...fresh.service.map(describeService),
      ...fresh.warranty.map((w) => `${w.name}: warranty ends ${w.daysLeft === 0 ? "today" : `in ${w.daysLeft}d`} (${w.warrantyEnds})`),
    ];
    const still = open.warranty.length + open.service.length - announced;
    if (still > 0) lines.push(`${still} more still open; see Valuation → Due.`);
    const overdue = fresh.service.some((s) => s.status.state === "overdue");
    try {
      notified = await notify({
        title: `${announced} warranty and service reminder${announced === 1 ? "" : "s"}`,
        message: lines.join("\n"),
        ...(overdue ? { priority: "high" as const } : {}),
      });
    } catch (err) {
      logger.warn("valuation.digest.notify_failed", { err: describeError(err) });
    }
  }
  if (announced) logger.info("valuation.digest.sent", { warranty: fresh.warranty.length, service: fresh.service.length, notified });
  return { announced, notified };
}

const HOUR = 60 * 60_000;

/**
 * Check for newly due warranty and service once an hour (the first check a
 * few minutes after boot). Each item is announced once, so this is a daily
 * digest in effect: a warranty enters the window on one day and is announced
 * on the first check that day.
 */
export function startValuationDigest(): void {
  const run = () =>
    getConfig()
      // Switched off, the feature announces nothing; what fell due meanwhile is announced when it is back on.
      .then((config) => (config.features.valuation ? runDigest() : null))
      .catch((err) => logger.warn("valuation.digest.failed", { err: describeError(err) }));
  setTimeout(run, 5 * 60_000).unref();
  setInterval(run, HOUR).unref();
  logger.info("valuation.digest.enabled", {});
}
