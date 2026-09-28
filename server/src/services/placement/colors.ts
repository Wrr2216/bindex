import { normName } from "./tree";

/**
 * One colour per floor, for the band across the top of a placement card and
 * the kiosk. Crews learn "blue is five" within an hour, and a colour reads from
 * across a corridor where a room number does not.
 *
 * The colour comes from the floor's number where it has one, so floors 4 and 5
 * never share a colour and the same floor is the same colour on every job. A
 * job can override any floor's colour to match the signage on site.
 */

/** Dark enough for white text; neighbours on the list are far apart in hue. */
export const FLOOR_PALETTE = [
  "#0f766e", // 0 teal
  "#1d4ed8", // 1 blue
  "#b91c1c", // 2 red
  "#15803d", // 3 green
  "#7e22ce", // 4 purple
  "#c2410c", // 5 orange
  "#0369a1", // 6 sky
  "#be185d", // 7 pink
  "#4d7c0f", // 8 olive
  "#a16207", // 9 amber
] as const;

/** For lines with no floor at all. */
export const NO_FLOOR_COLOR = "#475569";

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * The floor's number: the first whole number in its name, 0 for ground, and
 * negative for basements (B2 is -2). Null for a name with no number, such as
 * "Mezzanine".
 */
export function floorNumber(floor: string): number | null {
  const name = normName(floor);
  if (/^(ground|g|lower ground|upper ground)(\s+(floor|level))?$/.test(name)) return 0;
  const basement = /^(b|basement|cellar|lower level)\s*-?\s*(\d+)?$/.exec(name);
  if (basement) return -Number(basement[2] ?? 1);
  const m = /-?\d+/.exec(name);
  return m ? Number(m[0]) : null;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** A job's colour overrides, keyed by floor name as people typed it. */
export type FloorColors = Record<string, string>;

export function floorColor(floor: string | null | undefined, overrides: FloorColors = {}): string {
  if (!floor || !floor.trim()) return NO_FLOOR_COLOR;
  const key = normName(floor);
  for (const [name, color] of Object.entries(overrides)) {
    if (normName(name) === key && HEX_COLOR.test(color)) return color.toLowerCase();
  }
  const n = floorNumber(floor);
  const i = n === null ? hash(key) : n;
  return FLOOR_PALETTE[((i % FLOOR_PALETTE.length) + FLOOR_PALETTE.length) % FLOOR_PALETTE.length]!;
}

/** Keep only well-formed entries of a stored overrides object. */
export function readFloorColors(raw: unknown): FloorColors {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FloorColors = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.trim() && typeof v === "string" && HEX_COLOR.test(v)) out[k.trim()] = v.toLowerCase();
  }
  return out;
}
