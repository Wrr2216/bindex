import { randomBytes } from "node:crypto";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";
import { isUniqueViolation } from "../../lib/errors";

/** The database or an open transaction: both run the same queries. */
export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

/**
 * Who is acting. `userOid` is the account (an API key's is "api-key:<id>");
 * `name` is what timesheets and the audit log show; `isAdmin` gates overrides
 * a job type reserves for administrators.
 */
export type CrewActor = { userOid: string | null; name: string | null; isAdmin: boolean };

export const actorName = (actor: CrewActor): string | null => actor.name?.trim() || actor.userOid;

/** Trim to null, so an empty form field clears a column instead of storing "". */
export const clean = (s: string | null | undefined): string | null => {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t ? t : null;
};

// Crockford base32, as asset and job codes use: nothing on a badge can be
// misread as a different code (no I, L, O or U).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function genBadgeCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `CRW-${out}`;
}

/** Postgres refused because a row is still referenced (or references nothing). */
export function isForeignKeyViolation(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 10; depth++) {
    if ((cur as { code?: unknown }).code === "23503") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Insert with a fresh badge code, retrying on the rare collision. */
export async function withFreshBadge<T>(insert: (code: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await insert(genBadgeCode());
    } catch (err) {
      if (attempt < 4 && isUniqueViolation(err, "uq_crew_workers_badge")) continue;
      throw err;
    }
  }
}
