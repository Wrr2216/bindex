import type { BeaconFrame } from "./advert";
import type { Observation } from "./adapters";

/**
 * What each gateway hears that is not a registered tag: the list an
 * administrator picks from to register a new tag without typing its UUID.
 *
 * Kept in memory only, for ten minutes, and never stored: most of it is
 * phones, headphones and other people's devices, which Bindex has no business
 * recording.
 */

export type HeardAdvert = {
  key: string;
  identity: string | null;
  mac: string | null;
  frame: BeaconFrame;
  name: string | null;
  url: string | null;
  txPower: number | null;
  rssi: number | null;
  count: number;
  firstAt: number;
  lastAt: number;
};

const PER_GATEWAY = 300;
const TTL_MS = 10 * 60_000;

export class HeardNearby {
  private byGateway = new Map<string, Map<string, HeardAdvert>>();

  add(gatewayId: string, o: Observation, at: number): void {
    const key = o.identity ?? o.mac;
    if (!key) return;
    let list = this.byGateway.get(gatewayId);
    if (!list) {
      list = new Map();
      this.byGateway.set(gatewayId, list);
    }
    const prev = list.get(key);
    if (prev) {
      list.delete(key);
      prev.count += 1;
      prev.lastAt = Math.max(prev.lastAt, at);
      if (o.rssi !== null) prev.rssi = o.rssi;
      prev.mac ??= o.mac;
      prev.name ??= o.name;
      prev.url ??= o.url;
      prev.txPower ??= o.txPower;
      list.set(key, prev);
    } else {
      list.set(key, {
        key,
        identity: o.identity,
        mac: o.mac,
        frame: o.frame,
        name: o.name,
        url: o.url,
        txPower: o.txPower,
        rssi: o.rssi,
        count: 1,
        firstAt: at,
        lastAt: at,
      });
      // Oldest first in insertion order, so the first key is the stalest.
      if (list.size > PER_GATEWAY) list.delete(list.keys().next().value!);
    }
  }

  /** Recently heard, strongest first. `beaconsOnly` hides adverts with no beacon frame. */
  list(opts: { gatewayId?: string; beaconsOnly?: boolean; now?: number } = {}): (HeardAdvert & { gatewayId: string })[] {
    const now = opts.now ?? Date.now();
    const out: (HeardAdvert & { gatewayId: string })[] = [];
    for (const [gatewayId, list] of this.byGateway) {
      if (opts.gatewayId && gatewayId !== opts.gatewayId) continue;
      for (const [key, h] of list) {
        if (h.lastAt < now - TTL_MS) {
          list.delete(key);
          continue;
        }
        if (opts.beaconsOnly && h.frame === "none") continue;
        out.push({ ...h, gatewayId });
      }
    }
    return out.sort((a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity));
  }

  /** Forget one advertiser, once it has been registered. */
  forget(key: string): void {
    for (const list of this.byGateway.values()) list.delete(key);
  }

  clear(): void {
    this.byGateway.clear();
  }
}
