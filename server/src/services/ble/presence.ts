/**
 * Room-level presence from Bluetooth signal strength.
 *
 * A tag is heard by several gateways at once, each installed in a zone, and
 * each reading is noisy: a person walking past, a door closing or a phone in
 * a pocket moves RSSI by 10 dB or more. Picking the strongest gateway on
 * every reading makes a tag flap between neighbouring rooms. So, per tag:
 *
 * 1. Keep the last `windowMs` of readings per gateway, after that gateway's
 *    calibration offset has been added by the caller.
 * 2. Smooth them: the median of the window (the default; a single spike
 *    cannot move it) or an exponentially weighted moving average.
 * 3. A zone scores the best smoothed signal among its gateways. Gateways with
 *    no zone, or fewer than `minSamples` readings in the window, do not count.
 * 4. The tag changes zone only when another zone beats its current one by
 *    `hysteresisDb`, and keeps beating it at every reading for `dwellMs`. A
 *    current zone that has gone silent (no readings in the window) is beaten
 *    by any zone. A tag with no zone yet takes the best one after `dwellMs`.
 *
 * Pure and synchronous: the caller feeds readings in and persists the zone
 * changes that come out. Time is whatever the readings say, so a test can
 * replay hours of readings in milliseconds. "Missing" (not heard for a
 * while) is decided from the database, not here, so it survives restarts and
 * works across replicas; see state.ts.
 */

export type PresenceConfig = {
  /** How long readings are kept per gateway. */
  windowMs: number;
  smoothing: "median" | "ewma";
  /** Weight of the newest reading in the moving average, 0 to 1. */
  ewmaAlpha: number;
  /** How much stronger (dB) a zone must be than the current one. */
  hysteresisDb: number;
  /** How long it must stay that much stronger. */
  dwellMs: number;
  /** Readings a gateway needs in the window before it counts. */
  minSamples: number;
};

export const DEFAULT_PRESENCE: PresenceConfig = {
  windowMs: 20_000,
  smoothing: "median",
  ewmaAlpha: 0.3,
  hysteresisDb: 6,
  dwellMs: 10_000,
  minSamples: 1,
};

export type ZoneChange = {
  tag: string;
  from: string | null;
  to: string;
  /** When the change was decided: the time of the reading that decided it. */
  at: number;
  /** The gateway that hears the tag best in its new zone. */
  gatewayId: string;
  /** That gateway's smoothed signal, dBm, offset included. */
  rssi: number;
  /** Every zone's score when the change was decided. */
  scores: Record<string, number>;
};

export type HeardBy = {
  gatewayId: string;
  zoneId: string | null;
  /** Smoothed, offset included. Null when the window has no readings left. */
  rssi: number | null;
  samples: number;
  lastAt: number;
};

export type PresenceSnapshot = {
  zoneId: string | null;
  since: number | null;
  /** A zone that is winning but has not yet won for long enough. */
  candidate: { zoneId: string; since: number } | null;
  lastAt: number;
  heard: HeardBy[];
};

type Sample = { at: number; rssi: number };
type Heard = { zoneId: string | null; samples: Sample[]; ewma: number | null; lastAt: number };
type TagState = {
  zoneId: string | null;
  since: number | null;
  candidate: { zoneId: string; since: number } | null;
  heard: Map<string, Heard>;
  lastAt: number;
};

