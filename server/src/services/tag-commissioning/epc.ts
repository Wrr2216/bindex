/**
 * 96-bit EPCs for tags that Bindex writes itself, on an RFID printer-encoder
 * or a handheld writer.
 *
 * Two schemes:
 *
 * - GIAI-96, the GS1 Global Individual Asset Identifier, when the instance has
 *   a GS1 company prefix. Encoded per the GS1 EPC Tag Data Standard: an 8-bit
 *   header (0x34), a 3-bit filter, a 3-bit partition that says how the
 *   remaining 82 bits split between company prefix and asset reference, then
 *   the two numbers in binary.
 *
 * - bindex-96, a private scheme for instances without a GS1 prefix, that packs
 *   the printed asset code itself into the EPC, so a tag decodes back to the
 *   code on its label. Its header (0x42) is one the Tag Data Standard lists as
 *   reserved for future use, so GS1 decoders report an unknown header rather
 *   than misreading it as one of theirs. See docs/tag-commissioning.md.
 *
 * Pure: BigInt arithmetic on hex strings, no I/O.
 */

export type EpcScheme = "giai-96" | "bindex-96";

const HEX24 = /^[0-9A-F]{24}$/;
const toHex = (v: bigint) => v.toString(16).toUpperCase().padStart(24, "0");
const mask = (bits: number) => (1n << BigInt(bits)) - 1n;

/** Normalize an EPC as a reader reports it to 24 uppercase hex digits, or null. */
export function normalizeEpcHex(raw: string): string | null {
  const hex = raw.replace(/[\s:-]/g, "").toUpperCase();
  return HEX24.test(hex) ? hex : null;
}

// ---- GIAI-96 --------------------------------------------------------------

export const GIAI96_HEADER = 0x34;

/**
 * GS1 EPC Tag Data Standard, GIAI-96 partition table: company prefix bits and
 * digits, then asset reference bits, by partition value.
 */
const GIAI96_PARTITIONS = [
  { prefixBits: 40, prefixDigits: 12, refBits: 42 },
  { prefixBits: 37, prefixDigits: 11, refBits: 45 },
  { prefixBits: 34, prefixDigits: 10, refBits: 48 },
  { prefixBits: 30, prefixDigits: 9, refBits: 52 },
  { prefixBits: 27, prefixDigits: 8, refBits: 55 },
  { prefixBits: 24, prefixDigits: 7, refBits: 58 },
  { prefixBits: 20, prefixDigits: 6, refBits: 62 },
] as const;

export type Giai96 = {
  filter: number;
  companyPrefix: string;
  assetReference: string;
};

export type DecodedGiai96 = Giai96 & {
  partition: number;
  /** urn:epc:tag:giai-96:filter.prefix.reference */
  tagUri: string;
  /** urn:epc:id:giai:prefix.reference */
  pureIdentityUri: string;
};

export class EpcError extends Error {}

/** A GS1 company prefix is 6 to 12 digits; leading zeros are significant. */
export const isGs1CompanyPrefix = (value: string) => /^\d{6,12}$/.test(value);

/** Largest asset reference GIAI-96 can carry under a company prefix of this length. */
export function giai96MaxReference(companyPrefix: string): bigint {
  const p = GIAI96_PARTITIONS[12 - companyPrefix.length];
  if (!p) throw new EpcError("A GS1 company prefix is 6 to 12 digits.");
  return mask(p.refBits);
}

export function encodeGiai96({ filter, companyPrefix, assetReference }: Giai96): string {
  if (!Number.isInteger(filter) || filter < 0 || filter > 7) {
    throw new EpcError("The filter value is 0 to 7.");
  }
  if (!isGs1CompanyPrefix(companyPrefix)) {
    throw new EpcError("A GS1 company prefix is 6 to 12 digits.");
  }
  // GIAI-96 stores the reference as an integer, so the standard allows only
  // digits with no leading zero: "007" would come back as "7".
  if (!/^(0|[1-9]\d*)$/.test(assetReference)) {
    throw new EpcError("A GIAI-96 asset reference is digits with no leading zero.");
  }
  const partition = 12 - companyPrefix.length;
  const p = GIAI96_PARTITIONS[partition]!;
  const ref = BigInt(assetReference);
  if (ref > mask(p.refBits)) {
    throw new EpcError(
      `Asset reference ${assetReference} does not fit in GIAI-96 with a ${companyPrefix.length}-digit company prefix.`,
    );
  }
  const value =
    (BigInt(GIAI96_HEADER) << 88n) |
    (BigInt(filter) << 85n) |
    (BigInt(partition) << 82n) |
    (BigInt(companyPrefix) << BigInt(p.refBits)) |
    ref;
  return toHex(value);
}

