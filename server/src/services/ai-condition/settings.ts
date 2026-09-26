import { inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { appSettings } from "../../db/schema";
import { badRequest } from "../../lib/errors";
import { DEFAULT_CATEGORIES, DEFAULT_SIZE_CLASSES } from "./vocab";

/**
 * The lists an organisation tunes: the container size classes it uses and
 * the categories contents are sorted into, plus a note added to every prompt
 * ("our totes are 60 litre, grey"). Stored in app_settings next to the
 * instance configuration, so an administrator changes them without a restart.
 */

export type ConditionSettings = {
  sizeClasses: string[];
  categories: string[];
  /** Extra instructions appended to every prompt. */
  promptHint: string;
};

const KEYS = {
  sizeClasses: "condition.size_classes",
  categories: "condition.categories",
  promptHint: "condition.prompt_hint",
} as const;

export const MAX_LIST = 40;
export const MAX_ENTRY = 40;
export const MAX_HINT = 1000;

/** Trimmed, unique ignoring case, non-empty, bounded. Order is kept: it is the order people see. */
export function cleanList(list: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (typeof v !== "string") continue;
    const s = v.replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (s.length > MAX_ENTRY) throw badRequest(`"${s.slice(0, 20)}…" is too long. Keep each entry under ${MAX_ENTRY} characters.`);
    if (seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  if (out.length > MAX_LIST) throw badRequest(`Keep the list to ${MAX_LIST} entries or fewer.`);
  return out;
}

function parseList(raw: string | undefined, fallback: readonly string[]): string[] {
  if (!raw) return [...fallback];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? cleanList(parsed) : [];
    return list.length ? list : [...fallback];
  } catch {
    return [...fallback];
  }
}

let cache: ConditionSettings | null = null;

export async function getConditionSettings(): Promise<ConditionSettings> {
  if (cache) return cache;
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, Object.values(KEYS)));
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  cache = {
    sizeClasses: parseList(stored.get(KEYS.sizeClasses), DEFAULT_SIZE_CLASSES),
    categories: parseList(stored.get(KEYS.categories), DEFAULT_CATEGORIES),
    promptHint: (stored.get(KEYS.promptHint) ?? "").slice(0, MAX_HINT),
  };
  return cache;
}

export function defaultConditionSettings(): ConditionSettings {
  return { sizeClasses: [...DEFAULT_SIZE_CLASSES], categories: [...DEFAULT_CATEGORIES], promptHint: "" };
}

/** An empty list puts the defaults back. */
export async function updateConditionSettings(patch: Partial<ConditionSettings>): Promise<ConditionSettings> {
  const writes: [string, string][] = [];
  if (patch.sizeClasses !== undefined) writes.push([KEYS.sizeClasses, JSON.stringify(cleanList(patch.sizeClasses))]);
  if (patch.categories !== undefined) writes.push([KEYS.categories, JSON.stringify(cleanList(patch.categories))]);
  if (patch.promptHint !== undefined) {
    const hint = patch.promptHint.trim();
    if (hint.length > MAX_HINT) throw badRequest(`Keep the extra instructions under ${MAX_HINT} characters.`);
    writes.push([KEYS.promptHint, hint]);
  }
  if (writes.length) {
    const now = new Date();
    await db
      .insert(appSettings)
      .values(writes.map(([key, value]) => ({ key, value, updatedAt: now })))
      .onConflictDoUpdate({ target: appSettings.key, set: { value: sql`excluded.value`, updatedAt: now } });
    cache = null;
  }
  return getConditionSettings();
}