/** A window holds at most this many readings per gateway, however fast it reports. */
const MAX_SAMPLES = 120;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export class PresenceEngine {
  private tags = new Map<string, TagState>();

  constructor(private readonly config: PresenceConfig = DEFAULT_PRESENCE) {}

  get size(): number {
    return this.tags.size;
  }

  has(tag: string): boolean {
    return this.tags.has(tag);
  }

  /**
   * Start a tag in a known zone, as persisted before a restart, so the first
   * readings after it do not count as a move.
   */
  seed(tag: string, zoneId: string | null, since: number | null): void {
    if (this.tags.has(tag)) return;
    this.tags.set(tag, { zoneId, since, candidate: null, heard: new Map(), lastAt: -Infinity });
  }

  /**
   * One reading of `tag` by `gatewayId` (installed in `zoneId`) at time `at`,
   * with `rssi` already offset for that gateway's calibration. Returns the
   * zone change it causes, if any.
   */
  observe(tag: string, gatewayId: string, zoneId: string | null, rssi: number, at: number): ZoneChange | null {
    if (!Number.isFinite(rssi) || !Number.isFinite(at)) return null;
    let st = this.tags.get(tag);
    if (!st) {
      st = { zoneId: null, since: null, candidate: null, heard: new Map(), lastAt: -Infinity };
      this.tags.set(tag, st);
    }
    // A reading older than the window is history, not presence.
    if (at < st.lastAt - this.config.windowMs) return null;

    let h = st.heard.get(gatewayId);
    if (!h) {
      h = { zoneId, samples: [], ewma: null, lastAt: -Infinity };
      st.heard.set(gatewayId, h);
    }
    // A gateway can be moved to another zone while it is reporting.
    h.zoneId = zoneId;
    this.prune(h, Math.max(st.lastAt, at));
    if (!h.samples.length) h.ewma = null;

    // Readings nearly always arrive in order; keep the window sorted when not.
    let i = h.samples.length;
    while (i > 0 && h.samples[i - 1]!.at > at) i--;
    h.samples.splice(i, 0, { at, rssi });
    if (h.samples.length > MAX_SAMPLES) h.samples.splice(0, h.samples.length - MAX_SAMPLES);
    if (at >= h.lastAt) {
      h.ewma = h.ewma === null ? rssi : this.config.ewmaAlpha * rssi + (1 - this.config.ewmaAlpha) * h.ewma;
      h.lastAt = at;
    }
    st.lastAt = Math.max(st.lastAt, at);
    return this.evaluate(tag, st, st.lastAt);
  }

  private prune(h: Heard, now: number): void {
    const cutoff = now - this.config.windowMs;
    let drop = 0;
    while (drop < h.samples.length && h.samples[drop]!.at < cutoff) drop++;
    if (drop) h.samples.splice(0, drop);
  }

  private smoothed(h: Heard): number | null {
    if (!h.samples.length) return null;
    return this.config.smoothing === "ewma" ? h.ewma : median(h.samples.map((s) => s.rssi));
  }

  /** The best smoothed signal per zone, and which gateway gives it. */
  private scores(st: TagState, now: number): Map<string, { rssi: number; gatewayId: string }> {
    const out = new Map<string, { rssi: number; gatewayId: string }>();
    for (const [gatewayId, h] of st.heard) {
      this.prune(h, now);
      if (!h.zoneId || h.samples.length < this.config.minSamples) continue;
      const rssi = this.smoothed(h);
      if (rssi === null) continue;
      const best = out.get(h.zoneId);
      if (!best || rssi > best.rssi) out.set(h.zoneId, { rssi, gatewayId });
    }
    return out;
  }

  private evaluate(tag: string, st: TagState, now: number): ZoneChange | null {
    const scores = this.scores(st, now);
    let best: { zoneId: string; rssi: number; gatewayId: string } | null = null;
    for (const [zoneId, s] of scores) if (!best || s.rssi > best.rssi) best = { zoneId, ...s };
    if (!best || best.zoneId === st.zoneId) {
      st.candidate = null;
      return null;
    }

    const current = st.zoneId ? scores.get(st.zoneId)?.rssi : undefined;
    const beats = current === undefined || best.rssi >= current + this.config.hysteresisDb;
    if (!beats) {
      st.candidate = null;
      return null;
    }
    if (!st.candidate || st.candidate.zoneId !== best.zoneId) st.candidate = { zoneId: best.zoneId, since: now };
    if (now - st.candidate.since < this.config.dwellMs) return null;

    const change: ZoneChange = {
      tag,
      from: st.zoneId,
      to: best.zoneId,
      at: now,
      gatewayId: best.gatewayId,
      rssi: best.rssi,
      scores: Object.fromEntries([...scores].map(([z, s]) => [z, Math.round(s.rssi * 10) / 10])),
    };
    st.zoneId = best.zoneId;
    st.since = now;
    st.candidate = null;
    return change;
  }

  /** What the engine currently believes about a tag, for display and calibration. */
  snapshot(tag: string, now?: number): PresenceSnapshot | null {
    const st = this.tags.get(tag);
    if (!st) return null;
    const at = now ?? st.lastAt;
    const heard: HeardBy[] = [];
    for (const [gatewayId, h] of st.heard) {
      const recent = h.samples.filter((s) => s.at >= at - this.config.windowMs);
      const rssi = recent.length
        ? this.config.smoothing === "ewma"
          ? h.ewma
          : median(recent.map((s) => s.rssi))
        : null;
      heard.push({ gatewayId, zoneId: h.zoneId, rssi, samples: recent.length, lastAt: h.lastAt });
    }
    heard.sort((a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity));
    return { zoneId: st.zoneId, since: st.since, candidate: st.candidate, lastAt: st.lastAt, heard };
  }

  /** The zone a tag is in, as far as the engine knows. */
  zoneOf(tag: string): string | null {
    return this.tags.get(tag)?.zoneId ?? null;
  }

  /** Forget tags not heard for `idleMs`, so memory follows the tags in range. */
  forgetIdle(now: number, idleMs: number): number {
    let n = 0;
    for (const [tag, st] of this.tags) {
      if (st.lastAt < now - idleMs) {
        this.tags.delete(tag);
        n++;
      }
    }
    return n;
  }

  /** Forget one tag, for example when its device is deleted. */
  forget(tag: string): void {
    this.tags.delete(tag);
  }

  clear(): void {
    this.tags.clear();
  }
}
