import { contentHash } from "../media-ai-core";
import type { CustodyTransfer, CustodyTransferItem } from "../../db/tables/custody";

/**
 * What a custody signature covers, built the same way every time from the
 * stored transfer and its lines: once when someone signs, and again whenever
 * the receipt is verified. Any change to the list, a seal, a party or the
 * condition note after signing makes the rebuilt content hash differently.
 *
 * Only snapshots are included. Links that the database may null later (the
 * job, the shipment, the place, the holder) are left out, so deleting a job
 * does not look like tampering with a receipt.
 */

export type TransferLine = Pick<
  CustodyTransferItem,
  "itemId" | "unitId" | "assetCode" | "unitCode" | "name" | "via" | "parentItemId" | "outcome" | "note"
>;

export type ContentLine = {
  itemId: string;
  unitId: string | null;
  assetCode: string;
  unitCode: string | null;
  name: string;
  via: string;
  inside: string | null;
  outcome: string;
  note: string | null;
};

export const contentLine = (l: TransferLine): ContentLine => ({
  itemId: l.itemId,
  unitId: l.unitId,
  assetCode: l.assetCode,
  unitCode: l.unitCode,
  name: l.name,
  via: l.via,
  inside: l.parentItemId,
  outcome: l.outcome,
  note: l.note,
});

/** Lines in the order they are signed: as scanned. */
export const contentLines = (lines: readonly (TransferLine & { position: number })[]): ContentLine[] =>
  [...lines].sort((a, b) => a.position - b.position).map(contentLine);

/** The fingerprint of the item list alone, stored on the transfer when it is locked. */
export const itemsHash = (lines: ContentLine[]): string => contentHash(lines);

export type TransferHeader = Pick<
  CustodyTransfer,
  | "code"
  | "purpose"
  | "fromKind"
  | "fromName"
  | "fromOrg"
  | "toKind"
  | "toName"
  | "toOrg"
  | "locationName"
  | "lat"
  | "lng"
  | "jobCode"
  | "shipmentCode"
  | "sealNumbers"
  | "conditionNote"
>;

export function transferContent(t: TransferHeader, lines: ContentLine[]) {
  return {
    kind: "bindex.custody_transfer",
    version: 1,
    code: t.code,
    purpose: t.purpose,
    from: { kind: t.fromKind, name: t.fromName, org: t.fromOrg },
    to: { kind: t.toKind, name: t.toName, org: t.toOrg },
    place: { name: t.locationName, lat: t.lat, lng: t.lng },
    job: t.jobCode,
    shipment: t.shipmentCode,
    seals: t.sealNumbers,
    conditionNote: t.conditionNote,
    count: lines.length,
    items: lines,
    itemsHash: itemsHash(lines),
  };
}

export type SignedContent = ReturnType<typeof transferContent>;

const lineKey = (l: Pick<ContentLine, "itemId" | "unitId">) => `${l.itemId}:${l.unitId ?? ""}`;

export type LineChange = { key: string; before: ContentLine | null; after: ContentLine | null; fields: string[] };

/**
 * What differs between the list someone signed and the list as it is now, so
 * a failed verification can say which lines changed rather than just "no".
 */
export function diffLines(signed: readonly ContentLine[], current: readonly ContentLine[]): LineChange[] {
  const before = new Map(signed.map((l) => [lineKey(l), l]));
  const after = new Map(current.map((l) => [lineKey(l), l]));
  const out: LineChange[] = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) {
      out.push({ key, before: b, after: null, fields: [] });
      continue;
    }
    const fields = (Object.keys(b) as (keyof ContentLine)[]).filter((f) => b[f] !== a[f]).sort();
    if (fields.length) out.push({ key, before: b, after: a, fields });
  }
  for (const [key, a] of after) if (!before.has(key)) out.push({ key, before: null, after: a, fields: [] });
  const signedOrder = signed.map(lineKey).filter((k) => after.has(k));
  const currentOrder = current.map(lineKey).filter((k) => before.has(k));
  if (out.length === 0 && signedOrder.join("|") !== currentOrder.join("|")) {
    out.push({ key: "order", before: null, after: null, fields: ["order"] });
  }
  return out;
}

/** Header fields (seals, parties, place, note) that differ between two contents. */
export function diffHeader(signed: Record<string, unknown>, current: Record<string, unknown>): string[] {
  const skip = new Set(["items", "itemsHash", "count"]);
  const keys = new Set([...Object.keys(signed), ...Object.keys(current)]);
  return [...keys].filter((k) => !skip.has(k) && contentHash(signed[k] ?? null) !== contentHash(current[k] ?? null));
}
