/**
 * Where a shipment was last known to be. Pure.
 *
 * Two sources, best first:
 * 1. `shipment.metadata.gps`, where the GPS feature keeps a tracker's latest
 *    fix (it may not be installed; the shape is read loosely).
 * 2. The newest tracking-core position of anything on the shipment: a GPS
 *    tracker packed with the load, or the zone a dock reader last saw it in.
 */

export type LastPosition = {
  lat: number | null;
  lng: number | null;
  /** A zone or place name when there is one ("Dock 3", "Depot North"). */
  place: string | null;
  at: string;
  source: "gps" | "tracking";
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);

function date(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const validLat = (n: number | null) => n !== null && n >= -90 && n <= 90;
const validLng = (n: number | null) => n !== null && n >= -180 && n <= 180;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A fix out of shipment metadata, or null. Accepts `gps`, `gps.last` or `gps.position`. */
export function positionFromMetadata(metadata: Record<string, unknown> | null | undefined): LastPosition | null {
  const gps = obj(metadata?.gps);
  if (!gps) return null;
  for (const candidate of [obj(gps.last), obj(gps.position), obj(gps.lastFix), gps]) {
    if (!candidate) continue;
    const lat = num(candidate.lat ?? candidate.latitude);
    const lng = num(candidate.lng ?? candidate.lon ?? candidate.longitude);
    const at = date(candidate.at ?? candidate.observedAt ?? candidate.updatedAt ?? candidate.time);
    if (!validLat(lat) || !validLng(lng) || !at) continue;
    return { lat, lng, place: str(candidate.place ?? candidate.label ?? candidate.name), at: at.toISOString(), source: "gps" };
  }
  return null;
}

/** The newer of two positions; either may be missing. */
export function newestPosition(a: LastPosition | null, b: LastPosition | null): LastPosition | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a.at) >= new Date(b.at) ? a : b;
}
