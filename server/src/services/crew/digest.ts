import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { appSettings, crewWorkers } from "../../db/schema";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { notify } from "../../lib/notify";
import { getConfig } from "../config";
import { credentialTypesByKey } from "./credentialTypes";
import { asFacts, credentialsForWorkers } from "./credentials";
import { crewEvent } from "./events";
import { localDate, standing } from "./model";

/**
 * The daily digest of credentials that have expired or expire within
 * CREW_EXPIRY_ALERT_DAYS, for active workers and active credential types. It
 * goes out through the configured notifications (Pushover, Wazuh) and as a
 * crew.credentials_expiring event, so a webhook can turn it into an email or a
 * ticket. A credential that has been renewed drops out, because only the
 * deciding credential of each type is looked at.
 */

export type ExpiringCredential = {
  workerId: string;
  workerName: string;
  company: string | null;
  typeKey: string;
  typeName: string;
  expiresOn: string;
  daysLeft: number;
};

export async function expiringCredentials(days: number, today: string): Promise<ExpiringCredential[]> {
  const [workers, types] = await Promise.all([
    db.select().from(crewWorkers).where(eq(crewWorkers.active, true)),
    credentialTypesByKey(),
  ]);
  const activeTypes = new Map([...types].filter(([, t]) => t.active));
  const credentials = await credentialsForWorkers(workers.map((w) => w.id));
  const out: ExpiringCredential[] = [];
  for (const w of workers) {
    const { checks } = standing((credentials.get(w.id) ?? []).map(asFacts), activeTypes, today);
    for (const c of checks) {
      if (c.expiresOn === null || c.daysLeft === null || c.daysLeft > days) continue;
      if (c.reason !== "expiring" && c.reason !== "expired") continue;
      out.push({
        workerId: w.id,
        workerName: w.name,
        company: w.company,
        typeKey: c.typeKey,
        typeName: c.typeName,
        expiresOn: c.expiresOn,
        daysLeft: c.daysLeft,
      });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.workerName.localeCompare(b.workerName));
}

export function describeExpiring(e: ExpiringCredential): string {
  const who = e.company ? `${e.workerName} (${e.company})` : e.workerName;
  const when =
    e.daysLeft < 0
      ? `EXPIRED ${-e.daysLeft}d ago`
      : e.daysLeft === 0
        ? "expires TODAY"
        : `expires in ${e.daysLeft}d`;
  return `${who}: ${e.typeName} ${when} (${e.expiresOn})`;
}

const LAST_SENT_KEY = "crew.expiry_digest.last_sent";
// Pushover caps a message at 1024 characters; say how many more there are.
const MAX_LINES = 25;

/**
 * Claim today's digest for this replica. Every replica runs the timer; the
 * conditional upsert lets exactly one of them send each day.
 */
async function claimDay(day: string): Promise<boolean> {
  const rows = await db
    .insert(appSettings)
    .values({ key: LAST_SENT_KEY, value: day, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: day, updatedAt: new Date() },
      setWhere: sql`${appSettings.value} < ${day}`,
    })
    .returning({ key: appSettings.key });
  return rows.length > 0;
}

export type DigestResult = { count: number; delivered: boolean; skipped: string | null };

/** Build and send the digest. `force` sends even if today's has gone out (the Settings button). */
export async function sendCrewDigest(opts: { force?: boolean; tz?: string } = {}): Promise<DigestResult> {
  const days = env.CREW_EXPIRY_ALERT_DAYS;
  if (days <= 0) return { count: 0, delivered: false, skipped: "CREW_EXPIRY_ALERT_DAYS is 0" };
  if (!(await getConfig()).features.crew) return { count: 0, delivered: false, skipped: "crew check-in is switched off" };
  const today = localDate(new Date(), opts.tz);
  if (!opts.force && !(await claimDay(today))) return { count: 0, delivered: false, skipped: "already sent today" };

  const due = await expiringCredentials(days, today);
  if (!due.length) return { count: 0, delivered: false, skipped: "nothing expiring" };
  const expired = due.filter((d) => d.daysLeft < 0).length;
  const lines = due.slice(0, MAX_LINES).map(describeExpiring);
  if (due.length > MAX_LINES) lines.push(`…and ${due.length - MAX_LINES} more. See Crew → Expiring.`);
  const delivered = await notify({
    title: `${due.length} crew credential${due.length === 1 ? "" : "s"} ${expired ? "expired or " : ""}expiring`,
    message: lines.join("\n"),
    ...(due.some((d) => d.daysLeft <= 7) ? { priority: "high" as const } : {}),
  }).catch((err) => {
    logger.warn("crew.expiry_digest.notify_failed", { err: describeError(err) });
    return false;
  });
  await crewEvent(
    "crew.credentials_expiring",
    {
      days,
      count: due.length,
      expired,
      credentials: due.slice(0, 500).map((d) => ({
        workerId: d.workerId,
        workerName: d.workerName,
        company: d.company,
        type: d.typeKey,
        typeName: d.typeName,
        expiresOn: d.expiresOn,
        daysLeft: d.daysLeft,
      })),
    },
    null,
    null,
  );
  logger.info("crew.expiry_digest.sent", { count: due.length, expired, delivered });
  return { count: due.length, delivered, skipped: null };
}

/**
 * Hourly check that sends the digest once a day, at or after
 * CREW_DIGEST_HOUR_UTC. Checking hourly rather than every 24 hours means a
 * restart does not push the digest to a different time of day.
 */
export function startCrewDigest(): void {
  if (env.CREW_EXPIRY_ALERT_DAYS <= 0) return;
  const tick = () => {
    if (new Date().getUTCHours() < env.CREW_DIGEST_HOUR_UTC) return;
    sendCrewDigest().catch((err) => logger.warn("crew.expiry_digest.failed", { err: describeError(err) }));
  };
  // The first check waits for the server to settle after boot.
  setTimeout(tick, 5 * 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
  logger.info("crew.expiry_digest.enabled", { days: env.CREW_EXPIRY_ALERT_DAYS, hourUtc: env.CREW_DIGEST_HOUR_UTC });
}
