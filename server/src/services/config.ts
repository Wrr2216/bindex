import { inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { appSettings } from "../db/schema";
import { env } from "../env";
import { applyCodePrefixes, normalizeCodePrefix } from "../lib/codes";

/**
 * Instance configuration: the naming, vocabulary and feature set that differ
 * from one deployment to the next. It lives in the database rather than the
 * environment so an administrator can change it from Settings without a
 * restart; the environment only supplies the values used to seed a brand new
 * database.
 *
 * Keys are flat and dotted so SQL can read a single one directly. The asset
 * code prefix in particular is read by a database trigger.
 */

export type Term = { singular: string; plural: string };

export type Features = {
  /** Ownership grouping applied to locations and items. */
  groups: boolean;
  /** People, teams or customers an item can be checked out to. */
  holders: boolean;
  /** Domain names tracked as inventory, with registrar sync. */
  domains: boolean;
  /** Individually tracked units of a multi-quantity item. */
  units: boolean;
  /** Check-out and check-in history. */
  assignments: boolean;
  /** Reconcile a container or a whole building against what is on file. */
  audit: boolean;
  /** Label and contents-sheet printing. */
  printing: boolean;
  /** Extra fields for vehicles and powered equipment. */
  vehicleFields: boolean;
  /** Fill in an unknown barcode from a product database. */
  lookup: boolean;
  /** Turn a typed question into a search filter. Needs a language model. */
  askSearch: boolean;
  /** Prompt to confirm a random item when a container is moved. */
  spotCheck: boolean;
  /** Readers, beacons and trackers: devices, sightings and positions. */
  tracking: boolean;
  /** Photos, video and files on records, and reading labels with AI. */
  aiCapture: boolean;
  /** Projects, jobs, shipments and relocation manifests. */
  jobs: boolean;
  /** Chain of custody: controlled items, signed handoffs and delivery sign-off. */
  custody: boolean;
};

export type AppConfig = {
  appName: string;
  orgName: string;
  tagline: string;
  accentColor: string;
  assetCodePrefix: string;
  locationCodePrefix: string;
  currency: string;
  locale: string;
  terms: {
    item: Term;
    location: Term;
    group: Term;
    holder: Term;
  };
  features: Features;
};

const KEYS = {
  appName: "branding.app_name",
  orgName: "branding.org_name",
  tagline: "branding.tagline",
  accentColor: "branding.accent_color",
  assetCodePrefix: "codes.asset_prefix",
  locationCodePrefix: "codes.location_prefix",
  currency: "format.currency",
  locale: "format.locale",
  termItemSingular: "terms.item.singular",
  termItemPlural: "terms.item.plural",
  termLocationSingular: "terms.location.singular",
  termLocationPlural: "terms.location.plural",
  termGroupSingular: "terms.group.singular",
  termGroupPlural: "terms.group.plural",
  termHolderSingular: "terms.holder.singular",
  termHolderPlural: "terms.holder.plural",
  featureGroups: "features.groups",
  featureHolders: "features.holders",
  featureDomains: "features.domains",
  featureUnits: "features.units",
  featureAssignments: "features.assignments",
  featureAudit: "features.audit",
  featurePrinting: "features.printing",
  featureVehicleFields: "features.vehicle_fields",
  featureLookup: "features.lookup",
  featureAskSearch: "features.ask_search",
  // Predates the config table; kept under its original key so existing
  // deployments do not silently lose the setting.
  featureSpotCheck: "spot_check_enabled",
  featureTracking: "features.tracking",
  featureAiCapture: "features.ai_capture",
  featureJobs: "features.jobs",
  featureCustody: "features.custody",
} as const;

function defaults(): AppConfig {
  return {
    appName: env.APP_NAME.trim() || "Bindex",
    orgName: env.ORG_NAME.trim(),
    tagline: "Scan anything, find it anywhere.",
    accentColor: "#0284c7",
    assetCodePrefix: normalizeCodePrefix(env.ASSET_CODE_PREFIX, "INV"),
    locationCodePrefix: "LOC",
    currency: "USD",
    locale: "en-US",
    terms: {
      item: { singular: "Item", plural: "Items" },
      location: { singular: "Location", plural: "Locations" },
      group: { singular: "Group", plural: "Groups" },
      holder: { singular: "Assignee", plural: "Assignees" },
    },
    features: {
      groups: true,
      holders: true,
      domains: false,
      units: true,
      assignments: true,
      audit: true,
      printing: true,
      vehicleFields: false,
      lookup: true,
      askSearch: true,
      spotCheck: false,
      tracking: true,
      aiCapture: true,
      jobs: false,
      custody: false,
    },
  };
}

function build(stored: Map<string, string>): AppConfig {
  const base = defaults();
  const str = (key: string, fallback: string) => stored.get(key)?.trim() || fallback;
  const flag = (key: string, fallback: boolean) => {
    const raw = stored.get(key);
    return raw === undefined ? fallback : raw === "true";
  };

  return {
    appName: str(KEYS.appName, base.appName),
    orgName: stored.get(KEYS.orgName) ?? base.orgName,
    tagline: stored.get(KEYS.tagline) ?? base.tagline,
    accentColor: str(KEYS.accentColor, base.accentColor),
    assetCodePrefix: normalizeCodePrefix(
      str(KEYS.assetCodePrefix, base.assetCodePrefix),
      base.assetCodePrefix,
    ),
    locationCodePrefix: normalizeCodePrefix(
      str(KEYS.locationCodePrefix, base.locationCodePrefix),
      base.locationCodePrefix,
    ),
    currency: str(KEYS.currency, base.currency),
    locale: str(KEYS.locale, base.locale),
    terms: {
      item: {
        singular: str(KEYS.termItemSingular, base.terms.item.singular),
        plural: str(KEYS.termItemPlural, base.terms.item.plural),
      },
      location: {
        singular: str(KEYS.termLocationSingular, base.terms.location.singular),
        plural: str(KEYS.termLocationPlural, base.terms.location.plural),
      },
      group: {
        singular: str(KEYS.termGroupSingular, base.terms.group.singular),
        plural: str(KEYS.termGroupPlural, base.terms.group.plural),
      },
      holder: {
        singular: str(KEYS.termHolderSingular, base.terms.holder.singular),
        plural: str(KEYS.termHolderPlural, base.terms.holder.plural),
      },
    },
    features: {
      groups: flag(KEYS.featureGroups, base.features.groups),
      holders: flag(KEYS.featureHolders, base.features.holders),
      // The registrar integration implies the feature, so a configured
      // deployment does not have to switch it on in two places.
      domains: flag(KEYS.featureDomains, base.features.domains) || env.registrarsConfigured,
      units: flag(KEYS.featureUnits, base.features.units),
      assignments: flag(KEYS.featureAssignments, base.features.assignments),
      audit: flag(KEYS.featureAudit, base.features.audit),
      printing: flag(KEYS.featurePrinting, base.features.printing),
      vehicleFields: flag(KEYS.featureVehicleFields, base.features.vehicleFields),
      lookup: flag(KEYS.featureLookup, base.features.lookup),
      askSearch: flag(KEYS.featureAskSearch, base.features.askSearch) && env.llmConfigured,
      spotCheck: flag(KEYS.featureSpotCheck, base.features.spotCheck),
      tracking: flag(KEYS.featureTracking, base.features.tracking),
      aiCapture: flag(KEYS.featureAiCapture, base.features.aiCapture),
      jobs: flag(KEYS.featureJobs, base.features.jobs),
      custody: flag(KEYS.featureCustody, base.features.custody),
    },
  };
}

let cache: AppConfig | null = null;

/**
 * Read the effective configuration. Cached because it is consulted on nearly
 * every request; `invalidateConfig` clears it after a write.
 */
export async function getConfig(): Promise<AppConfig> {
  if (cache) return cache;
  const wanted = Object.values(KEYS) as string[];
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, wanted));
  cache = build(new Map(rows.map((r) => [r.key, r.value])));
  // Code generation happens in places that cannot await, so the prefixes are
  // mirrored into the generator whenever the configuration is loaded.
  applyCodePrefixes(cache.assetCodePrefix, cache.locationCodePrefix);
  return cache;
}

