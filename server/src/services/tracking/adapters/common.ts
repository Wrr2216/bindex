import type { NormalizedRead } from "../types";

/**
 * Adapters are pure functions from a vendor payload to normalized reads. They
 * tolerate fields they do not know, skip events that are not tag reads
 * (heartbeats, GPI changes), and throw AdapterError for a payload that is not
 * the expected shape at all, which the route turns into a 400.
 */

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export type ParsedPayload = {
  /** The reader's own name for itself, used to map INGEST_TOKEN posts to a device. */
  readerId?: string;
  /** Battery level the device reported, 0 to 100. */
  batteryPct?: number;
  reads: NormalizedRead[];
  /** Events in the payload that were understood but are not tag reads. */
  skipped: number;
};

/** A request carrying more reads than this should be split by the sender. */
export const MAX_READS_PER_REQUEST = 50_000;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * JSON arrives already parsed from an application/json post, as text from a
 * device that labels it text/plain, or as newline-delimited JSON from a stream.
 */
export function parseJsonBody(body: unknown, expected: string): unknown {
  if (typeof body !== "string") return body;
  const text = body.trim();
  if (!text) throw new AdapterError(`Empty body. Expected ${expected}.`);
  try {
    return JSON.parse(text);
  } catch {
    // Newline-delimited JSON: one event per line.
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    try {
      return lines.map((l) => JSON.parse(l) as unknown);
    } catch {
      throw new AdapterError(`Body is not JSON. Expected ${expected}.`);
    }
  }
}

export function checkSize(count: number): void {
  if (count > MAX_READS_PER_REQUEST) {
    throw new AdapterError(
      `Too many reads in one request (${count}); send at most ${MAX_READS_PER_REQUEST} at a time.`,
    );
  }
}

/** Drop undefined and null values so stored meta stays small. */
export function compactMeta(meta: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return Object.keys(out).length ? out : null;
}
