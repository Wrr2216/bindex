import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { items, itemIdentifiers, syncRuns } from "../../db/schema";
import { env } from "../../env";
import { logger } from "../../lib/logger";
import { recordEvent } from "../items";
import { badRequest } from "../../lib/errors";
import { getAssetIds, getDevices, getOrganizations, setDeviceAssetId, type NinjaDevice } from "./client";

export type SyncSummary = {
  runId: string;
  created: number;
  updated: number;
  pushed: number;
  total: number;
};

type MatchedItem = { id: string; assetCode: string };

/** Find an existing item that represents this NinjaOne device. */
async function findItem(device: NinjaDevice): Promise<MatchedItem | null> {
  const [byNinja] = await db
    .select({ id: items.id, assetCode: items.assetCode })
    .from(items)
    .where(eq(items.ninjaoneDeviceId, device.id))
    .limit(1);
  if (byNinja) return byNinja;

  if (device.serial) {
    const [bySerial] = await db
      .select({ id: items.id, assetCode: items.assetCode })
      .from(items)
      .innerJoin(itemIdentifiers, eq(itemIdentifiers.itemId, items.id))
      .where(and(eq(itemIdentifiers.type, "serial"), eq(itemIdentifiers.value, device.serial)))
      .limit(1);
    if (bySerial) return bySerial;
  }
  return null;
}

/**
 * Two-way sync with NinjaOne. Devices are pulled in and matched on serial
 * number or on a NinjaOne id already recorded here; anything unmatched becomes
 * a new item. The asset code goes the other way, into the NinjaOne Asset ID
 * custom field, because this app owns that value.
 */
export async function runNinjaSync(userOid: string | null): Promise<SyncSummary> {
  if (!env.ninjaoneConfigured) {
    throw badRequest("NinjaOne is not configured (set NINJAONE_ENABLED + credentials).");
  }

  const [run] = await db.insert(syncRuns).values({ source: "ninjaone" }).returning();
  let created = 0;
  let updated = 0;
  let pushed = 0;

  try {
    const [devices, orgs, assetIds] = await Promise.all([
      getDevices(),
      getOrganizations().catch(() => new Map<number, string>()),
      getAssetIds(env.NINJAONE_ASSET_ID_FIELD).catch((err) => {
        logger.warn("ninjaone.assetids.failed", { err: String(err) });
        return new Map<number, string>();
      }),
    ]);

    for (const device of devices) {
      const now = new Date();
      const ninjaAssetId = assetIds.get(device.id) ?? null;
      const org = device.organizationId != null ? (orgs.get(device.organizationId) ?? null) : null;
      const existing = await findItem(device);

      let itemId: string;
      let assetCode: string;
      if (existing) {
        itemId = existing.id;
        assetCode = existing.assetCode;
        updated += 1;
      } else {
        const [item] = await db
          .insert(items)
          .values({
            name: device.name,
            brand: device.manufacturer,
            model: device.model,
            enrichmentSource: "ninjaone",
            ninjaoneDeviceId: device.id,
            ninjaoneOrg: org,
            ninjaoneSyncedAt: now,
            createdBy: userOid,
          })
          .returning();
        itemId = item!.id;
        assetCode = item!.assetCode;
        if (device.serial) {
          await db
            .insert(itemIdentifiers)
            .values({ itemId, type: "serial", value: device.serial })
            .onConflictDoNothing();
        }
        await recordEvent(itemId, userOid, "created", { source: "ninjaone", deviceId: device.id });
        created += 1;
      }

      // Our code wins: stamp it into NinjaOne whenever the two disagree.
      let ninjaAssetIdFinal = ninjaAssetId;
      if (assetCode !== ninjaAssetId) {
        try {
          await setDeviceAssetId(device.id, env.NINJAONE_ASSET_ID_FIELD, assetCode);
          ninjaAssetIdFinal = assetCode;
          pushed += 1;
        } catch (err) {
          logger.warn("ninjaone.assetid.push_failed", { deviceId: device.id, err: String(err) });
        }
      }

      await db
        .update(items)
        .set({
          ninjaoneDeviceId: device.id,
          ninjaoneAssetId: ninjaAssetIdFinal,
          ninjaoneOrg: org,
          ninjaoneSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(items.id, itemId));
    }

    await db
      .update(syncRuns)
      .set({ finishedAt: new Date(), created, updated, matched: updated })
      .where(eq(syncRuns.id, run!.id));
    logger.info("ninjaone.sync.done", { created, updated, pushed, total: devices.length });
    return { runId: run!.id, created, updated, pushed, total: devices.length };
  } catch (err) {
    await db
      .update(syncRuns)
      .set({ finishedAt: new Date(), error: String(err), created, updated })
      .where(eq(syncRuns.id, run!.id));
    // Not being connected yet is the normal state before someone sets it up,
    // so it is not worth an error-level log.
    const notConnected = String(err).includes("is not connected");
    if (notConnected) logger.warn("ninjaone.sync.skipped", { reason: "not_connected" });
    else logger.error("ninjaone.sync.failed", { err: String(err) });
    throw err;
  }
}

export async function latestSyncStatus() {
  const [run] = await db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.source, "ninjaone"))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return { enabled: env.ninjaoneConfigured, intervalMinutes: env.NINJAONE_SYNC_INTERVAL_MIN, lastRun: run ?? null };
}
