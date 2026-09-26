/**
 * Geometry on the Earth's surface, in plain TypeScript. Fences are few and
 * small (a yard, a building, a town), so there is no need for PostGIS; these
 * functions are exact enough for that scale and safe across the antimeridian.
 *
 * Coordinates are degrees. Distances are metres. Polygon edges are straight
 * lines in longitude and latitude, as GeoJSON (RFC 7946) defines them.
 */

export type LatLng = { lat: number; lng: number };

/** Mean Earth radius (IUGG), metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

const RAD = Math.PI / 180;
const METRES_PER_DEGREE = EARTH_RADIUS_M * RAD;

/** A longitude, or a longitude difference, brought into [-180, 180). */
export function wrapLng(lng: number): number {
  const w = (((lng + 180) % 360) + 360) % 360 - 180;
  // -0 reads badly in logs and tests.
  return w === 0 ? 0 : w;
}

export function isValidLatLng(p: { lat: unknown; lng: unknown }): p is LatLng {
  return (
    typeof p.lat === "number" &&
    typeof p.lng === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

/**
 * Great-circle distance. The longitude difference is wrapped first, so two
 * points either side of the antimeridian are a short hop apart, not a trip
 * round the world.
 */
export function haversineM(a: LatLng, b: LatLng): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const dφ = φ2 - φ1;
  const dλ = wrapLng(b.lng - a.lng) * RAD;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a path through the points, in order. */
export function pathLengthM(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1]!, points[i]!);
  return total;
}

/**
 * Longitudes made continuous along a ring, so an edge from 179.9 to -179.9 is
 * 0.2 degrees long rather than 359.8. The result may leave [-180, 180].
 */
export function unwrapRing(ring: readonly LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of ring) {
    const prev = out[out.length - 1];
    out.push(prev ? { lat: p.lat, lng: prev.lng + wrapLng(p.lng - prev.lng) } : { lat: p.lat, lng: p.lng });
  }
  return out;
}

/** Even-odd ray cast in the plane. `ring` need not repeat its first point. */
function rayCast(x: number, y: number, ring: readonly LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]!.lng;
    const yi = ring[i]!.lat;
    const xj = ring[j]!.lng;
    const yj = ring[j]!.lat;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether a point is inside a ring. The ring is unwrapped, then the point is
 * tried at its own longitude and one turn either side, so a ring drawn across
 * the antimeridian works whichever side the point is reported on.
 */
export function pointInRing(p: LatLng, ring: readonly LatLng[]): boolean {
  if (ring.length < 3) return false;
  const unwrapped = unwrapRing(ring);
  for (const shift of [0, 360, -360]) {
    if (rayCast(p.lng + shift, p.lat, unwrapped)) return true;
  }
  return false;
}

/** Inside the outer ring and in none of the holes. */
export function pointInPolygon(p: LatLng, rings: readonly (readonly LatLng[])[]): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !pointInRing(p, outer)) return false;
  return !holes.some((h) => pointInRing(p, h));
}

/**
 * The point on segment a-b nearest to p, worked out in a flat projection
 * centred on p. Close to a fence, which is where it matters, that projection is
 * exact to well under a metre; far away the nearest point is still the right
 * one to within a few percent, and the distance is measured on the sphere.
 */
function nearestOnSegment(p: LatLng, a: LatLng, b: LatLng): LatLng {
  const k = Math.cos(p.lat * RAD);
  const ax = wrapLng(a.lng - p.lng) * k;
  const ay = a.lat - p.lat;
  // b is taken relative to a, so an edge across the antimeridian stays short.
  const bx = ax + wrapLng(b.lng - a.lng) * k;
  const by = b.lat - p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { lat: p.lat + y, lng: wrapLng(p.lng + (k === 0 ? 0 : x / k)) };
}

/** Distance from p to the nearest edge of a set of rings (the polygon's boundary). */
export function distanceToBoundaryM(p: LatLng, rings: readonly (readonly LatLng[])[]): number {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const d = haversineM(p, nearestOnSegment(p, a, b));
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Area of a ring in square metres, from the shoelace formula in a flat
 * projection about its first point. Only used to tell a small fence from a
 * large one, so the projection's error does not matter.
 */
export function ringAreaM2(ring: readonly LatLng[]): number {
  if (ring.length < 3) return 0;
  const origin = ring[0]!;
  const k = Math.cos(origin.lat * RAD);
  const xy = unwrapRing(ring).map((p) => ({
    x: (p.lng - origin.lng) * k * METRES_PER_DEGREE,
    y: (p.lat - origin.lat) * METRES_PER_DEGREE,
  }));
  let sum = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) sum += xy[j]!.x * xy[i]!.y - xy[i]!.x * xy[j]!.y;
  return Math.abs(sum) / 2;
}

/**
 * A box around a ring, with longitudes as a centre and half-width so a box
 * across the antimeridian is still one box.
 */
export type Box = { minLat: number; maxLat: number; centerLng: number; halfWidthLng: number };

export function ringBox(ring: readonly LatLng[]): Box {
  const u = unwrapRing(ring);
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of u) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return { minLat, maxLat, centerLng: wrapLng((minLng + maxLng) / 2), halfWidthLng: (maxLng - minLng) / 2 };
}

export function circleBox(center: LatLng, radiusM: number): Box {
  const dLat = radiusM / METRES_PER_DEGREE;
  const k = Math.cos(center.lat * RAD);
  const dLng = k < 1e-6 ? 180 : Math.min(180, dLat / k);
  return { minLat: center.lat - dLat, maxLat: center.lat + dLat, centerLng: center.lng, halfWidthLng: dLng };
}

/** A quick reject: whether p is within `marginM` of the box. */
export function nearBox(p: LatLng, box: Box, marginM: number): boolean {
  const m = marginM / METRES_PER_DEGREE;
  if (p.lat < box.minLat - m || p.lat > box.maxLat + m) return false;
  if (box.halfWidthLng >= 180) return true;
  const k = Math.cos(Math.min(89.9, Math.abs(p.lat)) * RAD);
  return Math.abs(wrapLng(p.lng - box.centerLng)) <= box.halfWidthLng + m / k;
}