export function invalidateConfig(): void {
  cache = null;
}

/**
 * Write the environment-supplied defaults into a database that has never seen
 * them. Runs once, on the first boot of a new instance: after that the stored
 * values are what an administrator edited, so they are left alone.
 *
 * The asset prefix in particular has to exist as a row, because the database
 * trigger that generates codes reads it directly and cannot see the
 * environment.
 */
export async function seedConfig(): Promise<void> {
  const base = defaults();
  const now = new Date();
  await db
    .insert(appSettings)
    .values([
      { key: KEYS.appName, value: base.appName, updatedAt: now },
      { key: KEYS.orgName, value: base.orgName, updatedAt: now },
      { key: KEYS.assetCodePrefix, value: base.assetCodePrefix, updatedAt: now },
      { key: KEYS.locationCodePrefix, value: base.locationCodePrefix, updatedAt: now },
    ])
    .onConflictDoNothing({ target: appSettings.key });
  invalidateConfig();
  await getConfig();
}

/** Shape accepted from the settings screen. Every field is optional. */
export type ConfigPatch = {
  appName?: string;
  orgName?: string;
  tagline?: string;
  accentColor?: string;
  assetCodePrefix?: string;
  locationCodePrefix?: string;
  currency?: string;
  locale?: string;
  terms?: Partial<Record<keyof AppConfig["terms"], Partial<Term>>>;
  features?: Partial<Features>;
};

