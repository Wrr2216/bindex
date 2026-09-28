/**
 * Turning register cells into comparable values. Pure: no database, no
 * configuration, so every rule here is unit-tested directly.
 */

/** Asset tags and serials compare case-insensitively, ignoring outer spaces. */
export function normKey(value: string | null | undefined): string | null {
  const v = value?.trim().replace(/\s+/g, " ").toUpperCase();
  return v ? v : null;
}

/**
 * EPCs are hex; readers and spreadsheets add separators and change case.
 * Anything that is not hex after removing separators is kept as typed
 * (uppercased), because some "RFID" columns hold a tag's printed number.
 */
export function normalizeEpc(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  const stripped = v.replace(/[\s:\-]/g, "").toUpperCase();
  const withoutPrefix = stripped.startsWith("0X") ? stripped.slice(2) : stripped;
  if (/^[0-9A-F]+$/.test(withoutPrefix)) return withoutPrefix;
  return v.toUpperCase();
}

/** Free text such as a model number, compared loosely. */
export function normText(value: string | null | undefined): string | null {
  const v = value?.toLowerCase().replace(/[\s\-_.]+/g, "").trim();
  return v ? v : null;
}

/**
 * A location as text: separators `/`, `>`, `\` and `|` all mean "inside",
 * whitespace and case do not matter. "Warehouse > Aisle 3" and
 * "warehouse / aisle 3" are the same place.
 */
export function normalizeLocationText(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value
    .split(/\s*[/>\\|]\s*/)
    .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

export type Parsed<T> = { value: T | null; issue?: string };

/**
 * Money in whatever shape a register writes it, to integer cents: "1299",
 * "$1,299.00", "1.299,00 €", "(45.10)", "USD 12". When both `.` and `,`
 * appear, the last one is the decimal point. A lone `,` followed by one or
 * two digits is a decimal comma; followed by three it is a thousands
 * separator.
 */
export function parseCost(raw: string | number | null | undefined): Parsed<number> {
  if (raw == null) return { value: null };
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { value: Math.round(raw * 100) } : { value: null };
  }
  const text = raw.trim();
  if (!text) return { value: null };
  let negative = false;
  let s = text;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.,\-]/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/\d/.test(s) || s.includes("-")) return { value: null, issue: `"${text}" is not an amount` };

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    normalized =
      lastDot > lastComma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    const commas = s.split(",").length - 1;
    normalized = commas === 1 && decimals <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const dots = s.split(".").length - 1;
    // "1.299.000" is thousands; "1.5" and "1299.99" are decimals.
    normalized = dots > 1 ? s.replace(/\./g, "") : s;
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return { value: null, issue: `"${text}" is not an amount` };
  const cents = Math.round(n * 100);
  return { value: negative ? -cents : cents };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A purchase or acquisition date, to YYYY-MM-DD. Accepts ISO dates (with or
 * without a time), Excel serial day numbers, "12 Mar 2023" / "Mar 12, 2023",
 * and numeric dates with `/`, `.` or `-`. A numeric date is read day-first
 * when `dayFirst` is set (anywhere outside the US), unless one part can only
 * be a day.
 */
export function parseDate(
  raw: string | number | Date | null | undefined,
  dayFirst = false,
): Parsed<string> {
  if (raw == null) return { value: null };
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { value: null };
    return { value: isoDate(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate()) };
  }
  const text = String(raw).trim();
  if (!text) return { value: null };
  const bad: Parsed<string> = { value: null, issue: `"${text}" is not a date` };

  // Excel stores dates as days since 1899-12-30. The range keeps ordinary
  // numbers (a cost, a quantity) from being mistaken for one.
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    if (serial >= 20000 && serial <= 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return { value: isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) };
    }
    return bad;
  }

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (m) {
    const value = isoDate(+m[1]!, +m[2]!, +m[3]!);
    return value ? { value } : bad;
  }

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s.*)?$/.exec(text);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = +m[3]!;
    let day: number;
    let month: number;
    if (a > 12) [day, month] = [a, b];
    else if (b > 12) [month, day] = [a, b];
    else if (dayFirst) [day, month] = [a, b];
    else [month, day] = [a, b];
    const value = isoDate(y, month, day);
    return value ? { value } : bad;
  }

  m = /^(\d{1,2})[\s-]+([a-z]{3,9})\.?[\s,-]+(\d{2,4})$/i.exec(text);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase().slice(0, m[2]!.toLowerCase().startsWith("sept") ? 4 : 3)];
    const value = month ? isoDate(+m[3]!, month, +m[1]!) : null;
    return value ? { value } : bad;
  }
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/i.exec(text);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase().slice(0, m[1]!.toLowerCase().startsWith("sept") ? 4 : 3)];
    const value = month ? isoDate(+m[3]!, month, +m[2]!) : null;
    return value ? { value } : bad;
  }
  return bad;
}

/** A positive whole quantity, or nothing. */
export function parseQuantity(raw: string | number | null | undefined): Parsed<number> {
  if (raw == null) return { value: null };
  const text = String(raw).trim();
  if (!text) return { value: null };
  const n = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return { value: null, issue: `"${text}" is not a whole quantity` };
  }
  return { value: n };
}

/** Headers compared by letters and digits only: "Serial No." and "serial_no" agree. */
export function headerKey(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}
