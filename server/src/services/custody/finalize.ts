import { and, eq, inArray } from "drizzle-orm";
import { pool, db } from "../../db/client";
import { jobItems, shipments, type CustodyTransfer, type CustodyTransferItem } from "../../db/schema";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { checkIn, checkInUnit, checkOut, checkOutUnit } from "../assignments";
import { getConfig } from "../config";
import { actorFromOid, publish, type EventActor } from "../event-backbone";
import { bulkUpdate } from "../items";
import { setLineStage, setShipmentStatus } from "../jobs-core";
import { getAttachment, listSignatures, readAttachmentBytes, saveAttachment, type Signature } from "../media-ai-core";
import { contentLines } from "./content";
import { OUTCOME_LABEL, outcomePasses, purposeInfo, stageForOutcome } from "./model";
import { renderReceiptPdf, type ReceiptDoc } from "./pdf";
import { countable, loadTransfer, recordEvidence, transferLines, type Actor } from "./transfers";

/**
 * What happens once a transfer is complete: the PDF receipt is written and
 * kept as an attachment of the transfer, the handoff is published to the
 * audit log (with the receipt's hash, so the paper can be checked against the
 * log), and the purpose's effect on the rest of the app is applied (delivery
 * stages on the job, check-outs, moves into storage).
 *
 * Each step records that it happened, so running this again after a crash
 * finishes what was left and repeats nothing.
 */

const baseUrl = () => env.APP_BASE_URL.replace(/\/+$/, "");
export const transferUrl = (id: string) => `${baseUrl()}/custody/transfers/${id}`;

/** Receipt times are UTC and to the second: a receipt travels between time zones. */
export const formatUtc = (d: Date | string | null) =>
  d ? `${new Date(d).toISOString().slice(0, 19).replace("T", " ")} UTC` : "";

const partyKind = (kind: string) => (kind === "entity" ? "Holder" : kind === "user" ? "Account" : "External party");

export function exceptionCounts(lines: Pick<CustodyTransferItem, "outcome">[]) {
  const counts = { missing: 0, damaged: 0, refused: 0 };
  for (const l of lines) if (l.outcome !== "accepted") counts[l.outcome] += 1;
  return counts;
}

export function receiptSummary(lines: Pick<CustodyTransferItem, "outcome" | "via">[]): string {
  const counted = countable(lines);
  const inside = lines.length - counted;
  const ex = exceptionCounts(lines);
  const parts = [`${counted} item${counted === 1 ? "" : "s"} handed over`];
  if (inside) parts[0] += `, with ${inside} more packed inside them`;
  const exceptions = (Object.entries(ex) as [keyof typeof ex, number][])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  parts.push(exceptions.length ? `Exceptions: ${exceptions.join(", ")}.` : "No exceptions.");
  return `${parts[0]}. ${parts[1]}`;
}

