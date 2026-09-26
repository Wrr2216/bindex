import { finiteOrNull, intOrNull, parseTimestamp } from "../normalize";
import type { NormalizedRead } from "../types";
import {
  AdapterError,
  checkSize,
  compactMeta,
  isRecord,
  nonEmptyString,
  parseJsonBody,
  type ParsedPayload,
} from "./common";

const EXPECTED =
  'Zebra IoT Connector tag data events: { "data": { "idHex", "antenna", "peakRssi" }, "timestamp", "type" }, one object or an array';

/**
 * Zebra FX7500 / FX9600 / ATR7000 through the IoT Connector's HTTP POST
 * endpoint, JSON data format. Each tag data event looks like
 *
 *   { "data": { "eventNum": 1, "format": "epc", "idHex": "e28011...",
 *               "antenna": 1, "peakRssi": -54, "reads": 1, "channel": 922.25 },
 *     "timestamp": "2022-03-22T19:00:00.123+0000", "type": "SIMPLE" }
 *
 * and a post carries one event or an array of them (batching on). Heartbeats
 * and GPI events are skipped. Built from Zebra's documentation; not yet
 * verified on hardware.
 */
export function parseZebra(body: unknown): ParsedPayload {
  const payload = parseJsonBody(body, EXPECTED);
  const events = Array.isArray(payload) ? payload : [payload];
  if (!events.length) return { reads: [], skipped: 0 };

  let recognised = 0;
  let skipped = 0;
  let readerId: string | undefined;
  const reads: NormalizedRead[] = [];

  for (const event of events) {
    if (!isRecord(event)) continue;
    readerId ??= nonEmptyString(event.hostName) ?? nonEmptyString(event.hostname);
    if (!("data" in event) && !("type" in event)) continue;
    recognised += 1;

    // Batched deliveries have been seen with `data` as a list of tag records.
    const records = Array.isArray(event.data) ? event.data : [event.data];
    for (const data of records) {
      if (isRecord(data)) readerId ??= nonEmptyString(data.hostName) ?? nonEmptyString(data.hostname);
      if (!isRecord(data) || typeof data.idHex !== "string" || !data.idHex.trim()) {
        skipped += 1;
        continue;
      }
      reads.push({
        code: data.idHex,
        observedAt: parseTimestamp(data.timestamp ?? event.timestamp),
        tech: "rfid",
        rssi: finiteOrNull(data.peakRssi),
        antenna: intOrNull(data.antenna),
        meta: compactMeta({
          vendor: "zebra",
          format: nonEmptyString(data.format),
          reads: intOrNull(data.reads),
          channel: finiteOrNull(data.channel),
          phase: finiteOrNull(data.phase),
          tid: nonEmptyString(data.tid) ?? nonEmptyString(data.tidHex),
          eventNum: intOrNull(data.eventNum),
        }),
      });
    }
  }

  if (!recognised) throw new AdapterError(`Unrecognised payload. Expected ${EXPECTED}.`);
  checkSize(reads.length);
  return { readerId, reads, skipped };
}
