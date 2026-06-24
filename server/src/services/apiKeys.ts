import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { apiKeys, type ApiKey, type ApiKeyScope } from "../db/schema";
import { logger } from "../lib/logger";

export const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** The `bdx_` prefix makes a leaked key recognisable in a log or a repo. */
export const generateApiKey = (): string => `bdx_${randomBytes(32).toString("base64url")}`;

/** What clients see. The hash never leaves this module. */
export type ApiKeyInfo = Pick<
  ApiKey,
  "id" | "name" | "scope" | "keyLast4" | "createdAt" | "lastUsedAt"
>;

const info = (row: ApiKey): ApiKeyInfo => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  keyLast4: row.keyLast4,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

/** Creates a key and returns it in the clear, the only time that is possible. */
export async function createApiKey(
  name: string,
  scope: ApiKeyScope,
  createdBy: string,
): Promise<ApiKeyInfo & { key: string }> {
  const key = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ name, scope, createdBy, keyHash: hashKey(key), keyLast4: key.slice(-4) })
    .returning();
  return { ...info(row!), key };
}

export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(isNull(apiKeys.revokedAt))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(info);
}

/** Marks a key revoked. False means no active key had that id. */
export async function revokeApiKey(id: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

export async function findActiveKeyByHash(keyHash: string): Promise<ApiKey | null> {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  return row ?? null;
}

const lastTouched = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60_000;

/** Records that a key was used, at most once a minute per key. */
export function touchLastUsed(id: string): void {
  const now = Date.now();
  const prev = lastTouched.get(id);
  if (prev !== undefined && now - prev < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, id))
    .catch((err) => logger.warn("apikey.touch.failed", { id, err: String(err) }));
}