const TERM_KEYS: Record<keyof AppConfig["terms"], { singular: string; plural: string }> = {
  item: { singular: KEYS.termItemSingular, plural: KEYS.termItemPlural },
  location: { singular: KEYS.termLocationSingular, plural: KEYS.termLocationPlural },
  group: { singular: KEYS.termGroupSingular, plural: KEYS.termGroupPlural },
  holder: { singular: KEYS.termHolderSingular, plural: KEYS.termHolderPlural },
};

const FEATURE_KEYS: Record<keyof Features, string> = {
  groups: KEYS.featureGroups,
  holders: KEYS.featureHolders,
  domains: KEYS.featureDomains,
  units: KEYS.featureUnits,
  assignments: KEYS.featureAssignments,
  audit: KEYS.featureAudit,
  printing: KEYS.featurePrinting,
  vehicleFields: KEYS.featureVehicleFields,
  lookup: KEYS.featureLookup,
  askSearch: KEYS.featureAskSearch,
  spotCheck: KEYS.featureSpotCheck,
  tracking: KEYS.featureTracking,
  aiCapture: KEYS.featureAiCapture,
  jobs: KEYS.featureJobs,
  custody: KEYS.featureCustody,
};

export async function updateConfig(patch: ConfigPatch): Promise<AppConfig> {
  const writes = new Map<string, string>();
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined) writes.set(key, value);
  };

  put(KEYS.appName, patch.appName?.trim());
  put(KEYS.orgName, patch.orgName?.trim());
  put(KEYS.tagline, patch.tagline?.trim());
  put(KEYS.accentColor, patch.accentColor?.trim());
  put(KEYS.currency, patch.currency?.trim());
  put(KEYS.locale, patch.locale?.trim());
  if (patch.assetCodePrefix !== undefined) {
    writes.set(KEYS.assetCodePrefix, normalizeCodePrefix(patch.assetCodePrefix, "INV"));
  }
  if (patch.locationCodePrefix !== undefined) {
    writes.set(KEYS.locationCodePrefix, normalizeCodePrefix(patch.locationCodePrefix, "LOC"));
  }

  for (const [name, keys] of Object.entries(TERM_KEYS)) {
    const term = patch.terms?.[name as keyof AppConfig["terms"]];
    put(keys.singular, term?.singular?.trim());
    put(keys.plural, term?.plural?.trim());
  }
  for (const [name, key] of Object.entries(FEATURE_KEYS)) {
    const on = patch.features?.[name as keyof Features];
    if (on !== undefined) writes.set(key, on ? "true" : "false");
  }

  if (writes.size > 0) {
    const now = new Date();
    await db
      .insert(appSettings)
      .values([...writes].map(([key, value]) => ({ key, value, updatedAt: now })))
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: sql`excluded.value`, updatedAt: now },
      });
    invalidateConfig();
  }
  return getConfig();
}