/** The receipt's content, from the stored record. */
export async function receiptDoc(t: CustodyTransfer, lines: CustodyTransferItem[], signatures: Signature[]): Promise<ReceiptDoc> {
  const codeOf = new Map(lines.map((l) => [l.itemId, l.assetCode]));
  const place = [t.locationName, t.lat !== null && t.lng !== null ? `${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}` : null]
    .filter(Boolean)
    .join("  ·  ");
  const facts: [string, string][] = [
    ["Purpose", purposeInfo(t.purpose).label],
    ["Handed over", formatUtc(t.at ?? t.completedAt) || "Not yet complete"],
  ];
  if (place) facts.push(["Place", place]);
  if (t.jobCode) facts.push(["Job", t.jobCode]);
  if (t.shipmentCode) facts.push(["Shipment", t.shipmentCode]);
  facts.push(["Seals", t.sealNumbers.length ? t.sealNumbers.join(", ") : "None recorded"]);
  if (t.conditionNote) facts.push(["Condition", t.conditionNote]);

  const signed = [
    { party: "from" as const, id: t.fromSignatureId, label: "Released by" },
    { party: "to" as const, id: t.toSignatureId, label: "Received by" },
  ];
  const sigs = await Promise.all(
    signed.flatMap(({ party, id, label }) => {
      const s = signatures.find((x) => x.id === id);
      if (!s) return [];
      return [
        (async () => {
          let image: ReceiptDoc["signatures"][number]["image"] = null;
          if (s.attachmentId) {
            const a = await getAttachment(s.attachmentId);
            const read = await readAttachmentBytes(s.attachmentId, 1024 * 1024).catch(() => null);
            if (a && read) image = { bytes: read.bytes, mime: a.mime };
          }
          return {
            label,
            signerName: s.signerName,
            signerRole: s.signerRole,
            signerEmail: s.signerEmail,
            signedAt: formatUtc(s.signedAt),
            statement: s.statement,
            contentHash: s.contentHash,
            via: t.signing[party]?.via ?? "device",
            image,
          };
        })(),
      ];
    }),
  );

  return {
    kicker: t.purpose === "delivery" ? "DELIVERY RECEIPT  ·  CHAIN OF CUSTODY" : "CHAIN OF CUSTODY RECEIPT",
    title: `${t.fromName} to ${t.toName}`,
    code: t.code,
    facts,
    parties: [
      { label: "Released by", name: t.fromName, org: t.fromOrg, kind: partyKind(t.fromKind) },
      { label: "Received by", name: t.toName, org: t.toOrg, kind: partyKind(t.toKind) },
    ],
    lines: lines.map((l, i) => ({
      index: i + 1,
      name: l.name,
      code: l.unitCode ?? l.assetCode,
      inside: l.via === "contained" && l.parentItemId ? codeOf.get(l.parentItemId) ?? null : null,
      outcome: OUTCOME_LABEL[l.outcome],
      exception: l.outcome !== "accepted",
      note: l.note,
    })),
    summary: receiptSummary(lines),
    signatures: sigs,
    itemsHash: t.contentHash ?? "",
    url: transferUrl(t.id),
  };
}

export async function renderReceipt(t: CustodyTransfer): Promise<Buffer> {
  const [lines, signatures, config] = await Promise.all([
    transferLines(t.id),
    listSignatures("custody_transfer", t.id),
    getConfig(),
  ]);
  return renderReceiptPdf(await receiptDoc(t, lines, signatures), formatUtc(new Date()), config.appName);
}

const MAX_EVENT_LINES = 500;

function completionActor(t: CustodyTransfer, actor: Actor | null, signatures: Signature[]): EventActor {
  if (actor?.userOid) return actorFromOid(actor.userOid, actor.name);
  // Completed by a signing link: the signer has no account.
  const last = signatures.find((s) => s.id === (t.toSignatureId ?? t.fromSignatureId));
  return { kind: "system", id: null, name: last ? `${last.signerName} (signing link)` : "Signing link" };
}

export type FinalizeResult = {
  receiptAttachmentId: string | null;
  auditEntryId: number | null;
  effects: Record<string, unknown> | null;
};

/**
 * Write the receipt, publish the handoff and apply its effects, each at most
 * once. Serialised per transfer with a session advisory lock, so a retry that
 * races the first attempt waits for it instead of publishing twice.
 */
export async function finalizeTransfer(id: string, actor: Actor | null): Promise<FinalizeResult> {
  const client = await pool.connect();
  const key = `custody-final:${id}`;
  let stuck = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      return await finalizeLocked(id, actor);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {
        stuck = true;
      });
    }
  } finally {
    // A connection that could not drop its lock must not go back to the pool holding it.
    client.release(stuck);
  }
}

