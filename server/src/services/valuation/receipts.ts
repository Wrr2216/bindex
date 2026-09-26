import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { itemIdentifiers, itemUnits, items, users } from "../../db/schema";
import { receiptLines, receipts, type ReceiptLineRow, type ReceiptRow } from "../../db/tables/valuation";
import { env } from "../../env";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { visionJson } from "../ai";
import { getConfig } from "../config";
import { actorFromOid, publish } from "../event-backbone";
import { createItem } from "../items";
import { deleteAttachmentsForOwner, listAttachments, readAttachmentBytes, type Attachment } from "../media-ai-core";
import { findTaken } from "../media-ai-core/dataPlate";
import { proposeMatches, type LineProposal, type MatchCandidate } from "./matching";
import { cleanText, latestDay, squash } from "./parse";
import { pdfReadingAvailable, pdfToImages } from "./pdfImages";
import { upsertProfileTx } from "./profiles";
import { RECEIPT_PROMPT, RECEIPT_SYSTEM, normalizeReceipt, type ReceiptReading } from "./receiptParse";
import { warrantyEndFrom } from "./schedule";
import { recordValuation } from "./valuations";

/**
 * Receipts: a photo or PDF of a purchase, read into lines, each line matched
 * to the item it bought, and on confirmation the purchase date, price, vendor
 * (and warranty, when printed) saved on every matched item or unit.
 *
 * The file is stored once, as an attachment of the receipt; every item it is
 * matched to links back to it rather than holding a copy.
 */

export type ReceiptSummary = ReceiptRow & { lineCount: number; matchedCount: number; fileCount: number; thumbUrl: string | null };
/** A line with the name of what it is matched to, for showing without another lookup. */
export type ReceiptLineDetail = ReceiptLineRow & { itemName: string | null; unitLabel: string | null };

export type ReceiptDetail = ReceiptRow & {
  lines: ReceiptLineDetail[];
  files: Attachment[];
  createdByName: string | null;
  confirmedByName: string | null;
};

export async function createReceipt(input: { notes?: string | null }, userOid: string | null): Promise<ReceiptDetail> {
  const { currency } = await getConfig();
  const [row] = await db
    .insert(receipts)
    .values({ currency, notes: cleanText(input.notes, 2000), createdBy: userOid })
    .returning();
  return getReceipt(row!.id);
}

export async function getReceipt(id: string): Promise<ReceiptDetail> {
  const [row] = await db.select().from(receipts).where(eq(receipts.id, id)).limit(1);
  if (!row) throw notFound("That receipt no longer exists.");
  const [lines, files, names] = await Promise.all([
    db
      .select({ line: receiptLines, itemName: items.name, unitLabel: sql<string | null>`coalesce(${itemUnits.label}, ${itemUnits.serial}, ${itemUnits.assetCode})` })
      .from(receiptLines)
      .leftJoin(items, eq(items.id, receiptLines.itemId))
      .leftJoin(itemUnits, eq(itemUnits.id, receiptLines.unitId))
      .where(eq(receiptLines.receiptId, id))
      .orderBy(asc(receiptLines.position))
      .then((rows) => rows.map((r) => ({ ...r.line, itemName: r.itemName ?? null, unitLabel: r.unitLabel ?? null }))),
    listAttachments("receipt", id, { kind: ["photo", "document"] }),
    db
      .select({ oid: users.oid, name: users.name })
      .from(users)
      .where(inArray(users.oid, [row.createdBy, row.confirmedBy].filter((x): x is string => Boolean(x)).concat(["-"]))),
  ]);
  const name = (oid: string | null) => names.find((n) => n.oid === oid)?.name ?? null;
  return { ...row, lines, files, createdByName: name(row.createdBy), confirmedByName: name(row.confirmedBy) };
}

