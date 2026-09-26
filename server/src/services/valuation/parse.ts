/**
 * Pure parsing shared by AI valuation and receipt reading. Models are asked
 * for plain numbers and ISO dates and mostly comply; these take care of the
 * rest ("$1,299.99", "12,50 €", "03/02/24", "Mar 2, 2024") so a reply is never
 * thrown away for its formatting. No I/O, so every odd reply is a test case.
 */

const PLACEHOLDER = new Set(["", "n/a", "na", "none", "null", "unknown", "-", "--", "?", "not visible", "not available"]);

/** A trimmed single-line string, or null for blanks and placeholders. */
export function cleanText(v: unknown, max = 200): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (PLACEHOLDER.has(s.toLowerCase())) return null;
  return s.slice(0, max) || null;
}

const SYMBOLS = /[$€£¥₹₩₽₺₪฿₫₴₦]|\b(?:usd|eur|gbp|cad|aud|nzd|chf|jpy|sek|nok|dkk|inr|mxn|brl|zar|us\$|ca\$|a\$)\b/gi;

/**
 * An amount in major units (dollars) as integer cents. Accepts numbers and the
 * usual printed forms: "$1,299.99", "1.299,99 €", "12,50", "(4.00)" for a
 * negative. Negative amounts (discount lines) only when `allowNegative`.
 */
export function parseMoney(v: unknown, opts: { allowNegative?: boolean } = {}): number | null {
  let n: number | null = null;
  if (typeof v === "number") {
    n = Number.isFinite(v) ? v : null;
  } else if (typeof v === "string") {
    let s = v.trim();
    if (!s) return null;
    let negative = false;
    if (/^\(.*\)$/.test(s)) {
      negative = true;
      s = s.slice(1, -1);
    }
    s = s.replace(SYMBOLS, "").replace(/\s+/g, "");
    if (s.startsWith("-")) {
      negative = true;
      s = s.slice(1);
    } else if (s.endsWith("-")) {
      // Some tills print a credit as "4.00-".
      negative = true;
      s = s.slice(0, -1);
    }
    if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return null;
    s = s.replace(/'/g, "");
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      // Both present: whichever comes last is the decimal mark.
      const decimal = lastDot > lastComma ? "." : ",";
      const thousands = decimal === "." ? "," : ".";
      s = s.split(thousands).join("").replace(decimal, ".");
    } else if (lastComma >= 0) {
      const parts = s.split(",");
      // "12,50" is a decimal comma; "1,200" and "1,200,000" group thousands.
      s = parts.length === 2 && parts[1]!.length <= 2 ? `${parts[0]}.${parts[1]}` : parts.join("");
    } else if (s.split(".").length > 2) {
      // "1.200.000": dots grouping thousands.
      s = s.split(".").join("");
    }
    n = Number(s);
    if (!Number.isFinite(n)) return null;
    if (negative) n = -n;
  }
  if (n === null) return null;
  if (n < 0 && !opts.allowNegative) return null;
  // Guard against a model returning cents, a phone number or a year as a price.
  if (Math.abs(n) > 1e11) return null;
  return Math.round(n * 100);
}

/** A three-letter currency code, from a code or a common symbol; else the fallback. */
export function parseCurrency(v: unknown, fallback: string | null = null): string | null {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  const code = s.toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) return code;
  const bySymbol: Record<string, string> = { $: "USD", "US$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "CA$": "CAD", A$: "AUD" };
  return bySymbol[s] ?? fallback;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

// Locales that write the month first in numeric dates. Everyone else writes
// the day first.
const MONTH_FIRST = /^(?:en-us|en-ph|en-ca|es-us|fil|en-as|en-gu|en-mp|en-pr|en-um|en-vi)\b/i;

function valid(y: number, m: number, d: number, now: Date): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  // A receipt from the future or from before barcodes is a misread.
  if (y < 1970 || t.getTime() > now.getTime() + 2 * 86_400_000) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function fullYear(y: number, now: Date): number {
  if (y >= 100) return y;
  const century = Math.floor(now.getUTCFullYear() / 100) * 100;
  return century + y > now.getUTCFullYear() + 1 ? century - 100 + y : century + y;
}

/**
 * A printed date as YYYY-MM-DD, or null when it cannot be read as a real date.
 * Numeric dates are read day-first or month-first by the instance locale,
 * unless one of the numbers settles it (31/01 can only be day-first).
 */
export function parseDate(v: unknown, locale = "en-US", now = new Date()): string | null {
  const s = cleanText(v, 60);
  if (!s) return null;
  const text = s.replace(/^(?:date|dated|purchased|purchase date)\s*[:.]?\s*/i, "");

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s,])/.exec(text);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]), now);

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:$|[\s,])/.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(Number(m[3]), now);
    let monthFirst = MONTH_FIRST.test(locale);
    if (a > 12 && b <= 12) monthFirst = false;
    if (b > 12 && a <= 12) monthFirst = true;
    return monthFirst ? valid(y, a, b, now) : valid(y, b, a, now);
  }

  const month = (word: string) => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
  // "Mar 2, 2024", "March 2 2024"
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}|\d{2})\b/i.exec(text);
  if (m && month(m[1]!) > 0) return valid(fullYear(Number(m[3]), now), month(m[1]!), Number(m[2]), now);
  // "2 Mar 2024", "2-Mar-2024", "02MAR24"
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]*([a-z]{3,9})\.?[\s,-]*(\d{4}|\d{2})\b/i.exec(text);
  if (m && month(m[2]!) > 0) return valid(fullYear(Number(m[3]), now), month(m[2]!), Number(m[1]), now);
  return null;
}

/** A number such as a quantity or hours: 2, "2", "2.5", "x2". Null when absent or not positive. */
export function parseQuantity(v: unknown): number | null {
  if (typeof v === "string") v = Number(v.replace(/^[x×]\s*/i, "").replace(",", ".").trim());
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 1000) / 1000;
}

/** A model's confidence in whatever form it chose: 0.9, 90, "0.9", "high". */
export function parseConfidence(v: unknown): number | null {
  if (typeof v === "string") {
    const word = v.trim().toLowerCase();
    if (word === "high") return 0.9;
    if (word === "medium") return 0.6;
    if (word === "low") return 0.3;
    v = Number(word.replace(/%$/, ""));
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  if (v > 1 && v <= 100) return Math.round(v) / 100;
  return v <= 1 ? Math.round(v * 100) / 100 : null;
}

/** Uppercase letters and digits only, for comparing serials and model numbers as printed. */
export const squash = (s: string | null | undefined): string => (s ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");

/** Add whole months to a YYYY-MM-DD date, clamping to the end of a shorter month. */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

/** Today in UTC as YYYY-MM-DD. */
export const today = (now = new Date()): string => now.toISOString().slice(0, 10);

/**
 * The latest date that is not in the future somewhere: tomorrow in UTC. A
 * person east of UTC is already on tomorrow's date while UTC is not, and
 * their "today" must not be refused as a future date.
 */
export const latestDay = (now = new Date()): string => today(new Date(now.getTime() + 86_400_000));

/** Whole days from one YYYY-MM-DD date to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