export function decodeGiai96(hex: string): DecodedGiai96 | null {
  const epc = normalizeEpcHex(hex);
  if (!epc) return null;
  const v = BigInt(`0x${epc}`);
  if (Number(v >> 88n) !== GIAI96_HEADER) return null;
  const filter = Number((v >> 85n) & 7n);
  const partition = Number((v >> 82n) & 7n);
  const p = GIAI96_PARTITIONS[partition];
  if (!p) return null;
  const prefixValue = (v >> BigInt(p.refBits)) & mask(p.prefixBits);
  // More digits than the partition allows is not a valid encoding.
  if (prefixValue >= 10n ** BigInt(p.prefixDigits)) return null;
  const companyPrefix = prefixValue.toString().padStart(p.prefixDigits, "0");
  const assetReference = (v & mask(p.refBits)).toString();
  return {
    filter,
    partition,
    companyPrefix,
    assetReference,
    tagUri: `urn:epc:tag:giai-96:${filter}.${companyPrefix}.${assetReference}`,
    pureIdentityUri: `urn:epc:id:giai:${companyPrefix}.${assetReference}`,
  };
}

// ---- bindex-96 ------------------------------------------------------------
//
//   8 bits   header 0x42
//   4 bits   where the dash goes: 0 none, 1 to 13 after that many characters,
//            15 = opaque (no printable code; 84 bits taken from the record id)
//  84 bits   14 characters of 6 bits: 0 is padding, 1-10 are 0-9, 11-36 are A-Z
//
// An asset code is a prefix of up to 8 characters, a dash and 6 more, so every
// code Bindex generates fits in 14 characters.

export const BINDEX96_HEADER = 0x42;
const OPAQUE = 15;
const CHARS = 14;
const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Pack a printed code, or null when it cannot be (too long, odd characters). */
export function encodeBindex96(assetCode: string): string | null {
  const m = assetCode.trim().toUpperCase().match(/^([A-Z0-9]+)(?:-([A-Z0-9]+))?$/);
  if (!m) return null;
  const head = m[1]!;
  const tail = m[2] ?? "";
  const chars = head + tail;
  if (chars.length > CHARS) return null;
  const dash = m[2] === undefined ? 0 : head.length;
  if (dash > 13) return null;
  let value = (BigInt(BINDEX96_HEADER) << 88n) | (BigInt(dash) << 84n);
  for (let i = 0; i < CHARS; i++) {
    const symbol = i < chars.length ? ALNUM.indexOf(chars[i]!) + 1 : 0;
    value |= BigInt(symbol) << BigInt(6 * (CHARS - 1 - i));
  }
  return toHex(value);
}

/**
 * For a record whose code cannot be packed: 84 bits of its UUID. Unique for
 * all practical purposes, but it does not decode back to anything printable.
 */
export function encodeBindex96Opaque(id: string): string {
  const hex = id.replace(/-/g, "").slice(0, 21).toUpperCase();
  if (!/^[0-9A-F]{21}$/.test(hex)) throw new EpcError("Expected a UUID.");
  const value = (BigInt(BINDEX96_HEADER) << 88n) | (BigInt(OPAQUE) << 84n) | BigInt(`0x${hex}`);
  return toHex(value);
}

export type DecodedBindex96 = { assetCode: string | null; opaque: boolean };

export function decodeBindex96(hex: string): DecodedBindex96 | null {
  const epc = normalizeEpcHex(hex);
  if (!epc) return null;
  const v = BigInt(`0x${epc}`);
  if (Number(v >> 88n) !== BINDEX96_HEADER) return null;
  const dash = Number((v >> 84n) & 15n);
  if (dash === OPAQUE) return { assetCode: null, opaque: true };
  let chars = "";
  let ended = false;
  for (let i = 0; i < CHARS; i++) {
    const symbol = Number((v >> BigInt(6 * (CHARS - 1 - i))) & 63n);
    if (symbol === 0) {
      ended = true;
      continue;
    }
    // Padding only ever trails, and 37-63 are unused.
    if (ended || symbol > ALNUM.length) return null;
    chars += ALNUM[symbol - 1];
  }
  if (!chars || dash >= chars.length) return null;
  const assetCode = dash ? `${chars.slice(0, dash)}-${chars.slice(dash)}` : chars;
  return { assetCode, opaque: false };
}

// ---- Either ---------------------------------------------------------------

export type EpcDescription = {
  scheme: EpcScheme | null;
  /** GS1 tag URI for GIAI-96; the packed code for bindex-96. */
  uri: string | null;
  assetCode: string | null;
};

/** What an EPC read off a tag is, as far as these two schemes can tell. */
export function describeEpc(hex: string): EpcDescription {
  const giai = decodeGiai96(hex);
  if (giai) return { scheme: "giai-96", uri: giai.tagUri, assetCode: null };
  const own = decodeBindex96(hex);
  if (own) return { scheme: "bindex-96", uri: null, assetCode: own.assetCode };
  return { scheme: null, uri: null, assetCode: null };
}
