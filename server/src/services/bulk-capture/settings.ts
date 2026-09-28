import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { appSettings, type CaptureDeskTemplate } from "../../db/schema";
import { badRequest } from "../../lib/errors";
import { DEFAULT_DESK_TEMPLATE, normalizeTemplate } from "./desk";

/**
 * Instance settings for bulk capture: the cost guard and the desk templates.
 * Kept as one JSON value in app_settings under this feature's own key, so the
 * shared configuration module only carries the feature switch.
 */

export type BulkCaptureSettings = {
  /** The cap a new session starts with, and the most any session may raise its own to. */
  maxImagesPerSession: number;
  deskTemplates: CaptureDeskTemplate[];
};

const KEY = "bulk_capture.settings";
/** A hard ceiling, so a typo in Settings cannot authorise thousands of vision calls. */
export const MAX_IMAGE_CAP = 500;
export const DEFAULT_IMAGE_CAP = 40;

export const DEFAULT_SETTINGS: BulkCaptureSettings = {
  maxImagesPerSession: DEFAULT_IMAGE_CAP,
  deskTemplates: [DEFAULT_DESK_TEMPLATE],
};

/** Settings from storage or a request, cleaned. Unusable parts fall back to the defaults. Pure. */
export function normalizeSettings(v: unknown): BulkCaptureSettings {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const cap = typeof o.maxImagesPerSession === "number" && Number.isFinite(o.maxImagesPerSession)
    ? Math.min(MAX_IMAGE_CAP, Math.max(1, Math.round(o.maxImagesPerSession)))
    : DEFAULT_SETTINGS.maxImagesPerSession;
  const templates: CaptureDeskTemplate[] = [];
  if (Array.isArray(o.deskTemplates)) {
    for (const t of o.deskTemplates) {
      const clean = normalizeTemplate(t);
      if (clean && !templates.some((x) => x.id === clean.id)) templates.push(clean);
      if (templates.length >= 20) break;
    }
  }
  return { maxImagesPerSession: cap, deskTemplates: templates.length ? templates : DEFAULT_SETTINGS.deskTemplates };
}

export async function getBulkCaptureSettings(): Promise<BulkCaptureSettings> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  if (!row) return DEFAULT_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(row.value));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveBulkCaptureSettings(patch: Partial<BulkCaptureSettings>): Promise<BulkCaptureSettings> {
  if (patch.deskTemplates !== undefined) {
    const kept = patch.deskTemplates.map(normalizeTemplate);
    const bad = kept.findIndex((t) => !t);
    if (bad >= 0) throw badRequest(`Desk template ${bad + 1} needs a name and at least one expected item with a label.`);
    if (!kept.length) throw badRequest("Keep at least one desk template.");
  }
  const current = await getBulkCaptureSettings();
  const next = normalizeSettings({ ...current, ...patch });
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: KEY, value: JSON.stringify(next), updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: sql`excluded.value`, updatedAt: now } });
  return next;
}
