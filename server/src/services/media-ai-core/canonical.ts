import { createHash } from "node:crypto";

/**
 * Canonical JSON, so that "the same content" always hashes the same way.
 *
 * Object keys are sorted by UTF-16 code unit and there is no whitespace, which
 * is the JSON Canonicalization Scheme (RFC 8785) for everything a record holds:
 * strings and numbers are written exactly as JSON.stringify writes them, which
 * is what that scheme specifies. Values JSON cannot carry follow
 * JSON.stringify's rules (undefined properties are dropped, non-finite numbers
 * become null, toJSON is honoured, so a Date becomes its ISO string), which
 * means content that has made a round trip through the API hashes the same as
 * the original.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new Set());
}

function write(value: unknown, seen: Set<object>): string {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("canonicalJson cannot represent a bigint; convert it to a string first.");
    case "object":
      break;
    default:
      // undefined, functions and symbols have no JSON form.
      return "null";
  }

  const obj = value as object;
  if (seen.has(obj)) throw new TypeError("canonicalJson cannot represent a circular structure.");
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((v) => write(v, seen)).join(",")}]`;
    }
    const entries = Object.keys(obj)
      .sort()
      .flatMap((key) => {
        const v = (obj as Record<string, unknown>)[key];
        if (v === undefined || typeof v === "function" || typeof v === "symbol") return [];
        return [`${JSON.stringify(key)}:${write(v, seen)}`];
      });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Hex sha256 of the canonical JSON of `value`. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
