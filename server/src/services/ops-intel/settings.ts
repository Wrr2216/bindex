import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { appSettings } from "../../db/schema";
import { logger } from "../../lib/logger";
import { defaultSettings, mergeSettings, type OpsSettings } from "./model";

/**
 * Thresholds live in app_settings under one key, as JSON, next to the rest of
 * the instance configuration (and, like it, outside the data backup). Stored
 * values are laid over the defaults on every read, so a threshold added in a
 * later release takes its default until someone changes it.
 */

const KEY = "ops_intel.settings";

// Re-read now and then, so a change saved on another replica is picked up.
const TTL_MS = 60_000;
let cache: OpsSettings | null = null;
let cachedAt = 0;

export async function getSettings(): Promise<OpsSettings> {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(sql`${appSettings.key} = ${KEY}`)
    .limit(1);
  let stored: unknown = {};
  if (row) {
    try {
      stored = JSON.parse(row.value);
    } catch {
      logger.warn("ops.settings.unreadable", { key: KEY });
    }
  }
  cache = mergeSettings(defaultSettings(), stored);
  cachedAt = Date.now();
  return cache;
}

/** Apply a partial update. Unknown keys are dropped and numbers clamped. */
export async function updateSettings(patch: unknown): Promise<OpsSettings> {
  // Build on what is stored now, not on a copy another replica has since replaced.
  cache = null;
  const next = mergeSettings(await getSettings(), patch);
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: KEY, value: JSON.stringify(next), updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(next), updatedAt: now } });
  cache = next;
  cachedAt = Date.now();
  return next;
}

/** For tests and after a restore. */
export function invalidateSettings(): void {
  cache = null;
}
