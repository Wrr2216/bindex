import type { PortalSide, SightingDirection } from "./types";

/**
 * Which way a tag went through a portal (a dock door or doorway with antennas
 * on both sides), from the antennas that read it.
 *
 * The rule is the one most portal installs use: the side a tag was first seen
 * on, compared with the side it was last seen on, within one pass. First
 * outside and last inside is "in"; the reverse is "out"; the same side on both
 * ends (a tag that approached and turned back, or one parked next to the door)
 * has no direction. A pass is a run of reads where no two consecutive reads are
 * further apart than the window. A pass that runs longer than MAX_PASS_MS
 * (a pallet parked in the doorway) is re-anchored at the tag's latest read, so
 * the side it arrived from an hour ago no longer counts as where it started
 * and carrying it out still reads as "out". When several antennas see a tag at
 * the same instant, the strongest read decides the side.
 *
 * inferDirection is the reference over a complete list of reads. PortalTracker
 * computes the same thing incrementally, as reads arrive in batches over HTTP,
 * without keeping them.
 */

export type PortalRead = {
  antenna: number | null | undefined;
  /** Epoch milliseconds. */
  at: number;
  rssi?: number | null;
};

/** Antenna port (as a string key, like the stored settings) to side. */
export type AntennaSides = Record<string, PortalSide>;

/** How far apart two reads of a tag can be and still belong to one pass. */
export const DEFAULT_PORTAL_WINDOW_MS = 3_000;

/** How long a pass can run before its start moves up to the latest read. */
export const MAX_PASS_MS = 60_000;

export function sideOf(antenna: number | null | undefined, sides: AntennaSides): PortalSide | null {
  if (antenna === null || antenna === undefined) return null;
  return sides[String(antenna)] ?? null;
}

/** Direction implied by the first and last side of a pass. */
export function directionBetween(first: PortalSide, last: PortalSide): SightingDirection | null {
  if (first === last) return null;
  return first === "outside" ? "in" : "out";
}

type Sided = PortalRead & { side: PortalSide };

const strength = (r: PortalRead) => (typeof r.rssi === "number" ? r.rssi : -Infinity);

/**
 * Split reads into passes. Reads from antennas with no side are ignored. Input
 * order breaks ties between reads with the same timestamp.
 */
export function splitPasses(
  reads: readonly PortalRead[],
  sides: AntennaSides,
  windowMs = DEFAULT_PORTAL_WINDOW_MS,
): { reads: Sided[]; direction: SightingDirection | null }[] {
  const sided: Sided[] = [];
  for (const r of reads) {
    const side = sideOf(r.antenna, sides);
    if (side) sided.push({ ...r, side });
  }
  // Array.prototype.sort is stable, which keeps input order for equal times.
  sided.sort((a, b) => a.at - b.at);

  const passes: Sided[][] = [];
  for (const r of sided) {
    const current = passes[passes.length - 1];
    const prev = current?.[current.length - 1];
    if (!current || !prev || r.at - prev.at > windowMs) {
      passes.push([r]);
    } else if (r.at - current[0]!.at > MAX_PASS_MS) {
      // Too long: carry on from where the tag was last seen.
      passes.push([lastOf(current), r]);
    } else {
      current.push(r);
    }
  }
  return passes.map((pass) => ({ reads: pass, direction: passDirection(pass) }));
}

// The strongest read at each end of a pass. Among equals, the earliest input
// wins at the start and the latest at the end, which is what the incremental
// tracker does.
function firstOf(pass: Sided[]): Sided {
  const at = pass[0]!.at;
  let first = pass[0]!;
  for (const r of pass) if (r.at === at && strength(r) > strength(first)) first = r;
  return first;
}

function lastOf(pass: Sided[]): Sided {
  const at = pass[pass.length - 1]!.at;
  let last = pass[pass.length - 1]!;
  for (const r of pass) if (r.at === at && strength(r) >= strength(last)) last = r;
  return last;
}

function passDirection(pass: Sided[]): SightingDirection | null {
  if (!pass.length) return null;
  return directionBetween(firstOf(pass).side, lastOf(pass).side);
}

/**
 * Direction of the pass in progress at the latest read, or null. A read from
 * an antenna with no side cannot extend a pass, but it can come after one has
 * ended, in which case there is no pass in progress.
 */
export function inferDirection(
  reads: readonly PortalRead[],
  sides: AntennaSides,
  windowMs = DEFAULT_PORTAL_WINDOW_MS,
): SightingDirection | null {
  const passes = splitPasses(reads, sides, windowMs);
  const current = passes[passes.length - 1];
  if (!current) return null;
  const passEnd = current.reads[current.reads.length - 1]!.at;
  const latest = reads.reduce((max, r) => Math.max(max, r.at), -Infinity);
  return latest - passEnd <= windowMs ? current.direction : null;
}

type Pass = {
  firstAt: number;
  firstSide: PortalSide;
  firstRssi: number;
  lastAt: number;
  lastSide: PortalSide;
  lastRssi: number;
};

/**
 * The incremental form of inferDirection, holding only the two ends of each
 * tag's current pass. Keyed by whatever the caller chooses (device id and
 * code). Bounded: the least recently seen tags are forgotten first.
 */
export class PortalTracker {
  private passes = new Map<string, Pass>();

  constructor(private readonly maxEntries = 100_000) {}

  /** Feed one read; returns the direction of the pass it belongs to so far. */
  observe(
    key: string,
    read: PortalRead,
    sides: AntennaSides,
    windowMs = DEFAULT_PORTAL_WINDOW_MS,
  ): SightingDirection | null {
    const side = sideOf(read.antenna, sides);
    let pass = this.passes.get(key);
    if (!side) {
      return pass && read.at - pass.lastAt <= windowMs
        ? directionBetween(pass.firstSide, pass.lastSide)
        : null;
    }

    const rssi = strength(read);
    if (!pass || read.at - pass.lastAt > windowMs) {
      pass = { firstAt: read.at, firstSide: side, firstRssi: rssi, lastAt: read.at, lastSide: side, lastRssi: rssi };
    } else {
      if (read.at - pass.firstAt > MAX_PASS_MS) {
        pass.firstAt = pass.lastAt;
        pass.firstSide = pass.lastSide;
        pass.firstRssi = pass.lastRssi;
      }
      if (read.at > pass.lastAt || (read.at === pass.lastAt && rssi >= pass.lastRssi)) {
        pass.lastAt = read.at;
        pass.lastSide = side;
        pass.lastRssi = rssi;
      }
      // A late read from the start of the pass, or a stronger one at the start.
      if (read.at < pass.firstAt || (read.at === pass.firstAt && rssi > pass.firstRssi)) {
        pass.firstAt = read.at;
        pass.firstSide = side;
        pass.firstRssi = rssi;
      }
    }

    // Re-insert so Map order tracks recency for eviction.
    this.passes.delete(key);
    this.passes.set(key, pass);
    if (this.passes.size > this.maxEntries) {
      const oldest = this.passes.keys().next().value;
      if (oldest !== undefined) this.passes.delete(oldest);
    }
    return directionBetween(pass.firstSide, pass.lastSide);
  }

  /** Forget passes that ended more than `windowMs` before `now`. */
  sweep(now: number, windowMs = DEFAULT_PORTAL_WINDOW_MS): void {
    for (const [key, pass] of this.passes) if (now - pass.lastAt > windowMs) this.passes.delete(key);
  }

  clear(): void {
    this.passes.clear();
  }

  get size(): number {
    return this.passes.size;
  }
}
