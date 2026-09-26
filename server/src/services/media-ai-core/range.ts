/**
 * HTTP Range parsing (RFC 9110, section 14) for serving attachments.
 *
 * Only single byte ranges are honoured. That is all a video element ever asks
 * for when it seeks, and the RFC lets a server answer anything else with the
 * whole file, so a multi-range or malformed header is simply ignored.
 */

/** Inclusive byte offsets, as they appear in Content-Range. */
export type ByteRange = { start: number; end: number };

/**
 * - `null`: no usable Range header; send the whole file with 200.
 * - `"unsatisfiable"`: a valid range that lies outside the file; send 416.
 * - otherwise the bytes to send with 206.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return null;
  const spec = m[1]!.trim();
  if (spec.includes(",")) return null;

  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!parts) return null;
  const [, first, last] = parts;
  if (!first && !last) return null;

  if (!first) {
    // Suffix range: the final N bytes.
    const n = Number(last);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(first);
  const end = last ? Number(last) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (last && end < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}
