import { randomBytes } from "node:crypto";
import { isUniqueViolation } from "../../lib/errors";

/**
 * Printed references for projects, jobs and shipments: PRJ-7F3K2A, JOB-…,
 * SHP-…. Same alphabet as asset codes (lib/codes), so a code read off a load
 * sheet over the phone cannot be misheard into a different one. The prefixes
 * are fixed rather than configurable: they appear on paperwork that travels
 * between organisations, and a shared vocabulary helps there.
 */

// Crockford base32: no I, L, O or U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type CodeKind = "project" | "job" | "shipment";
export const CODE_PREFIX: Record<CodeKind, string> = { project: "PRJ", job: "JOB", shipment: "SHP" };

export function genCode(kind: CodeKind, length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${CODE_PREFIX[kind]}-${out}`;
}

/** True when a string looks like one of these codes, so a scan can be routed to it. */
export function parseCode(raw: string): { kind: CodeKind; code: string } | null {
  const code = raw.trim().toUpperCase();
  const m = /^(PRJ|JOB|SHP)-[0-9A-HJKMNP-TV-Z]{4,12}$/.exec(code);
  if (!m) return null;
  const kind = (Object.entries(CODE_PREFIX).find(([, p]) => p === m[1])?.[0] ?? "job") as CodeKind;
  return { kind, code };
}

/**
 * Insert with a fresh code, retrying on the (rare) collision with the unique
 * index. `insert` receives the code to use.
 */
export async function withFreshCode<T>(
  kind: CodeKind,
  constraint: string,
  insert: (code: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await insert(genCode(kind));
    } catch (err) {
      if (attempt < 4 && isUniqueViolation(err, constraint)) continue;
      throw err;
    }
  }
}
