import { randomUUID } from "node:crypto";
import { median } from "./presence";

/**
 * "Calibrate zone": leave a tag in a room for a minute, record what every
 * gateway hears, and see whether the presence engine would put the tag in
 * that room, by how much, and what gateway offset would fix it if not.
 *
 * Gateways differ: one is behind a shelf, another has a better antenna, a
 * third hangs in a doorway. A per-gateway RSSI offset (dB added to everything
 * that gateway reports) evens them out. The summary below is pure; sessions
 * live in memory for an hour, which is all a calibration walk needs.
 */

export type CalibrationGateway = { id: string; name: string; zoneId: string | null; offset: number };

export type GatewayReading = {
  gatewayId: string;
  name: string;
  zoneId: string | null;
  offset: number;
  samples: number;
  /** Median of what the gateway reported, dBm. */
  medianRaw: number | null;
  /** The same with its offset, which is what the engine compares. */
  medianAdjusted: number | null;
  min: number | null;
  max: number | null;
  /** Standard deviation: how noisy this gateway is for this spot. */
  spread: number | null;
};

export type OffsetSuggestion = {
  gatewayId: string;
  name: string;
  currentOffset: number;
  suggestedOffset: number;
};

export type CalibrationSummary = {
  targetZoneId: string;
  /** The zone the engine would pick from these readings. */
  winnerZoneId: string | null;
  /** Best target-zone signal minus the best other zone's, dB. Null when either is unheard. */
  margin: number | null;
  /** The target wins by at least the hysteresis margin. */
  ok: boolean;
  gateways: GatewayReading[];
  suggestions: OffsetSuggestion[];
  notes: string[];
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function summarizeCalibration(
  samples: ReadonlyMap<string, readonly number[]>,
  gateways: readonly CalibrationGateway[],
  targetZoneId: string,
  hysteresisDb: number,
): CalibrationSummary {
  const readings: GatewayReading[] = [];
  const byId = new Map(gateways.map((g) => [g.id, g]));
  for (const [gatewayId, values] of samples) {
    const g = byId.get(gatewayId) ?? { id: gatewayId, name: "Unknown gateway", zoneId: null, offset: 0 };
    if (!values.length) continue;
    const med = median(values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    readings.push({
      gatewayId,
      name: g.name,
      zoneId: g.zoneId,
      offset: g.offset,
      samples: values.length,
      medianRaw: round1(med),
      medianAdjusted: round1(med + g.offset),
      min: Math.min(...values),
      max: Math.max(...values),
      spread: round1(Math.sqrt(variance)),
    });
  }
  readings.sort((a, b) => (b.medianAdjusted ?? -Infinity) - (a.medianAdjusted ?? -Infinity));

  const zoned = readings.filter((r) => r.zoneId && r.medianAdjusted !== null);
  const target = zoned.find((r) => r.zoneId === targetZoneId) ?? null;
  const other = zoned.find((r) => r.zoneId !== targetZoneId) ?? null;
  const winnerZoneId = zoned[0]?.zoneId ?? null;
  const margin = target && other ? round1(target.medianAdjusted! - other.medianAdjusted!) : null;
  const ok = !!target && (other === null || margin! >= hysteresisDb);

  const notes: string[] = [];
  const suggestions: OffsetSuggestion[] = [];
  if (!readings.length) {
    notes.push("No gateway heard the tag. Check that it is switched on and registered, and that a gateway is in range.");
  } else if (!target) {
    const inZone = gateways.some((g) => g.zoneId === targetZoneId);
    notes.push(
      inZone
        ? "The gateway in this room did not hear the tag. Move it closer or check that it is reporting."
        : "No gateway is installed in this room, so nothing can place a tag here. Add one, or give an existing gateway this zone.",
    );
  } else if (!ok && other) {
    // Enough to win by the hysteresis margin, plus one dB of headroom.
    const needed = Math.ceil(other.medianAdjusted! - target.medianAdjusted! + hysteresisDb + 1);
    suggestions.push({
      gatewayId: target.gatewayId,
      name: target.name,
      currentOffset: target.offset,
      suggestedOffset: target.offset + needed,
    });
    notes.push(
      `${other.name} hears the tag ${Math.abs(margin!)} dB ${margin! < 0 ? "better" : "less well"} than ${target.name}, which is not enough for this room to win by ${hysteresisDb} dB.`,
    );
    notes.push(
      "Raising a gateway's offset also makes it win more often next door. After changing it, calibrate the neighbouring room too, or move the gateway instead.",
    );
  }
  if (target && target.spread !== null && target.spread > 8) {
    notes.push(`${target.name} is noisy here (±${target.spread} dB). Readings through people, metal or water swing widely.`);
  }
  return { targetZoneId, winnerZoneId, margin, ok, gateways: readings, suggestions, notes };
}

export type CalibrationSession = {
  id: string;
  tagKey: string;
  tagName: string;
  locationId: string;
  startedAt: number;
  endsAt: number;
  samples: Map<string, number[]>;
};

/** At most this many readings per gateway per session. */
const MAX_PER_GATEWAY = 2000;
/** Sessions are forgotten this long after they end. */
const KEEP_MS = 60 * 60_000;

export class CalibrationStore {
  private sessions = new Map<string, CalibrationSession>();

  start(input: { tagKey: string; tagName: string; locationId: string; durationMs: number }, now = Date.now()) {
    this.sweep(now);
    const session: CalibrationSession = {
      id: randomUUID(),
      tagKey: input.tagKey,
      tagName: input.tagName,
      locationId: input.locationId,
      startedAt: now,
      endsAt: now + input.durationMs,
      samples: new Map(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Whether any session is recording, so ingest can skip the lookup when none is. */
  get active(): boolean {
    const now = Date.now();
    for (const s of this.sessions.values()) if (s.endsAt > now) return true;
    return false;
  }

  /** A raw reading (before offset) of a tag by a gateway. */
  feed(tagKey: string, gatewayId: string, rssi: number, at: number): void {
    for (const s of this.sessions.values()) {
      if (s.tagKey !== tagKey || at < s.startedAt || at > s.endsAt) continue;
      const list = s.samples.get(gatewayId) ?? [];
      if (list.length < MAX_PER_GATEWAY) list.push(rssi);
      s.samples.set(gatewayId, list);
    }
  }

  get(id: string): CalibrationSession | undefined {
    return this.sessions.get(id);
  }

  stop(id: string, now = Date.now()): CalibrationSession | undefined {
    const s = this.sessions.get(id);
    if (s && s.endsAt > now) s.endsAt = now;
    return s;
  }

  cancel(id: string): boolean {
    return this.sessions.delete(id);
  }

  private sweep(now: number): void {
    for (const [id, s] of this.sessions) if (s.endsAt + KEEP_MS < now) this.sessions.delete(id);
  }
}