/** Receipts newest first; with `itemId`, only those with a line matched to that item. */
export async function listReceipts(opts: { itemId?: string; status?: "draft" | "confirmed"; limit?: number } = {}): Promise<ReceiptSummary[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.itemId) {
    params.push(opts.itemId);
    where.push(`EXISTS (SELECT 1 FROM receipt_lines l WHERE l.receipt_id = r.id AND l.item_id = $${params.length})`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`r.status = $${params.length}`);
  }
  params.push(Math.min(500, opts.limit ?? 100));
  const { rows } = await pool.query(
    `SELECT r.id, r.status, r.vendor, r.purchase_date::text AS "purchaseDate", r.currency,
            r.subtotal_cents::float8 AS "subtotalCents", r.tax_cents::float8 AS "taxCents", r.total_cents::float8 AS "totalCents",
            r.notes, r.created_by AS "createdBy", r.created_at AS "createdAt", r.updated_at AS "updatedAt",
            r.confirmed_at AS "confirmedAt", r.confirmed_by AS "confirmedBy",
            (SELECT count(*)::int FROM receipt_lines l WHERE l.receipt_id = r.id) AS "lineCount",
            (SELECT count(*)::int FROM receipt_lines l WHERE l.receipt_id = r.id AND l.item_id IS NOT NULL) AS "matchedCount",
            (SELECT count(*)::int FROM attachments a WHERE a.owner_type = 'receipt' AND a.owner_id = r.id AND a.kind IN ('photo','document')) AS "fileCount",
            (SELECT a.id FROM attachments a WHERE a.owner_type = 'receipt' AND a.owner_id = r.id AND a.kind = 'photo'
              ORDER BY a.created_at LIMIT 1) AS "thumbId"
       FROM receipts r
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY coalesce(r.purchase_date, r.created_at::date) DESC, r.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(({ thumbId, ...r }) => ({
    ...r,
    reading: null,
    thumbUrl: thumbId ? `/api/attachments/${thumbId}/thumb` : null,
  })) as ReceiptSummary[];
}

export type ReceiptLineInput = {
  description: string;
  quantity?: number | null;
  unitPriceCents?: number | null;
  totalCents?: number | null;
  sku?: string | null;
  serial?: string | null;
  warrantyMonths?: number | null;
  itemId?: string | null;
  unitId?: string | null;
};

export type ReceiptPatch = {
  vendor?: string | null;
  purchaseDate?: string | null;
  currency?: string | null;
  subtotalCents?: number | null;
  taxCents?: number | null;
  totalCents?: number | null;
  notes?: string | null;
  /** The whole list; replaces what is there. */
  lines?: ReceiptLineInput[];
};

function lineValues(receiptId: string, lines: ReceiptLineInput[]) {
  return lines.map((l, i) => {
    const description = cleanText(l.description, 300);
    if (!description) throw badRequest(`Line ${i + 1} needs a description.`);
    const quantity = l.quantity ?? 1;
    if (!(quantity > 0)) throw badRequest(`Line ${i + 1}: the quantity must be above zero.`);
    return {
      receiptId,
      position: i + 1,
      description,
      quantity,
      unitPriceCents: l.unitPriceCents ?? null,
      totalCents: l.totalCents ?? (l.unitPriceCents != null ? Math.round(l.unitPriceCents * quantity) : null),
      sku: cleanText(l.sku, 80),
      serial: cleanText(l.serial, 80),
      warrantyMonths: l.warrantyMonths ?? null,
      itemId: l.itemId ?? null,
      unitId: l.itemId ? (l.unitId ?? null) : null,
    };
  });
}

/** Edit a draft receipt. After confirmation only the notes can change. */
export async function updateReceipt(id: string, patch: ReceiptPatch): Promise<ReceiptDetail> {
  const [row] = await db.select().from(receipts).where(eq(receipts.id, id)).limit(1);
  if (!row) throw notFound("That receipt no longer exists.");
  const onlyNotes = Object.keys(patch).every((k) => k === "notes");
  if (row.status === "confirmed" && !onlyNotes) {
    throw conflict("This receipt is confirmed and its lines are saved on items. Only its notes can change.");
  }
  if (patch.purchaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.purchaseDate)) throw badRequest("Write the date as YYYY-MM-DD.");
  if (patch.purchaseDate && patch.purchaseDate > latestDay()) throw badRequest("The purchase date cannot be in the future.");
  await db.transaction(async (tx) => {
    await tx
      .update(receipts)
      .set({
        ...(patch.vendor !== undefined ? { vendor: cleanText(patch.vendor, 120) } : {}),
        ...(patch.purchaseDate !== undefined ? { purchaseDate: patch.purchaseDate } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency?.toUpperCase() ?? null } : {}),
        ...(patch.subtotalCents !== undefined ? { subtotalCents: patch.subtotalCents } : {}),
        ...(patch.taxCents !== undefined ? { taxCents: patch.taxCents } : {}),
        ...(patch.totalCents !== undefined ? { totalCents: patch.totalCents } : {}),
        ...(patch.notes !== undefined ? { notes: cleanText(patch.notes, 2000) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(receipts.id, id));
    if (patch.lines) {
      await tx.delete(receiptLines).where(eq(receiptLines.receiptId, id));
      const values = lineValues(id, patch.lines);
      if (values.length) await tx.insert(receiptLines).values(values);
    }
  });
  return getReceipt(id);
}

// ---- Reading with AI ------------------------------------------------------------

export type ReadResult = {
  available: boolean;
  found: boolean;
  reading: ReceiptReading | null;
  receipt: ReceiptDetail;
  message?: string;
};

/**
 * Read the receipt's files with the vision model and replace the draft's
 * header and lines with what was read. Photos go as they are; PDFs are drawn
 * as images first when pdftoppm is available.
 */
export async function readReceipt(id: string, userOid: string | null): Promise<ReadResult> {
  const receipt = await getReceipt(id);
  if (receipt.status === "confirmed") throw conflict("This receipt is already confirmed. Start a new one to read it again.");
  if (!env.llmVisionConfigured) return { available: false, found: false, reading: null, receipt };
  if (!receipt.files.length) throw badRequest("Add a photo or PDF of the receipt first.");

  const images: { mime: string; bytes: Buffer }[] = [];
  let skippedPdf = false;
  for (const file of receipt.files.slice(0, 6)) {
    const { bytes } = await readAttachmentBytes(file.id, 25 * 1024 * 1024);
    if (file.mime.startsWith("image/")) images.push({ mime: file.mime, bytes });
    else if (file.mime === "application/pdf") {
      const pages = await pdfToImages(bytes, 3);
      if (pages) images.push(...pages.map((p) => ({ mime: "image/png", bytes: p })));
      else skippedPdf = true;
    }
  }
  if (!images.length) {
    return {
      available: true,
      found: false,
      reading: null,
      receipt,
      message: skippedPdf && !pdfReadingAvailable()
        ? "PDF receipts cannot be read on this server (poppler-utils is not installed). Photograph the receipt instead, or enter the lines by hand."
        : "Nothing in this receipt could be read. Add a photo of it.",
    };
  }

  const config = await getConfig();
  const raw = await visionJson({
    event: "ai.receipt",
    system: RECEIPT_SYSTEM,
    prompt: RECEIPT_PROMPT,
    images: images.slice(0, 10),
    maxTokens: 3000,
    context: { receiptId: id, user: userOid },
  });
  const reading = normalizeReceipt(raw, { locale: config.locale, currency: receipt.currency ?? config.currency });
  if (!reading) {
    logger.info("valuation.receipt.read", { id, found: false });
    return { available: true, found: false, reading: null, receipt, message: "No receipt could be read. Try a flatter, sharper photo in good light." };
  }

  await db
    .update(receipts)
    .set({ reading: reading as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(receipts.id, id));
  const updated = await updateReceipt(id, {
    vendor: reading.vendor,
    purchaseDate: reading.purchaseDate,
    currency: reading.currency,
    subtotalCents: reading.subtotalCents,
    taxCents: reading.taxCents,
    totalCents: reading.totalCents,
    lines: reading.lines,
  });
  logger.info("valuation.receipt.read", { id, found: true, lines: reading.lines.length, warnings: reading.warnings.length });
  return { available: true, found: true, reading, receipt: updated };
}

// ---- Matching ---------------------------------------------------------------------

const PRODUCT_CODES = ["sku", "upc"] as const;

/** Candidate items for a set of receipt lines: exact code and serial hits, then the closest names. */
async function fetchCandidates(lines: { description: string; sku: string | null; serial: string | null }[]): Promise<MatchCandidate[]> {
  const codes = [...new Set(lines.flatMap((l) => [squash(l.serial), squash(l.sku)]).filter((c) => c.length >= 4))];
  const ids = new Set<string>();
  if (codes.length) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT item_id AS id FROM item_identifiers
        WHERE type IN ('serial','sku','upc','asset_tag') AND upper(regexp_replace(value, '[^0-9A-Za-z]', '', 'g')) = ANY($1)
       UNION
       SELECT item_id FROM item_units WHERE upper(regexp_replace(coalesce(serial,''), '[^0-9A-Za-z]', '', 'g')) = ANY($1)
       UNION
       SELECT id FROM items WHERE upper(regexp_replace(coalesce(model,''), '[^0-9A-Za-z]', '', 'g')) = ANY($1)`,
      [codes],
    );
    rows.forEach((r) => ids.add(r.id));
  }
  for (const line of lines) {
    const text = `${line.description} ${line.sku ?? ""}`.trim();
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM items
        WHERE category IS DISTINCT FROM 'Domain'
        ORDER BY greatest(similarity(name, $1), similarity(concat_ws(' ', brand, name, model), $1),
                          CASE WHEN length(coalesce(model, '')) >= 4 THEN word_similarity(model, $1) ELSE 0 END) DESC,
                 updated_at DESC
        LIMIT 8`,
      [text],
    );
    rows.forEach((r) => ids.add(r.id));
  }
  if (!ids.size) return [];
  const list = [...ids];
  const [itemRows, idRows, unitRows] = await Promise.all([
    db.select({ id: items.id, name: items.name, brand: items.brand, model: items.model, assetCode: items.assetCode }).from(items).where(inArray(items.id, list)),
    db
      .select({ itemId: itemIdentifiers.itemId, type: itemIdentifiers.type, value: itemIdentifiers.value })
      .from(itemIdentifiers)
      .where(and(inArray(itemIdentifiers.itemId, list), inArray(itemIdentifiers.type, ["serial", ...PRODUCT_CODES]))),
    db.select({ id: itemUnits.id, itemId: itemUnits.itemId, serial: itemUnits.serial, label: itemUnits.label }).from(itemUnits).where(inArray(itemUnits.itemId, list)),
  ]);
  return itemRows.map((i) => ({
    itemId: i.id,
    name: i.name,
    brand: i.brand,
    model: i.model,
    assetCode: i.assetCode,
    serials: idRows.filter((r) => r.itemId === i.id && r.type === "serial").map((r) => r.value),
    codes: idRows.filter((r) => r.itemId === i.id && (PRODUCT_CODES as readonly string[]).includes(r.type)).map((r) => r.value),
    units: unitRows.filter((u) => u.itemId === i.id).map((u) => ({ id: u.id, serial: u.serial, label: u.label })),
  }));
}

/** Proposed matches for every line of a receipt, in line order. Saves nothing. */
export async function receiptMatches(id: string, preferItemId?: string | null): Promise<LineProposal[]> {
  const lines = await db.select().from(receiptLines).where(eq(receiptLines.receiptId, id)).orderBy(asc(receiptLines.position));
  if (!lines.length) return [];
  const candidates = await fetchCandidates(lines);
  return proposeMatches(lines, candidates, preferItemId);
}

// ---- Confirming ---------------------------------------------------------------------

export type ConfirmLine = {
  lineId: string;
  /** The item this line bought, or null to leave it unmatched. */
  itemId?: string | null;
  unitId?: string | null;
  /** Create a new item from the line instead of matching one. */
  create?: boolean;
  /** Also record the price paid as the record's value. */
  setValue?: boolean;
  /** Save a warranty end from the line's warranty months. Default on when the line has one. */
  setWarranty?: boolean;
};

export type ConfirmResult = {
  receipt: ReceiptDetail;
  /** Records the purchase was saved on. */
  matched: { lineId: string; itemId: string; unitId: string | null; created: boolean; valued: boolean }[];
  /** Things that were not done, with the reason, for the person to follow up. */
  notes: string[];
};

/**
 * Save each confirmed line on its item or unit: purchase date, price paid,
 * vendor and a link to this receipt; the warranty end when the line states
 * one; and, when asked, the price as a new valuation. Lines left unmatched are
 * kept on the receipt without touching anything.
 */
export async function confirmReceipt(id: string, decisions: ConfirmLine[], userOid: string | null): Promise<ConfirmResult> {
  const receipt = await getReceipt(id);
  if (receipt.status === "confirmed") throw conflict("This receipt is already confirmed.");
  if (!receipt.purchaseDate) throw badRequest("Enter the purchase date before confirming.");
  const byLine = new Map(receipt.lines.map((l) => [l.id, l]));
  for (const d of decisions) if (!byLine.has(d.lineId)) throw badRequest("A line changed while you were reviewing. Reload the receipt.");

  // Check every target before writing anything.
  const targetItemIds = [...new Set(decisions.filter((d) => d.itemId && !d.create).map((d) => d.itemId!))];
  const [found, unitRows] = await Promise.all([
    targetItemIds.length ? db.select({ id: items.id, name: items.name }).from(items).where(inArray(items.id, targetItemIds)) : [],
    targetItemIds.length
      ? db.select({ id: itemUnits.id, itemId: itemUnits.itemId }).from(itemUnits).where(inArray(itemUnits.itemId, targetItemIds))
      : [],
  ]);
  for (const d of decisions) {
    if (!d.itemId || d.create) continue;
    if (!found.some((f) => f.id === d.itemId)) throw notFound(`Line ${byLine.get(d.lineId)!.position} is matched to an item that no longer exists.`);
    if (d.unitId && !unitRows.some((u) => u.id === d.unitId && u.itemId === d.itemId)) {
      throw badRequest(`Line ${byLine.get(d.lineId)!.position} is matched to a unit of a different item.`);
    }
  }

  const notes: string[] = [];
  type Resolved = { line: ReceiptLineRow; itemId: string; unitId: string | null; created: boolean; d: ConfirmLine };
  const resolved: Resolved[] = [];
  for (const d of decisions) {
    const line = byLine.get(d.lineId)!;
    if (d.create) {
      const taken = line.serial ? await findTaken({ serial: line.serial }) : { serial: null };
      const identifiers = [
        ...(line.sku ? [{ type: "sku" as const, value: line.sku }] : []),
        ...(line.serial && !taken.serial ? [{ type: "serial" as const, value: line.serial }] : []),
      ];
      if (line.serial && taken.serial) notes.push(`Line ${line.position}: serial ${line.serial} is already on "${taken.serial.itemName}", so it was not added to the new item.`);
      const item = await createItem(
        {
          name: line.description,
          quantity: Math.max(1, Math.round(line.quantity)),
          enrichmentSource: "receipt",
          identifiers,
        },
        userOid,
      );
      resolved.push({ line, itemId: item.id, unitId: null, created: true, d });
    } else if (d.itemId) {
      resolved.push({ line, itemId: d.itemId, unitId: d.unitId ?? null, created: false, d });
    }
  }

  // Several lines can go to one record (the laptop and its protection plan).
  // The record gets one set of purchase facts: the price of its dearest line,
  // which is the thing itself rather than an add-on, and the longest warranty
  // any of its lines states.
  const paidFor = (r: Resolved) => (r.unitId ? r.line.unitPriceCents : (r.line.totalCents ?? r.line.unitPriceCents));
  const groups = new Map<string, Resolved[]>();
  for (const r of resolved) {
    const key = `${r.itemId}|${r.unitId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const primaries = [...groups.values()].map((list) => {
    const primary = list.reduce((a, b) => ((paidFor(b) ?? -1) > (paidFor(a) ?? -1) ? b : a));
    const months = Math.max(0, ...list.filter((r) => r.d.setWarranty !== false).map((r) => r.line.warrantyMonths ?? 0));
    if (list.length > 1) {
      const others = list.filter((r) => r !== primary).map((r) => r.line.position).join(", ");
      notes.push(`Lines ${primary.line.position} and ${others} are the same record: its purchase price is from line ${primary.line.position}.`);
    }
    return { primary, months, setValue: list.some((r) => r.d.setValue) };
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { primary: r, months } of primaries) {
      await upsertProfileTx(client, r.itemId, r.unitId, {
        purchaseDate: receipt.purchaseDate,
        purchaseCents: paidFor(r),
        vendor: receipt.vendor,
        receiptId: receipt.id,
        ...(months ? { warrantyEnds: warrantyEndFrom(receipt.purchaseDate, months), warrantyTerms: `${months} months, from the receipt` } : {}),
      });
    }
    for (const r of resolved) {
      await client.query(`UPDATE receipt_lines SET item_id = $2, unit_id = $3 WHERE id = $1`, [r.line.id, r.itemId, r.unitId]);
    }
    const matchedIds = new Set(resolved.map((r) => r.line.id));
    const unmatched = receipt.lines.filter((l) => !matchedIds.has(l.id)).map((l) => l.id);
    if (unmatched.length) await client.query(`UPDATE receipt_lines SET item_id = NULL, unit_id = NULL WHERE id = ANY($1)`, [unmatched]);
    await client.query(`UPDATE receipts SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, updated_at = now() WHERE id = $1`, [
      receipt.id,
      userOid,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const valued = new Set<string>();
  for (const { primary: r, setValue } of primaries) {
    const paid = paidFor(r);
    if (!setValue || paid == null || paid < 0) continue;
    try {
      await recordValuation(
        {
          itemId: r.itemId,
          unitId: r.unitId,
          valueCents: paid,
          source: "receipt",
          basis: `Price paid${receipt.vendor ? ` at ${receipt.vendor}` : ""} on ${receipt.purchaseDate}, from receipt line ${r.line.position}`,
          valuedOn: receipt.purchaseDate,
          // Not "description": that key describes the item itself (from an AI
          // estimate) and is what declarations and the report show.
          details: { receiptId: receipt.id, lineId: r.line.id, receiptLine: r.line.description },
        },
        userOid,
      );
      valued.add(r.line.id);
    } catch (err) {
      notes.push(`Line ${r.line.position}: the price was not recorded as a value (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const matched: ConfirmResult["matched"] = resolved.map((r) => ({
    lineId: r.line.id,
    itemId: r.itemId,
    unitId: r.unitId,
    created: r.created,
    valued: valued.has(r.line.id),
  }));

  await publish(
    "receipt.confirmed",
    {
      receiptId: receipt.id,
      vendor: receipt.vendor,
      purchaseDate: receipt.purchaseDate,
      totalCents: receipt.totalCents,
      currency: receipt.currency,
      lines: receipt.lines.length,
      matched: matched.map((m) => ({ itemId: m.itemId, unitId: m.unitId, created: m.created })),
    },
    { actor: actorFromOid(userOid), subject: { type: "receipt", id: receipt.id } },
  );
  logger.info("valuation.receipt.confirmed", { id, matched: matched.length, lines: receipt.lines.length });
  return { receipt: await getReceipt(id), matched, notes };
}

/**
 * Delete a receipt and its files. A confirmed receipt's facts are saved on
 * items, so only an administrator may delete one; the items keep their
 * purchase facts but lose the link.
 */
export async function deleteReceipt(id: string, isAdmin: boolean): Promise<void> {
  const [row] = await db.select({ status: receipts.status }).from(receipts).where(eq(receipts.id, id)).limit(1);
  if (!row) throw notFound("That receipt no longer exists.");
  if (row.status === "confirmed" && !isAdmin) {
    throw forbidden("This receipt is confirmed and its facts are saved on items. Ask an administrator to delete it.");
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE valuation_profiles SET receipt_id = NULL, updated_at = now() WHERE receipt_id = ${id}`);
    await tx.delete(receipts).where(eq(receipts.id, id));
  });
  await deleteAttachmentsForOwner("receipt", id);
  logger.info("valuation.receipt.deleted", { id });
}

/** Receipts matched to an item, newest first, for the item page. */
export const receiptsForItem = (itemId: string) => listReceipts({ itemId, limit: 50 });

