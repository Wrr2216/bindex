/** Colours a legacy sticker can be. Administrators can change the list. */

export type PaletteColor = { name: string; hex: string };

export const DEFAULT_PALETTE: PaletteColor[] = [
  { name: "RED", hex: "#dc2626" },
  { name: "ORANGE", hex: "#ea580c" },
  { name: "YELLOW", hex: "#facc15" },
  { name: "GREEN", hex: "#16a34a" },
  { name: "BLUE", hex: "#2563eb" },
  { name: "PURPLE", hex: "#9333ea" },
  { name: "WHITE", hex: "#f8fafc" },
  { name: "BLACK", hex: "#0f172a" },
];

/**
 * A stored palette, cleaned up: names are single words (they become the first
 * part of COLOR-LOT-NUMBER) and appear once. Falls back to the default when
 * nothing usable is left, so there is always something to pick.
 */
export function cleanPalette(input: unknown): PaletteColor[] {
  if (!Array.isArray(input)) return DEFAULT_PALETTE;
  const seen = new Set<string>();
  const out: PaletteColor[] = [];
  for (const entry of input) {
    const e = entry as Partial<PaletteColor> | null;
    const name = typeof e?.name === "string" ? e.name.trim().toUpperCase() : "";
    const hex = typeof e?.hex === "string" ? e.hex.trim().toLowerCase() : "";
    if (!/^[A-Z]{1,20}$/.test(name) || !/^#[0-9a-f]{6}$/.test(hex) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, hex });
  }
  return out.length ? out : DEFAULT_PALETTE;
}
