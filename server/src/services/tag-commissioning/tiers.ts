/**
 * How an item can be identified without typing, from least to most capable.
 * The upgrade path a site follows is legacy stickers, then RFID, then a
 * dual-frequency RFID + NFC tag.
 *
 *   none      nothing on file that proves a tag or label is on it
 *   barcode   a scannable code: a product barcode or serial on file, an NFC
 *             tag alone, or the printed Bindex code has been scanned at least
 *             once (so the label is known to exist)
 *   legacy    a colour, lot and number sticker
 *   rfid      a UHF tag: bulk reads from a distance
 *   rfid_nfc  a UHF tag and an NFC tag (or one dual-frequency tag bound both ways)
 */
export type TagTier = "none" | "barcode" | "legacy" | "rfid" | "rfid_nfc";

export const TAG_TIERS: TagTier[] = ["none", "barcode", "legacy", "rfid", "rfid_nfc"];

export type TierFacts = {
  hasRfid: boolean;
  hasNfc: boolean;
  hasLegacy: boolean;
  /** Any identifier that is not a tag or a sticker: UPC, serial, asset tag, MAC, SKU, other. */
  hasCode: boolean;
  /** The item has been resolved by a scan at least once. */
  scanned: boolean;
};

export function classifyTier(f: TierFacts): TagTier {
  if (f.hasRfid && f.hasNfc) return "rfid_nfc";
  if (f.hasRfid) return "rfid";
  if (f.hasLegacy) return "legacy";
  if (f.hasCode || f.hasNfc || f.scanned) return "barcode";
  return "none";
}

/** Identifier types that count as an ordinary scannable code for the tier. */
export const CODE_TYPES = ["upc", "serial", "asset_tag", "mac", "sku", "other"] as const;
