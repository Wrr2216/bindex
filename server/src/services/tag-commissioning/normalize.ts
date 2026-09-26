import { badRequest } from "../../lib/errors";

/**
 * How tag UIDs and legacy sticker numbers are written down, so that the same
 * physical tag or sticker always ends up as the same stored value however a
 * reader, a phone or a person typed it.
 *
 * Pure functions with no database access: the scan path, the binding services
 * and the tests all share them.
 */

export type LegacyTag = { color: string; lot: string | null; number: number };

/**
 * The letters and digits of a code, uppercased. Two reads of one tag agree on
 * this even when one reader wrote "04:a2:3b" and another "04A23B". Mirrors the
 * expression index in migration 0028, so a lookup on it is indexed.
 */
export function tagKey(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/**
 * The stored form of an RFID EPC or NFC UID. Hex, however it was grouped, is
 * stored as bare uppercase hex; anything else (a decimal card number with a
 * prefix, say) is kept as typed so nothing is thrown away.
 */
export function normalizeTagUid(value: string): string {
  const trimmed = value.trim();
  const compact = trimmed.replace(/[\s:.-]/g, "");
  return /^[0-9A-Fa-f]+$/.test(compact) ? compact.toUpperCase() : trimmed;
}

const SEPARATORS = /[\s\-_/.,:#]+/;

/** Leading zeros carry no meaning on a sticker ("056" is 56), but keep one zero. */
const stripZeros = (digits: string) => digits.replace(/^0+(?=\d)/, "");

/**
 * Read a legacy sticker as typed or scanned: "RED 1234 056", "red-1234-56",
 * "Red/1234/0056", "RED1234 56", or without a lot, "RED 56". Returns null for
 * anything that is not a colour word followed by an optional lot and a number.
 */
export function parseLegacyTag(input: string): LegacyTag | null {
  const tokens = input.trim().split(SEPARATORS).filter(Boolean);
  // A colour run straight into the lot ("RED1234") is split where the digits start.
  const glued = tokens[0]?.match(/^([A-Za-z]+)(\d[A-Za-z0-9]*)$/);
  if (glued) tokens.splice(0, 1, glued[1]!, glued[2]!);
  if (tokens.length < 2 || tokens.length > 3) return null;

  const color = tokens[0]!;
  const number = tokens[tokens.length - 1]!;
  const lot = tokens.length === 3 ? tokens[1]! : null;

  if (!/^[A-Za-z]{1,20}$/.test(color)) return null;
  if (!/^\d{1,15}$/.test(number)) return null;
  if (lot !== null && !/^[A-Za-z0-9]{1,20}$/.test(lot)) return null;

  return {
    color: color.toUpperCase(),
    // A numeric lot is padded as freely as the number is; a lettered one is a
    // label and is only uppercased.
    lot: lot === null ? null : /^\d+$/.test(lot) ? stripZeros(lot) : lot.toUpperCase(),
    number: Number(stripZeros(number)),
  };
}

/** The stored form: COLOR-LOT-NUMBER, or COLOR-NUMBER when there is no lot. */
export function formatLegacyTag(tag: LegacyTag): string {
  return tag.lot ? `${tag.color}-${tag.lot}-${tag.number}` : `${tag.color}-${tag.number}`;
}

/** The stored form of a typed or scanned sticker, or null if it is not one. */
export function legacyTagKey(input: string): string | null {
  const tag = parseLegacyTag(input);
  return tag ? formatLegacyTag(tag) : null;
}

/**
 * The value to store for an identifier of a given type. Types this feature
 * does not own pass through trimmed, exactly as before.
 */
export function normalizeIdentifierValue(type: string, value: string): string {
  if (type === "rfid" || type === "nfc") return normalizeTagUid(value);
  if (type === "legacy") {
    const key = legacyTagKey(value);
    if (!key) {
      throw badRequest(
        `“${value.trim()}” is not a sticker number. Write it as a colour, an optional lot and a number, such as RED 1234 56.`,
      );
    }
    return key;
  }
  return value.trim();
}
