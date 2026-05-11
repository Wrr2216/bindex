import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { items, itemIdentifiers, syncRuns } from "../../db/schema";
import { env } from "../../env";
import { logger } from "../../lib/logger";
import { recordEvent } from "../items";
import { badRequest } from "../../lib/errors";
import { getCloudflareDomains, getZones } from "./cloudflare";
import { getPorkbunDomains } from "./porkbun";
import type { DnsZone, RegistrarDomain } from "./types";

export type RegistrarSyncSummary = {
  runId: string;
  created: number;
  updated: number;
  flaggedMissing: number;
  total: number;
};

type DomainItem = { id: string; metadata: Record<string, unknown>; flaggedMissing: boolean };

/** All items that carry a `domain` identifier, keyed by FQDN. */
async function loadDomainItems(): Promise<Map<string, DomainItem>> {
  const rows = await db
    .select({
      id: items.id,
      metadata: items.metadata,
      flaggedMissing: items.flaggedMissing,
      domain: itemIdentifiers.value,
    })
    .from(items)
    .innerJoin(itemIdentifiers, eq(itemIdentifiers.itemId, items.id))
    .where(eq(itemIdentifiers.type, "domain"));
  return new Map(rows.map((r) => [r.domain.toLowerCase(), r]));
}

async function upsertDomain(
  d: RegistrarDomain,
  zone: DnsZone | undefined,
  match: DomainItem | undefined,
  userOid: string | null,
): Promise<"created" | "updated"> {
  const now = new Date();
  const domainMeta = {
    registrar: d.registrar,
    registrarStatus: d.status,
    autoRenew: d.autoRenew,
    whoisPrivacy: d.whoisPrivacy,
    dnsProvider: zone ? "cloudflare" : null,
    nameservers: zone?.nameservers ?? null,
    registrarSyncedAt: now.toISOString(),
  };

  if (match) {
    await db
      .update(items)
      .set({
        expiresAt: d.expiresAt,
        metadata: { ...match.metadata, ...domainMeta },
        flaggedMissing: false,
        updatedAt: now,
      })
      .where(eq(items.id, match.id));
    return "updated";
  }

  const [item] = await db
    .insert(items)
    .values({
      name: d.name,
      category: "Domain",
      enrichmentSource: "registrar",
      expiresAt: d.expiresAt,
      metadata: domainMeta,
      createdBy: userOid,
    })
    .returning();
  await db
    .insert(itemIdentifiers)
    .values({ itemId: item!.id, type: "domain", value: d.name })
    .onConflictDoNothing();
  await recordEvent(item!.id, userOid, "created", { source: "registrar", registrar: d.registrar });
  return "created";
}

/**
 * Pull domains from Cloudflare Registrar and Porkbun into inventory items
 * (category "Domain", identifier type `domain`). Cloudflare zones are used to
 * record where DNS lives. Domain items that vanish from their registrar are
 * flagged possibly-missing (transferred or lapsed).
 */
export async function runRegistrarSync(userOid: string | null): Promise<RegistrarSyncSummary> {
  if (!env.registrarsConfigured) {
    throw badRequest(
      "No domain registrar is configured (set CLOUDFLARE_API_TOKEN and/or PORKBUN_API_KEY + PORKBUN_SECRET_KEY).",
    );
  }

  const [run] = await db.insert(syncRuns).values({ source: "registrars" }).returning();
  let created = 0;
  let updated = 0;
  let flagged = 0;

  try {
    const [cfDomains, cfZones, pbDomains] = await Promise.all([
      env.cloudflareConfigured ? getCloudflareDomains() : Promise.resolve(null),
      env.cloudflareConfigured ? getZones() : Promise.resolve<DnsZone[]>([]),
      env.porkbunConfigured ? getPorkbunDomains() : Promise.resolve(null),
    ]);

    const zoneByName = new Map(cfZones.map((z) => [z.name, z]));
    const domains = [...(cfDomains ?? []), ...(pbDomains ?? [])];
    const existing = await loadDomainItems();
    const seen = new Set<string>();

    for (const d of domains) {
      seen.add(d.name);
      const result = await upsertDomain(d, zoneByName.get(d.name), existing.get(d.name), userOid);
      if (result === "created") created += 1;
      else updated += 1;
    }

    // Items synced from a registrar that no longer lists them are flagged possibly missing.
    for (const [name, match] of existing) {
      if (seen.has(name) || match.flaggedMissing) continue;
      const registrar = match.metadata.registrar;
      const providerRan =
        (registrar === "cloudflare" && cfDomains !== null) ||
        (registrar === "porkbun" && pbDomains !== null);
      if (!providerRan) continue; // manually-created domain items are left alone
      await db
        .update(items)
        .set({ flaggedMissing: true, updatedAt: new Date() })
        .where(eq(items.id, match.id));
      await recordEvent(match.id, userOid, "updated", {
        source: "registrar",
        flaggedMissing: true,
        reason: "not_listed_by_registrar",
      });
      flagged += 1;
    }

    await db
      .update(syncRuns)
      .set({ finishedAt: new Date(), created, updated, matched: updated })
      .where(eq(syncRuns.id, run!.id));
    logger.info("registrars.sync.done", { created, updated, flagged, total: domains.length });
    return { runId: run!.id, created, updated, flaggedMissing: flagged, total: domains.length };
  } catch (err) {
    await db
      .update(syncRuns)
      .set({ finishedAt: new Date(), error: String(err), created, updated })
      .where(eq(syncRuns.id, run!.id));
    logger.error("registrars.sync.failed", { err: String(err) });
    throw err;
  }
}

export async function latestRegistrarStatus() {
  const [run] = await db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.source, "registrars"))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return {
    enabled: env.registrarsConfigured,
    cloudflare: env.cloudflareConfigured,
    porkbun: env.porkbunConfigured,
    intervalMinutes: env.REGISTRAR_SYNC_INTERVAL_MIN,
    alertDays: env.DOMAIN_EXPIRY_ALERT_DAYS,
    lastRun: run ?? null,
  };
}
