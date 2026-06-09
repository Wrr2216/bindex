/**
 * Live tag reads on their way from a reader bridge to a browser. The bridge
 * posts to /api/device/scan and the audit screen polls /api/audit/live. Reads
 * are bucketed per reader channel and numbered, so a poll can ask only for what
 * arrived since the last one.
 *
 * Held in memory on purpose. An audit is something someone is doing right now,
 * and a restart mid-walk should lose the buffer rather than resurrect it.
 */
type Entry = { seq: number; code: string };
type Channel = { seq: number; log: Entry[]; seen: Set<string>; updatedAt: number };

const channels = new Map<string, Channel>();
const CAP = 20_000; // max retained reads per channel
const IDLE_MS = 2 * 60 * 60 * 1000; // drop a channel after 2h idle

function prune(): void {
  const now = Date.now();
  for (const [id, c] of channels) if (now - c.updatedAt > IDLE_MS) channels.delete(id);
}

function channel(id: string): Channel {
  let c = channels.get(id);
  if (!c) {
    c = { seq: 0, log: [], seen: new Set(), updatedAt: Date.now() };
    channels.set(id, c);
  }
  return c;
}

/** Append newly-seen codes to a channel; returns how many were new. */
export function pushCodes(readerId: string, codes: string[]): number {
  const c = channel(readerId);
  let added = 0;
  for (const raw of codes) {
    const code = raw.trim();
    if (!code || c.seen.has(code)) continue;
    c.seen.add(code);
    c.seq += 1;
    c.log.push({ seq: c.seq, code });
    added += 1;
  }
  if (c.log.length > CAP) c.log.splice(0, c.log.length - CAP);
  c.updatedAt = Date.now();
  prune();
  return added;
}

/** Codes added after `since`, plus the latest sequence to poll from next. */
export function readSince(readerId: string, since: number): { seq: number; codes: string[] } {
  const c = channels.get(readerId);
  if (!c) return { seq: 0, codes: [] };
  return { seq: c.seq, codes: c.log.filter((e) => e.seq > since).map((e) => e.code) };
}

/** Reset a channel (e.g. when a fresh audit walk begins). */
export function clearChannel(readerId: string): void {
  channels.delete(readerId);
}
