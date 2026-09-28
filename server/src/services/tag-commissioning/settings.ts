import { inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { appSettings } from "../../db/schema";
import { cleanPalette, type PaletteColor } from "./palette";
import { isGs1CompanyPrefix, type EpcScheme } from "./epc";

/**
 * Tag commissioning settings, kept with the rest of the instance settings in
 * app_settings so an administrator changes them without a restart.
 */

const KEYS = {
  gs1CompanyPrefix: "tags.gs1_company_prefix",
  palette: "tags.legacy_palette",
} as const;

export type TagSettings = {
  /** Empty when the instance has none, which selects the private EPC scheme. */
  gs1CompanyPrefix: string;
  palette: PaletteColor[];
  /** The scheme new EPCs are assigned in, following from the prefix. */
  epcScheme: EpcScheme;
};

let cache: TagSettings | null = null;

function build(stored: Map<string, string>): TagSettings {
  const prefix = stored.get(KEYS.gs1CompanyPrefix)?.trim() ?? "";
  const gs1CompanyPrefix = isGs1CompanyPrefix(prefix) ? prefix : "";
  let palette: unknown = null;
  try {
    palette = JSON.parse(stored.get(KEYS.palette) ?? "null");
  } catch {
    // A hand-edited row that is not JSON falls back to the default colours.
  }
  return {
    gs1CompanyPrefix,
    palette: cleanPalette(palette),
    epcScheme: gs1CompanyPrefix ? "giai-96" : "bindex-96",
  };
}

export async function getTagSettings(): Promise<TagSettings> {
  if (cache) return cache;
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, Object.values(KEYS)));
  cache = build(new Map(rows.map((r) => [r.key, r.value])));
  return cache;
}

export type TagSettingsPatch = { gs1CompanyPrefix?: string; palette?: PaletteColor[] };

export async function updateTagSettings(patch: TagSettingsPatch): Promise<TagSettings> {
  const writes: { key: string; value: string }[] = [];
  if (patch.gs1CompanyPrefix !== undefined) {
    writes.push({ key: KEYS.gs1CompanyPrefix, value: patch.gs1CompanyPrefix.trim() });
  }
  if (patch.palette !== undefined) {
    writes.push({ key: KEYS.palette, value: JSON.stringify(cleanPalette(patch.palette)) });
  }
  if (writes.length) {
    const now = new Date();
    await db
      .insert(appSettings)
      .values(writes.map((w) => ({ ...w, updatedAt: now })))
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: sql`excluded.value`, updatedAt: now },
      });
    cache = null;
  }
  return getTagSettings();
}

/** The palette entry for a colour name, case-insensitively, or null. */
export function findColor(palette: PaletteColor[], name: string): PaletteColor | null {
  const upper = name.trim().toUpperCase();
  return palette.find((c) => c.name === upper) ?? null;
}
