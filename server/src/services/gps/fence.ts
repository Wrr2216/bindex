import type { GeofenceGeometry, GeofenceKind } from "../../db/tables/gps";
import {
  circleBox,
  distanceToBoundaryM,
  haversineM,
  isValidLatLng,
  nearBox,
  pointInPolygon,
  ringAreaM2,
  ringBox,
  type Box,
  type LatLng,
} from "./geo";

/**
 * Fences as the ingest uses them, and the rule for when a tracker has crossed
 * one. Pure: no database, no clock.
 */

/** Largest polygon accepted, in vertices across all rings. */
export const MAX_FENCE_VERTICES = 2000;
/** Largest circle accepted: 500 km covers a region; anything bigger is a mistake. */
export const MAX_FENCE_RADIUS_M = 500_000;

export class GeometryError extends Error {}

/** A fence ready to test points against. */
export type CompiledFence = {
  id: string;
  name: string;
  kind: GeofenceKind;
  locationId: string | null;
  dwellMs: number;
  /** When the shape last changed, as epoch milliseconds. */
  geometryAt: number;
  areaM2: number;
  box: Box;
  circle?: { center: LatLng; radiusM: number };
  /** Outer ring first, then holes. Closing points removed. */
  rings?: LatLng[][];
};

const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number";

function toLatLng(pair: unknown, where: string): LatLng {
  if (!isPair(pair)) throw new GeometryError(`${where} must be a [longitude, latitude] pair.`);
  const p = { lat: pair[1], lng: pair[0] };
  if (!isValidLatLng(p)) {
    throw new GeometryError(`${where} is off the map: latitude must be -90 to 90 and longitude -180 to 180.`);
  }
  return p;
}

function toRing(raw: unknown, where: string): LatLng[] {
  if (!Array.isArray(raw)) throw new GeometryError(`${where} must be a list of [longitude, latitude] pairs.`);
  const ring = raw.map((pair, i) => toLatLng(pair, `${where}[${i}]`));
  const first = ring[0];
  const last = ring[ring.length - 1];
  // GeoJSON repeats the first point at the end; accept it either way.
  if (first && last && ring.length > 1 && first.lat === last.lat && first.lng === last.lng) ring.pop();
  if (ring.length < 3) throw new GeometryError(`${where} needs at least three distinct corners.`);
  return ring;
}

/**
 * Check a fence's shape and return it in canonical GeoJSON: a Point for a
 * circle, or a closed Polygon. Throws GeometryError with a message a person can
 * act on.
 */
export function normalizeGeometry(
  kind: GeofenceKind,
  geometry: unknown,
  radiusM: number | null | undefined,
): { geometry: GeofenceGeometry; radiusM: number | null } {
  const g = geometry as { type?: unknown; coordinates?: unknown } | null;
  if (!g || typeof g !== "object") throw new GeometryError("A fence needs a shape.");
  if (kind === "circle") {
    if (g.type !== "Point") throw new GeometryError('A circle is a GeoJSON Point (its centre) with a radius.');
    const c = toLatLng(g.coordinates, "The centre");
    if (typeof radiusM !== "number" || !Number.isFinite(radiusM) || radiusM <= 0) {
      throw new GeometryError("A circle needs a radius in metres greater than zero.");
    }
    if (radiusM > MAX_FENCE_RADIUS_M) {
      throw new GeometryError(`A circle's radius can be at most ${MAX_FENCE_RADIUS_M / 1000} km.`);
    }
    return { geometry: { type: "Point", coordinates: [c.lng, c.lat] }, radiusM };
  }
  if (g.type !== "Polygon") throw new GeometryError("A polygon is a GeoJSON Polygon.");
  if (!Array.isArray(g.coordinates) || g.coordinates.length === 0) {
    throw new GeometryError("A polygon needs an outer ring of corners.");
  }
  const rings = g.coordinates.map((r, i) => toRing(r, i === 0 ? "The outline" : `Hole ${i}`));
  const vertices = rings.reduce((n, r) => n + r.length, 0);
  if (vertices > MAX_FENCE_VERTICES) {
    throw new GeometryError(`A polygon can have at most ${MAX_FENCE_VERTICES} corners; simplify the outline.`);
  }
  if (ringAreaM2(rings[0]!) < 1) throw new GeometryError("The outline has no area. Draw at least three separate corners.");
  return {
    geometry: {
      type: "Polygon",
      coordinates: rings.map((r) => [...r, r[0]!].map((p) => [p.lng, p.lat] as [number, number])),
    },
    radiusM: null,
  };
}

export type FenceRow = {
  id: string;
  name: string;
  kind: GeofenceKind;
  geometry: unknown;
  radiusM: number | null;
  locationId: string | null;
  dwellSeconds: number;
  geometryAt: Date | string;
};

