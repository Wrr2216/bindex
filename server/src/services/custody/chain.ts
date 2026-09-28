import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { custodyTransferItems, custodyTransfers, items } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { listSignatures } from "../media-ai-core";
import { OUTCOME_LABEL, purposeInfo } from "./model";
import { getControl } from "./policy";
import { currentCustodian, type ChainHop } from "./rules";

/**
 * An item's chain of custody: every completed transfer that included it,
 * oldest first, with both parties, the place, the seals, what the receiver
 * found, and the signatures. Transfers still being scanned or signed are
 * listed apart, as pending.
 */
export async function itemChain(itemId: string) {
  const [item] = await db
    .select({ id: items.id, name: items.name, assetCode: items.assetCode, parentItemId: items.parentItemId })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (!item) throw notFound("Item not found");

  const [control, rows] = await Promise.all([
    getControl(itemId),
    db
      .select({ t: custodyTransfers, l: custodyTransferItems })
      .from(custodyTransferItems)
      .innerJoin(custodyTransfers, eq(custodyTransferItems.transferId, custodyTransfers.id))
      .where(and(eq(custodyTransferItems.itemId, itemId), ne(custodyTransfers.status, "void")))
      .orderBy(asc(sql`coalesce(${custodyTransfers.at}, ${custodyTransfers.createdAt})`)),
  ]);

  // The container code for lines that travelled inside something.
  const parentIds = [...new Set(rows.flatMap((r) => (r.l.parentItemId ? [r.l.parentItemId] : [])))];
  const parents = parentIds.length
    ? await db.select({ id: items.id, assetCode: items.assetCode }).from(items).where(inArray(items.id, parentIds))
    : [];
  const codeOf = new Map(parents.map((p) => [p.id, p.assetCode]));

  const transferIds = [...new Set(rows.map((r) => r.t.id))];
  const sigLists = await Promise.all(transferIds.map((id) => listSignatures("custody_transfer", id)));
  const sigsOf = new Map(transferIds.map((id, i) => [id, sigLists[i]!]));

  const entries = rows.map(({ t, l }) => {
    const sigs = sigsOf.get(t.id) ?? [];
    const signature = (id: string | null, party: "from" | "to") => {
      const s = sigs.find((x) => x.id === id);
      return s
        ? { party, id: s.id, signerName: s.signerName, signedAt: s.signedAt, imageUrl: s.imageUrl, via: t.signing[party]?.via ?? "device" }
        : null;
    };
    return {
      transferId: t.id,
      code: t.code,
      status: t.status,
      purpose: t.purpose,
      purposeLabel: purposeInfo(t.purpose).label,
      at: t.at,
      createdAt: t.createdAt,
      from: { kind: t.fromKind, name: t.fromName, org: t.fromOrg },
      to: { kind: t.toKind, name: t.toName, org: t.toOrg },
      place: t.locationName,
      lat: t.lat,
      lng: t.lng,
      jobCode: t.jobCode,
      shipmentCode: t.shipmentCode,
      seals: t.sealNumbers,
      unitCode: l.unitCode,
      via: l.via,
      inside: l.parentItemId ? codeOf.get(l.parentItemId) ?? null : null,
      outcome: l.outcome,
      outcomeLabel: OUTCOME_LABEL[l.outcome],
      note: l.note,
      signatures: [signature(t.fromSignatureId, "from"), signature(t.toSignatureId, "to")].filter((s) => s !== null),
      hasReceipt: Boolean(t.receiptAttachmentId),
      auditEntryId: t.auditEntryId,
    };
  });

  const hops = entries.filter((e) => e.status === "completed");
  const pending = entries.filter((e) => e.status !== "completed");
  // The item as a whole is what "who holds it" means; unit-only lines speak
  // for one copy each and are shown on the hop instead.
  const wholeItem = hops.filter((h) => !h.unitCode);
  const custodian = currentCustodian(
    (wholeItem.length ? wholeItem : hops).map(
      (h): ChainHop => ({ transferId: h.transferId, at: h.at!, from: h.from, to: h.to, outcome: h.outcome }),
    ),
  );

  return {
    item,
    controlled: control.effective !== null,
    control: control.own ? { reason: control.own.reason, setBy: control.own.setBy, setAt: control.own.setAt } : null,
    controlledBy: control.effective?.container ?? null,
    custodian,
    hops,
    pending,
  };
}
