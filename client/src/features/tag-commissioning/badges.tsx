import { useFeatures } from "../../config/useConfig";
import { colorHex, useTagSettings, useTagSummary } from "./stores";
import type { LegacySticker, TagTier } from "./types";

export const TIER_LABELS: Record<TagTier, string> = {
  none: "No tag",
  barcode: "Barcode / QR",
  legacy: "Legacy sticker",
  rfid: "RFID",
  rfid_nfc: "RFID + NFC",
};

export const TIER_HELP: Record<TagTier, string> = {
  none: "Nothing on file shows a label or tag is on it yet.",
  barcode: "Scanned one at a time: a barcode or QR label, or an NFC tag on its own.",
  legacy: "Identified by a colour, lot and number sticker.",
  rfid: "Read in bulk from a distance by UHF readers.",
  rfid_nfc: "Read in bulk by UHF readers, and by tapping a phone.",
};

const TIER_STYLES: Record<TagTier, string> = {
  none: "bg-slate-800 text-slate-400",
  barcode: "bg-slate-700 text-slate-200",
  legacy: "bg-amber-950 text-amber-300",
  rfid: "bg-sky-950 text-sky-300",
  rfid_nfc: "bg-emerald-950 text-emerald-300",
};

export function TierBadge({ tier, className = "" }: { tier: TagTier; className?: string }) {
  return (
    <span
      title={TIER_HELP[tier]}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${TIER_STYLES[tier]} ${className}`}
    >
      {TIER_LABELS[tier]}
    </span>
  );
}

/** A dot in the sticker's colour with its number, as it reads on the box. */
export function LegacyDot({ sticker }: { sticker: Pick<LegacySticker, "color" | "lot" | "number" | "value"> }) {
  const settings = useTagSettings();
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-300" title={`Sticker ${sticker.value}`}>
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-slate-500/60"
        style={{ backgroundColor: colorHex(settings?.palette, sticker.color) }}
      />
      <span className="sr-only">{sticker.color.toLowerCase()} sticker</span>
      {sticker.number}
    </span>
  );
}

/**
 * The tag summary shown on list cards and contents rows: the sticker dot when
 * sticker numbers are on, and the tier once an item carries RFID. Lower tiers
 * are left off lists to keep them quiet; the item page always shows the tier.
 */
export function ItemTagChip({ itemId }: { itemId: string }) {
  const features = useFeatures();
  const summary = useTagSummary(itemId);
  if (!summary) return null;
  const showTier = summary.tier === "rfid" || summary.tier === "rfid_nfc";
  const showSticker = features.legacyTags && summary.legacy;
  if (!showTier && !showSticker) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {showSticker && summary.legacy && <LegacyDot sticker={summary.legacy} />}
      {showTier && <TierBadge tier={summary.tier} className="px-1 py-0 text-[10px]" />}
    </span>
  );
}
