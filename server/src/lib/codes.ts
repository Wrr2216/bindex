import { randomBytes } from "node:crypto";
import { env } from "../env";

/**
 * Printed codes: the short strings that go on a label and resolve back to one
 * record when scanned.
 *
 * The prefixes are per-deployment settings, but the code generators are called
 * from places that cannot await (Drizzle column defaults), so the current
 * values are mirrored here. `applyCodePrefixes` is called whenever the
 * configuration is loaded or changed, and the server loads it before it starts
 * listening. A database trigger regenerates any code that would collide, so
 * these values are a fast path rather than the last word.
 */

// Crockford base32: no I, L, O or U, so a code read off a label cannot be
// mistyped into a different one.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Uppercase letters and digits only, so a code stays readable on a label. */
export const normalizeCodePrefix = (raw: string, fallback: string): string =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || fallback;

let assetPrefix = normalizeCodePrefix(env.ASSET_CODE_PREFIX, "INV");
let locationPrefix = "LOC";

/** The prefix currently in force, for sample labels and help text. */
export const assetCodePrefix = (): string => assetPrefix;

export function applyCodePrefixes(asset: string, location: string): void {
  assetPrefix = normalizeCodePrefix(asset, "INV");
  locationPrefix = normalizeCodePrefix(location, "LOC");
}

function random(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** A code for one item or one tracked unit, e.g. `INV-7F3K2A`. */
export const genAssetCode = (): string => `${assetPrefix}-${random(6)}`;

/**
 * A location's code, derived from its id rather than random, so reprinting a
 * label for the same shelf always produces the same code.
 */
export const locationCode = (id: string): string =>
  `${locationPrefix}-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
