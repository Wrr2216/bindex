/**
 * Event types and the patterns that select them.
 *
 * A type is lowercase and dotted, at least two segments: item.created,
 * job.stage_changed, device.offline. A pattern is a type in which `*` stands
 * for any run of characters, dots included, so `item.*` selects item.created
 * and item.unit.moved alike and `*` selects everything.
 *
 * The database has a twin, event_type_matches() in migration 0025, used to
 * fan events out to webhooks and to filter the polling feed. Keep them in step.
 */

const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const PATTERN_RE = /^[a-z0-9_.*]+$/;

export const MAX_TYPE_LENGTH = 100;
export const MAX_PATTERNS = 50;

export function isValidEventType(type: string): boolean {
  return type.length <= MAX_TYPE_LENGTH && TYPE_RE.test(type);
}

export function isValidPattern(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= MAX_TYPE_LENGTH && PATTERN_RE.test(pattern);
}

function toRegExp(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

export function matchesPattern(type: string, pattern: string): boolean {
  return toRegExp(pattern).test(type);
}

export function matchesAny(type: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(type, p));
}

/**
 * Split a comma-separated list from a query string into patterns, lowercased
 * and deduplicated. Returns the ones that are not valid separately so the
 * caller can say which it rejected.
 */
export function parsePatternList(raw: string | undefined | null): { patterns: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    if (isValidPattern(p)) seen.add(p);
    else invalid.push(part.trim());
  }
  return { patterns: [...seen], invalid };
}

/**
 * The SQL LIKE pattern for an event pattern, escaped the same way as
 * event_type_matches() does it, so `type LIKE ANY($1)` can use the index.
 */
export function patternToLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "%");
}

/** A type prefix typed into a filter box, as a pattern: `item.` → `item.*`. */
export function prefixToPattern(prefix: string): string {
  const p = prefix.trim().toLowerCase();
  return p.includes("*") ? p : `${p}*`;
}
