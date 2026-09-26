import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { appSettings } from "../../db/schema";
import type { DepreciationSettings } from "./schedule";

/**
 * Administrator settings for valuation: where "high value" starts, how far
 * ahead warranty and service reminders look, and depreciation lives. Stored as
 * one JSON value in app_settings, like the rest of the instance configuration,
 * so it changes without a restart.
 */

export type ValuationSettings = {
  /** Records worth at least this much are high value. 0 turns automatic marking off. */
  highValueThresholdCents: number;
  /** Warranties ending within this many days are announced. */
  warrantyAlertDays: number;
  /** Calendar service is "due soon" this many days ahead. */
  serviceSoonDays: number;
  /** Hour-counted service is "due soon" within this share of its interval. */
  serviceSoonPercent: number;
  /** Send the daily digest through the configured notifications. Events are published either way. */
  notify: boolean;
  depreciation: DepreciationSettings;
};

const KEY = "valuation.settings";

export const DEFAULT_SETTINGS: ValuationSettings = {
  highValueThresholdCents: 250_000,
  warrantyAlertDays: 30,
  serviceSoonDays: 14,
  serviceSoonPercent: 10,
  notify: true,
  depreciation: { defaultLifeYears: 5, salvagePercent: 0, lifeYearsByCategory: {} },
};

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;

/** Stored JSON merged over the defaults, field by field, so a partly valid value still loads. */
export function mergeSettings(stored: unknown): ValuationSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const d = (s.depreciation && typeof s.depreciation === "object" ? s.depreciation : {}) as Record<string, unknown>;
  const lives: Record<string, number> = {};
  if (d.lifeYearsByCategory && typeof d.lifeYearsByCategory === "object") {
    for (const [k, v] of Object.entries(d.lifeYearsByCategory as Record<string, unknown>)) {
      if (k.trim() && typeof v === "number" && v > 0 && v <= 100) lives[k.trim()] = v;
    }
  }
  return {
    highValueThresholdCents: Math.round(num(s.highValueThresholdCents, DEFAULT_SETTINGS.highValueThresholdCents, 0, 1e13)),
    warrantyAlertDays: Math.round(num(s.warrantyAlertDays, DEFAULT_SETTINGS.warrantyAlertDays, 0, 3650)),
    serviceSoonDays: Math.round(num(s.serviceSoonDays, DEFAULT_SETTINGS.serviceSoonDays, 0, 3650)),
    serviceSoonPercent: num(s.serviceSoonPercent, DEFAULT_SETTINGS.serviceSoonPercent, 0, 100),
    notify: typeof s.notify === "boolean" ? s.notify : DEFAULT_SETTINGS.notify,
    depreciation: {
      defaultLifeYears: num(d.defaultLifeYears, DEFAULT_SETTINGS.depreciation.defaultLifeYears, 0.1, 100),
      salvagePercent: num(d.salvagePercent, DEFAULT_SETTINGS.depreciation.salvagePercent, 0, 100),
      lifeYearsByCategory: lives,
    },
  };
}

let cache: ValuationSettings | null = null;

export async function getValuationSettings(): Promise<ValuationSettings> {
  if (cache) return cache;
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  let stored: unknown = null;
  try {
    stored = row ? JSON.parse(row.value) : null;
  } catch {
    // A hand-edited value that is not JSON falls back to the defaults.
  }
  cache = mergeSettings(stored);
  return cache;
}

export type ValuationSettingsPatch = Partial<Omit<ValuationSettings, "depreciation">> & {
  depreciation?: Partial<DepreciationSettings>;
};

export async function updateValuationSettings(patch: ValuationSettingsPatch): Promise<ValuationSettings> {
  const current = await getValuationSettings();
  const next = mergeSettings({
    ...current,
    ...patch,
    depreciation: { ...current.depreciation, ...(patch.depreciation ?? {}) },
  });
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: KEY, value: JSON.stringify(next), updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: sql`excluded.value`, updatedAt: now } });
  cache = null;
  return getValuationSettings();
}

/** For tests and after a restore. */
export function invalidateValuationSettings(): void {
  cache = null;
}