async function finalizeLocked(id: string, actor: Actor | null): Promise<FinalizeResult> {
  let t = await loadTransfer(id);
  if (t.status !== "completed") return { receiptAttachmentId: null, auditEntryId: null, effects: null };
  const lines = await transferLines(id);
  const signatures = await listSignatures("custody_transfer", id);

  if (!t.receiptAttachmentId) {
    const pdf = await renderReceipt(t);
    const saved = await saveAttachment({
      ownerType: "custody_transfer",
      ownerId: id,
      kind: "document",
      mime: "application/pdf",
      bytes: pdf,
      stage: "receipt",
      caption: `Custody receipt ${t.code}`,
      meta: { filename: `${t.code}-receipt.pdf`, contentHash: t.contentHash },
      createdBy: actor?.userOid ?? null,
    });
    await recordEvidence(id, { receiptAttachmentId: saved.id });
    t = { ...t, receiptAttachmentId: saved.id };
    logger.info("custody.receipt.saved", { id, code: t.code, attachmentId: saved.id, bytes: pdf.length });
  }

  if (!t.auditEntryId) {
    const receipt = t.receiptAttachmentId ? await getAttachment(t.receiptAttachmentId) : null;
    const content = contentLines(lines);
    const entry = await publish(
      "custody.transferred",
      {
        code: t.code,
        purpose: t.purpose,
        at: t.at,
        from: { kind: t.fromKind, name: t.fromName, org: t.fromOrg, entityId: t.fromEntityId, userOid: t.fromUserOid },
        to: { kind: t.toKind, name: t.toName, org: t.toOrg, entityId: t.toEntityId, userOid: t.toUserOid },
        place: { locationId: t.locationId, name: t.locationName, lat: t.lat, lng: t.lng },
        jobId: t.jobId,
        jobCode: t.jobCode,
        shipmentId: t.shipmentId,
        shipmentCode: t.shipmentCode,
        seals: t.sealNumbers,
        count: lines.length,
        counted: countable(lines),
        exceptions: exceptionCounts(lines),
        itemsHash: t.contentHash,
        signatures: signatures
          .filter((s) => s.id === t.fromSignatureId || s.id === t.toSignatureId)
          .map((s) => ({
            party: s.id === t.fromSignatureId ? "from" : "to",
            id: s.id,
            signerName: s.signerName,
            signedAt: s.signedAt,
            contentHash: s.contentHash,
            via: t.signing[s.id === t.fromSignatureId ? "from" : "to"]?.via ?? "device",
          })),
        receipt: receipt ? { attachmentId: receipt.id, sha256: receipt.sha256 } : null,
        truncated: content.length > MAX_EVENT_LINES,
        lines: content.slice(0, MAX_EVENT_LINES).map((l) => ({
          itemId: l.itemId,
          unitId: l.unitId,
          assetCode: l.unitCode ?? l.assetCode,
          outcome: l.outcome,
        })),
      },
      { actor: completionActor(t, actor, signatures), subject: { type: "custody_transfer", id } },
    );
    if (entry) {
      await recordEvidence(id, { auditEntryId: entry.id, auditHash: entry.hash });
      t = { ...t, auditEntryId: entry.id, auditHash: entry.hash };
    }
  }

  let effects = (t.metadata.effects as Record<string, unknown> | undefined) ?? null;
  if (!effects) {
    effects = await applyEffects(t, lines, actor);
    await recordEvidence(id, { metadata: { effects } });
  }
  return { receiptAttachmentId: t.receiptAttachmentId, auditEntryId: t.auditEntryId, effects };
}

/** Whole items and units handed over, not what travels inside them. */
const handedOver = (lines: CustodyTransferItem[]) => lines.filter((l) => l.via !== "contained" && outcomePasses(l.outcome));

