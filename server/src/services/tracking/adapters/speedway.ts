import { finiteOrNull, intOrNull, parseTimestamp } from "../normalize";
import type { NormalizedRead } from "../types";
import { AdapterError, checkSize, compactMeta, isRecord, type ParsedPayload } from "./common";

const EXPECTED =
  "a Speedway Connect HTTP POST: form fields reader_name, mac_address, field_names and field_values (one tag per line)";

/**
 * Impinj Speedway Connect (R420/R220 and the R700 running it) in HTTP POST
 * mode. Each post is form-encoded:
 *
 *   reader_name=SpeedwayR-10-EF-18&mac_address=00:16:25:10:EF:18
 *   &line_ending=%0A&field_delim=%2C
 *   &field_names=antenna_port,epc,first_seen_timestamp,peak_rssi
 *   &field_values=1,"E2801160600002084E8B2BCB",1403622454519542,-44%0A2,...
 *
 * Timestamps are microseconds since the epoch. Values may be quoted. Built from
 * Impinj's documentation; not yet verified on hardware.
 */
export function parseSpeedwayConnect(body: unknown): ParsedPayload {
  const form = toForm(body);
  const fieldNames = form.get("field_names");
  const fieldValues = form.get("field_values");
  if (fieldNames === undefined || fieldValues === undefined) {
    throw new AdapterError(`Missing field_names or field_values. Expected ${EXPECTED}.`);
  }

  const delim = form.get("field_delim") || ",";
  const lineEnding = form.get("line_ending") || "\n";
  const names = splitLine(fieldNames.trim(), delim).map((n) => n.trim().toLowerCase());
  const epcAt = names.indexOf("epc");
  if (epcAt < 0) throw new AdapterError('field_names must include "epc". Enable the EPC field in Speedway Connect.');
  const col = (name: string) => names.indexOf(name);
  const antennaAt = col("antenna_port");
  const rssiAt = col("peak_rssi");
  const lastSeenAt = col("last_seen_timestamp");
  const firstSeenAt = col("first_seen_timestamp");
  const tidAt = col("tid");
  const countAt = col("tag_read_count");

  // Split on the declared line ending, and on bare newlines too: a proxy that
  // rewrites \r\n would otherwise glue every tag into one line.
  const lines = fieldValues
    .split(lineEnding)
    .flatMap((l) => l.split(/\r?\n/))
    .map((l) => l.trim())
    .filter(Boolean);
  checkSize(lines.length);

  const reads: NormalizedRead[] = [];
  let skipped = 0;
  for (const line of lines) {
    const values = splitLine(line, delim);
    const epc = values[epcAt]?.trim();
    if (!epc) {
      skipped += 1;
      continue;
    }
    const at = (i: number) => (i >= 0 ? values[i]?.trim() : undefined);
    reads.push({
      code: epc,
      observedAt: parseTimestamp(at(lastSeenAt) ?? at(firstSeenAt)),
      tech: "rfid",
      rssi: finiteOrNull(at(rssiAt)),
      antenna: intOrNull(at(antennaAt)),
      meta: compactMeta({
        vendor: "speedway-connect",
        tid: at(tidAt),
        reads: intOrNull(at(countAt)),
      }),
    });
  }

  return {
    readerId: form.get("reader_name") || form.get("mac_address") || undefined,
    reads,
    skipped,
  };
}

/** The form as a string map, whether Express parsed it or it arrived raw. */
function toForm(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof body === "string") {
    for (const [k, v] of new URLSearchParams(body)) out.set(k, v);
    return out;
  }
  if (isRecord(body)) {
    for (const [k, v] of Object.entries(body)) {
      const value = Array.isArray(v) ? v.join("\n") : v;
      if (typeof value === "string") out.set(k, value);
      else if (typeof value === "number") out.set(k, String(value));
    }
    return out;
  }
  throw new AdapterError(`Expected ${EXPECTED}.`);
}

/** Split one delimited line, honouring double quotes around a value. */
export function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (line.startsWith(delim, i)) {
      out.push(cur);
      cur = "";
      i += delim.length - 1;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
