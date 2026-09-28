/**
 * Small pure helpers for comparing and describing records. The SQL twin of
 * identityKey is ops_identity_key() in migrations/0043_ops_intel.sql; the
 * gather step uses it only to narrow the candidates, and the rule groups again
 * with this one, so the two agreeing matters for speed, not for correctness.
 */

/** Letters and digits, uppercased: "sn-0042 a" and "SN0042A" are the same identifier. */
export const identityKey = (value: string | null | undefined): string =>
  (value ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();

/** Case, spacing and punctuation folded, for comparing names typed by hand. */
export const nameKey = (value: string | null | undefined): string =>
  (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "45 min", "6 h", "3 days": the precision a person wants in a title. */
export function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < HOUR) return `${Math.max(1, Math.round(v / MINUTE))} min`;
  if (v < 2 * DAY) return `${Math.round(v / HOUR)} h`;
  return `${Math.round(v / DAY)} days`;
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

/** "Chair (INV-7F3K2A)", or just the name when there is no code. */
export const labelOf = (name: string, code: string | null | undefined): string =>
  code ? `${name} (${code})` : name;

/** A stable sort key: natural order, so "Floor 10" follows "Floor 9". */
export const naturalCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