async function applyEffects(t: CustodyTransfer, lines: CustodyTransferItem[], actor: Actor | null) {
  const errors: string[] = [];
  const note = `Custody transfer ${t.code}`;
  const userOid = actor?.userOid ?? null;
  const out: Record<string, unknown> = { appliedAt: new Date().toISOString() };
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      logger.warn("custody.effect.failed", { id: t.id, what, err: describeError(err) });
      return null;
    }
  };

  if (t.purpose === "delivery" && t.jobId) out.stages = await applyDeliveryStages(t, lines, actor, attempt);

  if (t.purpose === "checkout" && t.toKind === "entity" && t.toEntityId) {
    let n = 0;
    for (const l of handedOver(lines)) {
      const ok = await attempt(l.unitCode ?? l.assetCode, async () => {
        if (l.unitId) await checkOutUnit(l.unitId, t.toEntityId!, userOid, note);
        else await checkOut(l.itemId, t.toEntityId!, userOid, note);
        return true;
      });
      if (ok) n++;
    }
    out.checkedOut = n;
  }

  if (t.purpose === "return") {
    let n = 0;
    for (const l of handedOver(lines)) {
      // Something that was never checked out has nothing to return; not an error.
      const back: Promise<unknown> = l.unitId ? checkInUnit(l.unitId, userOid, note) : checkIn(l.itemId, userOid, note);
      const ok = await back.then(
        () => true,
        () => false,
      );
      if (ok) n++;
    }
    out.checkedIn = n;
  }

  if (t.purpose === "storage" && t.locationId) {
    const ids = [...new Set(handedOver(lines).filter((l) => !l.unitId).map((l) => l.itemId))];
    const moved = await attempt("move", () => bulkUpdate(ids, { locationId: t.locationId }, userOid));
    out.moved = moved ? moved.updated : 0;
  }

  if (errors.length) out.errors = errors;
  return out;
}

async function applyDeliveryStages(
  t: CustodyTransfer,
  lines: CustodyTransferItem[],
  actor: Actor | null,
  attempt: <T>(what: string, fn: () => Promise<T>) => Promise<T | null>,
) {
  const jobId = t.jobId!;
  // Lines from a sign-off name their manifest line; scanned ones are matched
  // to the job's line for the same item and unit.
  const onJob = await db
    .select({ id: jobItems.id, itemId: jobItems.itemId, unitId: jobItems.unitId })
    .from(jobItems)
    .where(and(eq(jobItems.jobId, jobId), inArray(jobItems.itemId, [...new Set(lines.map((l) => l.itemId))])));
  const lineFor = new Map(onJob.map((j) => [`${j.itemId}:${j.unitId ?? ""}`, j.id]));
  const known = new Set(onJob.map((j) => j.id));

  const byStage = new Map<string, string[]>();
  for (const l of lines) {
    const jobItemId = l.jobItemId && known.has(l.jobItemId) ? l.jobItemId : lineFor.get(`${l.itemId}:${l.unitId ?? ""}`);
    if (!jobItemId) continue;
    const stage = stageForOutcome(l.outcome);
    byStage.set(stage, [...(byStage.get(stage) ?? []), jobItemId]);
  }

  const result: Record<string, { changed: number; already: number; blocked: number }> = {};
  for (const [stage, ids] of byStage) {
    const r = await attempt(`stage ${stage}`, () =>
      setLineStage(jobId, ids, stage, {
        via: "custody",
        userOid: actor?.userOid ?? null,
        actor: actor?.name ?? t.toName,
        note: `Delivery signed on ${t.code}`,
      }),
    );
    if (r) result[stage] = { changed: r.advanced.length, already: r.alreadyAt.length, blocked: r.blocked.length };
  }

  // A sign-off made for a shipment also says the shipment arrived.
  let shipment: string | null = null;
  if (t.shipmentId && t.metadata.signOff === true) {
    const [s] = await db.select({ status: shipments.status }).from(shipments).where(eq(shipments.id, t.shipmentId)).limit(1);
    if (s && !hasShipmentArrived(s.status)) {
      const moved = await attempt("shipment delivered", () =>
        setShipmentStatus(
          t.shipmentId!,
          "delivered",
          {},
          { userOid: actor?.userOid ?? null, name: actor?.name ?? `${t.toName} (signing link)` },
        ),
      );
      shipment = moved ? "delivered" : null;
    }
  }
  return { ...result, shipment };
}

const hasShipmentArrived = (status: string) => status === "delivered" || status === "closed";

