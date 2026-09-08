import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { items, itemIdentifiers } from "../../db/schema";
import { env } from "../../env";
import { logger } from "../../lib/logger";
import { notify } from "../../lib/notify";

const DAY_MS = 86_400_000;

function describeDue(name: string, expiresAt: Date, registrar: unknown): string {
  const days = Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS);
  const when = days < 0 ? `EXPIRED ${-days}d ago` : days === 0 ? "expires TODAY" : `expires in ${days}d`;
  return `${name}: ${when} (${registrar ?? "manual"}, auto-renew off)`;
}

/**
 * Pushover and Wazuh digest of domains expiring within DOMAIN_EXPIRY_ALERT_DAYS whose
 * auto-renew is off, which is the lapse-by-accident case. Auto-renewing domains
 * are excluded; the registrar will handle those.
 */
export async function sendExpiryDigest(): Promise<{ alerted: number }> {
  if (env.DOMAIN_EXPIRY_ALERT_DAYS <= 0) return { alerted: 0 };

  const cutoff = new Date(Date.now() + env.DOMAIN_EXPIRY_ALERT_DAYS * DAY_MS);
  const rows = await db
    .select({ name: itemIdentifiers.value, expiresAt: items.expiresAt, metadata: items.metadata })
    .from(items)
    .innerJoin(itemIdentifiers, eq(itemIdentifiers.itemId, items.id))
    .where(
      and(
        eq(itemIdentifiers.type, "domain"),
        isNotNull(items.expiresAt),
        lte(items.expiresAt, cutoff),
        eq(items.flaggedMissing, false),
        eq(items.status, "active"),
      ),
    );

  const due = rows
    .filter((r) => r.metadata.autoRenew !== true)
    .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime());
  if (!due.length) return { alerted: 0 };

  const hasUrgent = due[0]!.expiresAt!.getTime() - Date.now() <= 7 * DAY_MS;
  const delivered = await notify({
    title: `${due.length} domain${due.length === 1 ? "" : "s"} need renewal`,
    message: due.map((r) => describeDue(r.name, r.expiresAt!, r.metadata.registrar)).join("\n"),
    ...(hasUrgent ? { priority: "high" } : {}),
  });
  if (!delivered) return { alerted: 0 };
  logger.info("registrars.expiry_digest.sent", { count: due.length, urgent: hasUrgent });
  return { alerted: due.length };
}