export function compileFence(row: FenceRow): CompiledFence {
  const { geometry, radiusM } = normalizeGeometry(row.kind, row.geometry, row.radiusM);
  const base = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    locationId: row.locationId,
    dwellMs: Math.max(0, row.dwellSeconds) * 1000,
    geometryAt: new Date(row.geometryAt).getTime(),
  };
  if (geometry.type === "Point") {
    const center = { lat: geometry.coordinates[1], lng: geometry.coordinates[0] };
    const r = radiusM!;
    return { ...base, circle: { center, radiusM: r }, areaM2: Math.PI * r * r, box: circleBox(center, r) };
  }
  const rings = geometry.coordinates.map((ring) => ring.slice(0, -1).map(([lng, lat]) => ({ lat, lng })));
  const holes = rings.slice(1).reduce((a, r) => a + ringAreaM2(r), 0);
  return { ...base, rings, areaM2: Math.max(0, ringAreaM2(rings[0]!) - holes), box: ringBox(rings[0]!) };
}

/**
 * Signed distance from the fence's edge: negative inside, positive outside.
 */
export function signedDistanceM(fence: CompiledFence, p: LatLng): number {
  if (fence.circle) return haversineM(p, fence.circle.center) - fence.circle.radiusM;
  const rings = fence.rings!;
  const d = distanceToBoundaryM(p, rings);
  return pointInPolygon(p, rings) ? -d : d;
}

/** Distance to the nearest point of the fence; zero inside it. */
export function distanceToFenceM(fence: CompiledFence, p: LatLng): number {
  return Math.max(0, signedDistanceM(fence, p));
}

export type Containment = "inside" | "outside" | "uncertain";

/**
 * Which side of the fence a fix is on. A fix whose accuracy circle straddles
 * the edge is uncertain, and changes nothing: a phone indoors reporting ±80 m
 * at the edge of a yard says nothing about whether it left. That band is also
 * the hysteresis that keeps a tracker parked on the line from flapping.
 */
export function containment(fence: CompiledFence, p: LatLng, accuracyM?: number | null): Containment {
  const band = typeof accuracyM === "number" && Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM : 0;
  if (!nearBox(p, fence.box, band + 1)) return "outside";
  const d = signedDistanceM(fence, p);
  if (band === 0) return d <= 0 ? "inside" : "outside";
  if (d <= -band) return "inside";
  if (d >= band) return "outside";
  return "uncertain";
}

/** What a tracker knows about one fence. */
export type FenceState = {
  inside: boolean;
  /** When the tracker crossed onto the side it is on, if known. */
  since: number | null;
  /** A crossing seen but not yet held for the fence's dwell time. */
  pending: { inside: boolean; since: number; lat: number; lng: number } | null;
};

export const OUTSIDE: FenceState = { inside: false, since: null, pending: null };

export type FenceTransition = {
  kind: "entered" | "exited";
  /** The first fix on the new side. */
  occurredAt: number;
  lat: number;
  lng: number;
  /** The fix that confirmed it. */
  confirmedAt: number;
};

/**
 * Advance one tracker's state for one fence by one fix, oldest fix first.
 *
 * A crossing is pending from the first fix on the other side, and confirmed by
 * a later fix still on that side at least `dwellMs` after it; a fix back on the
 * original side cancels it. With a dwell of zero the first fix confirms. An
 * uncertain fix neither confirms nor cancels. The transition reports when the
 * tracker actually crossed, not when it was confirmed.
 */
export function stepFence(
  state: FenceState,
  side: Containment,
  fix: { at: number; lat: number; lng: number },
  dwellMs: number,
): { state: FenceState; transition: FenceTransition | null } {
  if (side === "uncertain") return { state, transition: null };
  const inside = side === "inside";
  if (inside === state.inside) {
    return { state: state.pending ? { ...state, pending: null } : state, transition: null };
  }
  const pending =
    state.pending && state.pending.inside === inside
      ? state.pending
      : { inside, since: fix.at, lat: fix.lat, lng: fix.lng };
  if (fix.at - pending.since >= dwellMs) {
    return {
      state: { inside, since: pending.since, pending: null },
      transition: {
        kind: inside ? "entered" : "exited",
        occurredAt: pending.since,
        lat: pending.lat,
        lng: pending.lng,
        confirmedAt: fix.at,
      },
    };
  }
  return { state: { ...state, pending }, transition: null };
}

/**
 * The location a tracker is in, from the fences it is confirmed inside: the
 * smallest linked fence, so a dock fence inside a yard fence wins.
 */
export function zoneFromFences(
  fences: readonly CompiledFence[],
  isInside: (fenceId: string) => boolean,
): { locationId: string; fenceId: string } | null {
  let best: CompiledFence | null = null;
  for (const f of fences) {
    if (!f.locationId || !isInside(f.id)) continue;
    if (!best || f.areaM2 < best.areaM2) best = f;
  }
  return best ? { locationId: best.locationId!, fenceId: best.id } : null;
}
