/**
 * Pure helpers for turning what hardware sends into what the tracking core
 * stores. No database or environment access, so they are cheap to test.
 */

const SEPARATORS = /[\s:]/g;
const HEX = /^[0-9A-Fa-f]+$/;

/**
 * The form a code is stored and matched in. Readers disagree on how to print
 * an EPC ("e2 80 11...", "E2:80:11...", "E28011..."), so a value made only of
 * hex digits once spaces and colons are removed is uppercased and compacted.
 * Anything else (an asset code, a beacon identity such as "mac:AA:BB:...") is
 * only trimmed, because its colons and case may be meaningful.
 *
 * The migration defines tracking_normalize_code() in SQL with the same rule, so
 * stored identifiers and incoming reads meet in the middle.
 */
export function normalizeCode(raw: string): string {
  const trimmed = raw.trim();
  const compact = trimmed.replace(SEPARATORS, "");
  return compact && HEX.test(compact) ? compact.toUpperCase() : trimmed;
}

/** A finite number, or null. Numeric strings count, since form posts are text. */
export function finiteOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** An integer, or null. */
export function intOrNull(v: unknown): number | null {
  const n = finiteOrNull(v);
  return n === null ? null : Math.trunc(n);
}

/**
 * A point in time from whatever a device sends: an ISO string (with or
 * without a colon in the offset, which Zebra omits), or an epoch number in
 * seconds, milliseconds, microseconds (Speedway Connect) or nanoseconds.
 * Returns null for anything unreadable rather than guessing.
 */
export function parseTimestamp(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return parseTimestamp(Number(s));
    // "2021-06-08T09:33:48.157+0000" -> "...+00:00"
    const fixed = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const ms = Date.parse(fixed);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    let ms: number;
    if (v < 1e11) ms = v * 1000; // seconds
    else if (v < 1e14) ms = v; // milliseconds
    else if (v < 1e17) ms = v / 1000; // microseconds
    else ms = v / 1e6; // nanoseconds
    return new Date(ms);
  }
  return null;
}

/**
 * The time to store for a read. A device clock running ahead would otherwise
 * park a sighting in the future, where it would outrank every real one, so a
 * timestamp more than `toleranceMs` ahead of the server is replaced by the
 * server's time. Past timestamps are kept: a reader that buffered through an
 * outage reports when it really saw things.
 */
export function clampObservedAt(observed: Date | null | undefined, now: Date, toleranceMs = 60_000): Date {
  if (!observed || Number.isNaN(observed.getTime())) return now;
  return observed.getTime() > now.getTime() + toleranceMs ? now : observed;
}

/** Base64 (as Impinj sends `epc`) to uppercase hex. Null when it is not base64. */
export function base64ToHex(b64: string): string | null {
  const s = b64.trim();
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const hex = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
  return hex ? hex.toUpperCase() : null;
}
