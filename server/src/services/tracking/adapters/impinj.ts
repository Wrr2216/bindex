import { base64ToHex, finiteOrNull, intOrNull, parseTimestamp } from "../normalize";
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
  'Impinj IoT device interface events: { "timestamp", "hostname", "eventType": "tagInventory", "tagInventoryEvent": { "epcHex", "antennaPort", "peakRssiCdbm" } }, as an array, one object or newline-delimited JSON';

/**
 * Impinj R700 (and R660/R720) IoT device interface. The webhook output posts a
 * JSON array of events; the HTTP stream is newline-delimited JSON of the same
 * events, which a relay can forward here unchanged. A tag read is
 *
 *   { "timestamp": "2023-01-01T00:00:00.123Z", "hostname": "impinj-14-2b-3c",
 *     "eventType": "tagInventory",
 *     "tagInventoryEvent": { "epc": "4oARcGAAAgjkUSnD", "epcHex": "E28011706000020...",
 *       "antennaPort": 1, "antennaName": "Antenna 1", "peakRssiCdbm": -5400,
 *       "frequency": 915250, "transmitPowerCdbm": 3000,
 *       "lastSeenTime": "2023-01-01T00:00:00.100Z" } }
 *
 * RSSI arrives in centi-dBm. Other event types (inventory status, GPI,
 * keepalives) are skipped. Built from Impinj's documentation; not yet verified
 * on hardware.
 */
export function parseImpinj(body: unknown): ParsedPayload {
  const payload = parseJsonBody(body, EXPECTED);
  let events: unknown[];
  if (Array.isArray(payload)) events = payload;
  else if (isRecord(payload) && Array.isArray(payload.events)) events = payload.events;
  else events = [payload];

  let recognised = 0;
  let skipped = 0;
  let readerId: string | undefined;
  const reads: NormalizedRead[] = [];

  for (const event of events) {
    if (!isRecord(event)) continue;
    const tag = event.tagInventoryEvent;
    if (!("eventType" in event) && !isRecord(tag)) continue;
    recognised += 1;
    readerId ??= nonEmptyString(event.hostname) ?? nonEmptyString(event.hostName);
    if (!isRecord(tag)) {
      skipped += 1;
      continue;
    }

    const epc =
      nonEmptyString(tag.epcHex) ?? (typeof tag.epc === "string" ? base64ToHex(tag.epc) : null);
    if (!epc) {
      skipped += 1;
      continue;
    }
    const cdbm = finiteOrNull(tag.peakRssiCdbm);
    reads.push({
      code: epc,
      observedAt: parseTimestamp(tag.lastSeenTime ?? event.timestamp),
      tech: "rfid",
      rssi: cdbm === null ? null : cdbm / 100,
      antenna: intOrNull(tag.antennaPort),
      meta: compactMeta({
        vendor: "impinj",
        antennaName: nonEmptyString(tag.antennaName),
        frequencyKhz: finiteOrNull(tag.frequency),
        txPowerCdbm: finiteOrNull(tag.transmitPowerCdbm),
        phase: finiteOrNull(tag.phaseAngle),
        tid: nonEmptyString(tag.tidHex),
      }),
    });
  }

  if (!recognised) throw new AdapterError(`Unrecognised payload. Expected ${EXPECTED}.`);
  checkSize(reads.length);
  return { readerId, reads, skipped };
}
