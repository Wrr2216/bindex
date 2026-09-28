import { createHash } from "node:crypto";

/**
 * The exact text an audit_log row is hashed over, reproduced outside the
 * database so an exported log can be checked by anyone holding the file.
 *
 * The database is the authority: the chaining trigger computes
 * sha256(prev_hash || audit_log_canonical(row)) in migration 0025. This module
 * is its twin and must render byte-for-byte the same text. It deliberately
 * imports nothing from the rest of the server, so the offline verifier can run
 * without a database or an environment.
 */

/** prev_hash of the first row of a log that has never been archived. */
export const GENESIS_HASH = "0".repeat(64);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Postgres renders numeric without an exponent. JavaScript switches to one
 * below 1e-6 and from 1e21 up, so those are expanded to plain digits the way
 * numeric_out would print them. Every number in the log was written by
 * JSON.stringify, so its shortest round-trip digits are what Postgres parsed.
 */
export function pgNumber(n: number): string {
  if (!Number.isFinite(n)) return "null";
  const text = String(n);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, intPart, fracPart = "", expText] = match;
  const exp = Number(expText);
  const digits = intPart! + fracPart;
  // Position of the decimal point within `digits` after applying the exponent.
  const point = intPart!.length + exp;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * jsonb stores object keys shortest first, then by their UTF-8 bytes, and
 * prints them in that order.
 */
function compareKeys(a: string, b: string): number {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return ab.length - bb.length;
  return Buffer.compare(ab, bb);
}

/**
 * The text Postgres produces for `value::jsonb::text`. For the strings the
 * log can hold (no NUL, no lone surrogates: sanitizeEventData removes both)
 * JSON.stringify escapes exactly as Postgres's escape_json does.
 */
export function pgJsonbText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return pgNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pgJsonbText).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareKeys(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pgJsonbText(v)}`).join(", ")}}`;
  }
  return "null";
}

/** The fields of a row that the hash covers, in the shape an export carries. */
export type ChainRow = {
  id: number;
  /** ISO 8601 in UTC with milliseconds, as Date.prototype.toISOString gives. */
  occurredAt: string;
  actor: { kind: string; id: string | null; name: string | null };
  type: string;
  subject: { type: string; id: string } | null;
  data: unknown;
  prevHash: string;
  hash: string;
};

/** Twin of audit_log_canonical() in migration 0025. */
export function canonicalText(row: Omit<ChainRow, "prevHash" | "hash">): string {
  return pgJsonbText([
    row.id,
    row.occurredAt,
    row.actor.kind,
    row.actor.id,
    row.actor.name,
    row.type,
    row.subject?.type ?? null,
    row.subject?.id ?? null,
    row.data as Json,
  ]);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** What the trigger stores in `hash` for this row. */
export function computeRowHash(row: Omit<ChainRow, "hash">): string {
  return sha256Hex(row.prevHash + canonicalText(row));
}

export type ExportCheck = {
  ok: boolean;
  rows: number;
  /** Adjacent pairs proven to be linked (prev_hash equals the hash before). */
  links: number;
  /**
   * Adjacent pairs that are not linked, with ids far enough apart that rows
   * between them are simply absent from the file. Expected in a filtered
   * export; in a full export it means rows are missing.
   */
  gaps: number;
  /** True when the first row starts a log that was never archived. */
  startsAtGenesis: boolean;
  firstBadId: number | null;
  reason: string | null;
};

/**
 * Checks rows from an export one at a time, in id order, so a large file never
 * has to be held in memory. Every row's own hash is checked, so a filtered
 * export still proves each row it contains; adjacent rows are also checked
 * for their link, so a full export proves the whole chain.
 */
export class ExportChecker {
  private result: ExportCheck = {
    ok: true,
    rows: 0,
    links: 0,
    gaps: 0,
    startsAtGenesis: false,
    firstBadId: null,
    reason: null,
  };
  private prev: ChainRow | null = null;

  /** Returns false once a row fails; later rows are ignored. */
  push(row: ChainRow): boolean {
    const r = this.result;
    if (!r.ok) return false;
    r.rows += 1;
    const prev = this.prev;
    if (!prev) r.startsAtGenesis = row.prevHash === GENESIS_HASH;
    if (prev && row.id <= prev.id) return this.fail(row.id, "rows are not in ascending id order");
    if (computeRowHash(row) !== row.hash) return this.fail(row.id, "row content does not match its hash");
    if (prev) {
      if (row.prevHash === prev.hash) r.links += 1;
      // Ids come from a sequence, which can skip a value, so only a pair one
      // apart is certain to have nothing between them.
      else if (row.id === prev.id + 1) return this.fail(row.id, "prev_hash does not match the row before it");
      else r.gaps += 1;
    }
    this.prev = row;
    return true;
  }

  finish(): ExportCheck {
    return { ...this.result };
  }

  private fail(id: number, reason: string): false {
    this.result = { ...this.result, ok: false, firstBadId: id, reason };
    return false;
  }
}

export function checkExportedRows(rows: Iterable<ChainRow>): ExportCheck {
  const checker = new ExportChecker();
  for (const row of rows) if (!checker.push(row)) break;
  return checker.finish();
}
