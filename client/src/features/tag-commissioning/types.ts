/** Shapes returned by /api/tag-commissioning. */

export type TagTier = "none" | "barcode" | "legacy" | "rfid" | "rfid_nfc";

export type TagType = "rfid" | "nfc";

export type EpcScheme = "giai-96" | "bindex-96";

export interface PaletteColor {
  name: string;
  hex: string;
}

export interface TagSettings {
  gs1CompanyPrefix: string;
  palette: PaletteColor[];
  epcScheme: EpcScheme;
}

export interface LegacySticker {
  identifierId: string;
  value: string;
  color: string;
  lot: string | null;
  number: number;
}

export interface TagSummary {
  tier: TagTier;
  legacy: LegacySticker | null;
}

export interface BoundTag {
  id: string;
  type: TagType;
  value: string;
  unitId: string | null;
  createdAt: string;
}

export interface EpcView {
  scheme: EpcScheme;
  epc: string;
  uri: string | null;
  encodedAt: string | null;
}

export interface UnitTags {
  id: string;
  assetCode: string;
  label: string | null;
  tags: BoundTag[];
  epc: EpcView | null;
}

export interface ItemTags {
  itemId: string;
  physical: boolean;
  tier: TagTier;
  scanned: boolean;
  tags: BoundTag[];
  legacy: LegacySticker[];
  epc: EpcView | null;
  units: UnitTags[];
}

export interface CodeLookup {
  found: boolean;
  itemId?: string;
  unitId?: string | null;
  name?: string;
  assetCode?: string;
}

export type TierCounts = Record<TagTier, number> & { total: number };

export interface TierReportRow extends TierCounts {
  locationId: string | null;
  locationName: string | null;
  parentId: string | null;
}

export interface TierReport {
  rows: TierReportRow[];
  totals: TierCounts;
}

export interface SessionEntry {
  index: number;
  itemId: string;
  unitId: string | null;
  name: string;
  assetCode: string;
  unitLabel: string | null;
  locationName: string | null;
}

export interface BindSession {
  id: string;
  name: string;
  tagType: TagType;
  status: "active" | "finished";
  createdAt: string;
  total: number;
  position: number;
  bound: number;
  skipped: number;
  remaining: number;
  current: SessionEntry | null;
  upcoming: SessionEntry[];
  recent: { kind: "bind" | "skip"; value: string | null; at: string; entry: SessionEntry }[];
  canUndo: boolean;
}

export interface SessionListing {
  id: string;
  name: string;
  tagType: TagType;
  status: "active" | "finished";
  total: number;
  updatedAt: string;
  bound: number;
  skipped: number;
  remaining: number;
}

export type ReadOutcome =
  | { kind: "bound"; value: string; index: number; itemId: string; unitId: string | null }
  | {
      kind: "ignored";
      reason: "empty" | "finished" | "repeat" | "in_use";
      value: string;
      heldBy?: string;
    };
