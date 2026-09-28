import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { companies, locations, users } from "../../db/schema";
import {
  hvDeclarationLines,
  hvDeclarations,
  type DeclarationScope,
  type HvDeclarationLineRow,
  type HvDeclarationRow,
} from "../../db/tables/valuation";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { actorFromOid, publish } from "../event-backbone";
import { deleteAttachmentsForOwner, getSignature, verifySignature, type Signature, type VerifyResult } from "../media-ai-core";
import { cleanText } from "./parse";
import { moneyFormatter } from "./pdfShared";
import { valuedRecords, type ValuedRecord } from "./records";
import { isHighValue } from "./schedule";
import { getValuationSettings } from "./settings";

/**
 * High-value declarations: a numbered list (HVI-00001) of items and the value
 * declared for each, signed and dated by the person declaring them.
 *
 * Each line is a snapshot of the item as declared, so the signed record keeps
 * saying what was declared however the item changes later. The signature
 * covers a canonical JSON of the declaration built by declarationContent();
 * verifying rebuilds it from the rows as they are now, so any edit after
 * signing, even directly in the database, shows as a mismatch.
 */

export const OWNER_TYPE = "hv_declaration";

export type DeclarationContent = {
  declaration: string;
  title: string;
  scope: { type: DeclarationScope; label: string | null };
  currency: string;
  notes: string | null;
  lines: {
    position: number;
    name: string;
    brand: string | null;
    model: string | null;
    serial: string | null;
    assetCode: string | null;
    description: string | null;
    materials: string | null;
    condition: string | null;
    declaredCents: number;
    valueSource: string | null;
    notes: string | null;
  }[];
  totalCents: number;
};

/** What a signature on this declaration covers. Keep in step with verification: it is the same function. */
export function declarationContent(d: HvDeclarationRow, lines: HvDeclarationLineRow[]): DeclarationContent {
  const sorted = [...lines].sort((a, b) => a.position - b.position);
  return {
    declaration: d.code,
    title: d.title,
    scope: { type: d.scope, label: d.scopeLabel },
    currency: d.currency,
    notes: d.notes,
    lines: sorted.map((l) => ({
      position: l.position,
      name: l.name,
      brand: l.brand,
      model: l.model,
      serial: l.serial,
      assetCode: l.assetCode,
      description: l.description,
      materials: l.materials,
      condition: l.condition,
      declaredCents: l.declaredCents,
      valueSource: l.valueSource,
      notes: l.notes,
    })),
    totalCents: sorted.reduce((n, l) => n + l.declaredCents, 0),
  };
}

/** The words the signer agrees to. */
export function declarationStatement(content: DeclarationContent, locale: string): string {
  const money = moneyFormatter(content.currency, locale);
  const n = content.lines.length;
  const estimated = content.lines.some((l) => l.valueSource === "ai");
  return (
    `I declare that the ${n} item${n === 1 ? "" : "s"} listed on high-value declaration ${content.declaration} ` +
    `${n === 1 ? "is" : "are"} described accurately and that the values shown are the values I declare, ${money(content.totalCents)} in total.` +
    (estimated ? " Values marked as AI estimates are estimates made from photos, not appraisals, and I have checked them." : "")
  );
}

export type DeclarationSummary = HvDeclarationRow & { lineCount: number; totalCents: number; createdByName: string | null };

export type DeclarationDetail = HvDeclarationRow & {
  lines: HvDeclarationLineRow[];
  totalCents: number;
  createdByName: string | null;
  /** Exactly what to pass to the signature dialog, and the words to show. */
  signingContent: DeclarationContent;
  statement: string;
  signature: Signature | null;
  /** For a signed declaration: whether it still matches what was signed. */
  verification: VerifyResult | null;
};

export async function listDeclarations(limit = 200): Promise<DeclarationSummary[]> {
  const rows = await db
    .select({
      d: hvDeclarations,
      lineCount: sql<number>`(SELECT count(*)::int FROM hv_declaration_lines l WHERE l.declaration_id = ${hvDeclarations.id})`,
      totalCents: sql<number>`(SELECT coalesce(sum(l.declared_cents), 0)::float8 FROM hv_declaration_lines l WHERE l.declaration_id = ${hvDeclarations.id})`,
      createdByName: users.name,
    })
    .from(hvDeclarations)
    .leftJoin(users, eq(users.oid, hvDeclarations.createdBy))
    .orderBy(desc(hvDeclarations.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.d, lineCount: r.lineCount, totalCents: Number(r.totalCents), createdByName: r.createdByName ?? null }));
}

async function loadRow(id: string): Promise<HvDeclarationRow> {
  const [row] = await db.select().from(hvDeclarations).where(eq(hvDeclarations.id, id)).limit(1);
  if (!row) throw notFound("That declaration no longer exists.");
  return row;
}

const loadLines = (id: string) =>
  db.select().from(hvDeclarationLines).where(eq(hvDeclarationLines.declarationId, id)).orderBy(asc(hvDeclarationLines.position));

export async function getDeclaration(id: string): Promise<DeclarationDetail> {
  const row = await loadRow(id);
  const [lines, config, creator] = await Promise.all([
    loadLines(id),
    getConfig(),
    row.createdBy ? db.select({ name: users.name }).from(users).where(eq(users.oid, row.createdBy)).limit(1) : [],
  ]);
  const content = declarationContent(row, lines);
  const signature = row.signatureId ? await getSignature(row.signatureId) : null;
  const verification = row.signatureId ? await verifySignature(row.signatureId, content) : null;
  return {
    ...row,
    lines,
    totalCents: content.totalCents,
    createdByName: creator[0]?.name ?? null,
    signingContent: content,
    statement: declarationStatement(content, config.locale),
    signature,
    verification,
  };
}

function assertDraft(row: HvDeclarationRow): void {
  if (row.status !== "draft") {
    throw conflict(`${row.code} is signed and cannot change. Start a new declaration to declare different values.`);
  }
}

export type CreateDeclarationInput = {
  title?: string | null;
  scope: DeclarationScope;
  /** A company or location id, for those scopes. */
  scopeId?: string | null;
  /** For a job: its reference or name. Ignored for the other scopes, which use the record's name. */
  scopeLabel?: string | null;
  notes?: string | null;
  /** Fill it with every high-value record in the scope. */
  populate?: boolean;
  /** Also add these items. */
  itemIds?: string[];
};

async function scopeLabelFor(scope: DeclarationScope, scopeId: string | null | undefined, given: string | null | undefined): Promise<{ id: string | null; label: string | null }> {
  if (scope === "job") {
    // Jobs are not a record in this build; the reference is kept as text.
    const label = cleanText(given, 200);
    if (!label) throw badRequest("Enter the job's reference or name.");
    return { id: null, label };
  }
  if (!scopeId) throw badRequest(`Pick the ${scope} this declaration covers.`);
  const table = scope === "company" ? companies : locations;
  const [row] = await db.select({ name: table.name }).from(table).where(eq(table.id, scopeId)).limit(1);
  if (!row) throw notFound(`That ${scope} no longer exists.`);
  return { id: scopeId, label: row.name };
}

export async function createDeclaration(input: CreateDeclarationInput, userOid: string | null): Promise<DeclarationDetail> {
  const { currency } = await getConfig();
  const scope = await scopeLabelFor(input.scope, input.scopeId, input.scopeLabel);
  const title = cleanText(input.title, 200) ?? `High-value items${scope.label ? `: ${scope.label}` : ""}`;

  let id: string | null = null;
  // The code comes from a sequence; a restored backup can hold codes the
  // sequence has not reached yet, so step past any that are taken.
  for (let attempt = 0; !id; attempt++) {
    try {
      const [row] = await db
        .insert(hvDeclarations)
        .values({
          code: sql`'HVI-' || lpad(nextval('hv_declaration_code_seq')::text, 5, '0')`,
          title,
          scope: input.scope,
          scopeId: scope.id,
          scopeLabel: scope.label,
          currency,
          notes: cleanText(input.notes, 2000),
          createdBy: userOid,
        })
        .returning({ id: hvDeclarations.id });
      id = row!.id;
    } catch (err) {
      if (attempt < 20 && isUniqueViolation(err, "uq_hv_declarations_code")) continue;
      throw err;
    }
  }

  const records: ValuedRecord[] = [];
  if (input.populate && input.scope !== "job") {
    const settings = await getValuationSettings();
    const inScope = await valuedRecords(input.scope === "company" ? { companyId: scope.id } : { locationId: scope.id });
    records.push(...inScope.filter((r) => isHighValue(r.highValueMode, r.valueCents, settings.highValueThresholdCents)));
  }
  if (input.itemIds?.length) {
    const picked = await valuedRecords({ itemIds: input.itemIds });
    for (const r of picked) if (!records.some((x) => x.itemId === r.itemId && x.unitId === r.unitId)) records.push(r);
  }
  if (records.length) await insertLines(id, records, 0);

  const detail = await getDeclaration(id);
  await publish(
    "declaration.created",
    { declarationId: id, code: detail.code, title, scope: input.scope, scopeLabel: scope.label, lines: detail.lines.length, totalCents: detail.totalCents },
    { actor: actorFromOid(userOid), subject: { type: OWNER_TYPE, id } },
  );
  logger.info("valuation.declaration.created", { id, code: detail.code, lines: detail.lines.length });
  return detail;
}

function lineFrom(declarationId: string, r: ValuedRecord, position: number) {
  const name = r.unitLabel ? `${r.name} (${r.unitLabel})` : r.name;
  return {
    declarationId,
    position,
    itemId: r.itemId,
    unitId: r.unitId,
    valuationId: r.lastValuationId,
    name,
    brand: r.brand,
    model: r.model,
    serial: r.serials.join(", ") || null,
    assetCode: r.assetCode,
    description: r.description,
    materials: r.materials,
    condition: r.condition,
    declaredCents: r.valueCents ?? 0,
    valueSource: r.lastSource,
    notes: null,
  };
}

async function insertLines(declarationId: string, records: ValuedRecord[], after: number): Promise<void> {
  const values = records.map((r, i) => lineFrom(declarationId, r, after + i + 1));
  if (values.length) await db.insert(hvDeclarationLines).values(values);
  await db.update(hvDeclarations).set({ updatedAt: new Date() }).where(eq(hvDeclarations.id, declarationId));
}

/** Add items (or single units) to a draft, each declared at its current value. */
export async function addDeclarationLines(id: string, targets: { itemId: string; unitId?: string | null }[]): Promise<DeclarationDetail> {
  const row = await loadRow(id);
  assertDraft(row);
  const existing = await loadLines(id);
  const records = await valuedRecords({ itemIds: [...new Set(targets.map((t) => t.itemId))] });
  const wanted: ValuedRecord[] = [];
  for (const t of targets) {
    const forItem = records.filter((r) => r.itemId === t.itemId);
    if (!forItem.length) throw notFound("One of those items no longer exists.");
    // An item with units: the unit asked for, or every unit when none was named.
    const picked = t.unitId ? forItem.filter((r) => r.unitId === t.unitId) : forItem;
    if (!picked.length) throw notFound("That unit no longer exists, or belongs to another item.");
    for (const r of picked) {
      const dup = existing.some((l) => l.itemId === r.itemId && (l.unitId ?? null) === r.unitId) ||
        wanted.some((w) => w.itemId === r.itemId && w.unitId === r.unitId);
      if (!dup) wanted.push(r);
    }
  }
  await insertLines(id, wanted, existing.reduce((n, l) => Math.max(n, l.position), 0));
  return getDeclaration(id);
}

export type LinePatch = {
  declaredCents?: number;
  name?: string;
  description?: string | null;
  materials?: string | null;
  condition?: string | null;
  serial?: string | null;
  notes?: string | null;
};

export async function updateDeclarationLine(id: string, lineId: string, patch: LinePatch): Promise<DeclarationDetail> {
  assertDraft(await loadRow(id));
  const [line] = await db.select().from(hvDeclarationLines).where(eq(hvDeclarationLines.id, lineId)).limit(1);
  if (!line || line.declarationId !== id) throw notFound("That line is no longer on this declaration.");
  if (patch.declaredCents !== undefined && !(Number.isSafeInteger(patch.declaredCents) && patch.declaredCents >= 0)) {
    throw badRequest("Declare a value of zero or more.");
  }
  const name = patch.name === undefined ? undefined : cleanText(patch.name, 200);
  if (patch.name !== undefined && !name) throw badRequest("A line needs a name.");
  await db
    .update(hvDeclarationLines)
    .set({
      ...(patch.declaredCents !== undefined
        ? { declaredCents: patch.declaredCents, valueSource: patch.declaredCents === line.declaredCents ? line.valueSource : "manual" }
        : {}),
      ...(name ? { name } : {}),
      ...(patch.description !== undefined ? { description: cleanText(patch.description, 500) } : {}),
      ...(patch.materials !== undefined ? { materials: cleanText(patch.materials, 200) } : {}),
      ...(patch.condition !== undefined ? { condition: cleanText(patch.condition, 60) } : {}),
      ...(patch.serial !== undefined ? { serial: cleanText(patch.serial, 200) } : {}),
      ...(patch.notes !== undefined ? { notes: cleanText(patch.notes, 500) } : {}),
    })
    .where(eq(hvDeclarationLines.id, lineId));
  await db.update(hvDeclarations).set({ updatedAt: new Date() }).where(eq(hvDeclarations.id, id));
  return getDeclaration(id);
}

export async function removeDeclarationLine(id: string, lineId: string): Promise<DeclarationDetail> {
  assertDraft(await loadRow(id));
  const gone = await db.delete(hvDeclarationLines).where(eq(hvDeclarationLines.id, lineId)).returning({ declarationId: hvDeclarationLines.declarationId });
  if (!gone.length || gone[0]!.declarationId !== id) throw notFound("That line is no longer on this declaration.");
  // Keep positions 1..n so the printed list has no gaps.
  const rest = await loadLines(id);
  for (const [i, l] of rest.entries()) {
    if (l.position !== i + 1) await db.update(hvDeclarationLines).set({ position: i + 1 }).where(eq(hvDeclarationLines.id, l.id));
  }
  await db.update(hvDeclarations).set({ updatedAt: new Date() }).where(eq(hvDeclarations.id, id));
  return getDeclaration(id);
}

export async function updateDeclaration(id: string, patch: { title?: string; notes?: string | null; scopeLabel?: string | null }): Promise<DeclarationDetail> {
  const row = await loadRow(id);
  assertDraft(row);
  const title = patch.title === undefined ? undefined : cleanText(patch.title, 200);
  if (patch.title !== undefined && !title) throw badRequest("Give the declaration a title.");
  if (patch.scopeLabel !== undefined && row.scope !== "job") throw badRequest("Only a job reference can be edited; a company or location keeps its own name.");
  await db
    .update(hvDeclarations)
    .set({
      ...(title ? { title } : {}),
      ...(patch.notes !== undefined ? { notes: cleanText(patch.notes, 2000) } : {}),
      ...(patch.scopeLabel !== undefined ? { scopeLabel: cleanText(patch.scopeLabel, 200) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(hvDeclarations.id, id));
  return getDeclaration(id);
}

/**
 * Seal a draft with a signature made through the signatures API over
 * `signingContent`. The signature must belong to this declaration and match
 * it as it stands now; a draft edited while it was being signed is refused.
 */
export async function markDeclarationSigned(id: string, signatureId: string, userOid: string | null): Promise<DeclarationDetail> {
  const row = await loadRow(id);
  assertDraft(row);
  const lines = await loadLines(id);
  if (!lines.length) throw badRequest("Add at least one item before signing.");
  const signature = await getSignature(signatureId);
  if (!signature || signature.ownerType !== OWNER_TYPE || signature.ownerId !== id) {
    throw badRequest("That signature is not for this declaration.");
  }
  const content = declarationContent(row, lines);
  const check = await verifySignature(signatureId, content);
  if (!check.valid) {
    throw conflict("The declaration changed while it was being signed. Review it and sign again.");
  }
  // Only a draft moves to signed, so two people signing at once cannot both win.
  const updated = await db
    .update(hvDeclarations)
    .set({ status: "signed", signatureId, signedAt: signature.signedAt, updatedAt: new Date() })
    .where(sql`${hvDeclarations.id} = ${id} AND ${hvDeclarations.status} = 'draft'`)
    .returning({ id: hvDeclarations.id });
  if (!updated.length) throw conflict(`${row.code} was signed by someone else a moment ago.`);

  const entry = await publish(
    "declaration.signed",
    {
      declarationId: id,
      code: row.code,
      title: row.title,
      signatureId,
      signerName: signature.signerName,
      signerRole: signature.signerRole,
      contentHash: signature.contentHash,
      lines: lines.length,
      totalCents: content.totalCents,
      currency: row.currency,
    },
    { actor: actorFromOid(userOid), subject: { type: OWNER_TYPE, id } },
  );
  if (entry) await db.update(hvDeclarations).set({ auditEntryId: entry.id }).where(eq(hvDeclarations.id, id));
  logger.info("valuation.declaration.signed", { id, code: row.code, auditEntryId: entry?.id });
  return getDeclaration(id);
}

export async function verifyDeclaration(id: string): Promise<VerifyResult & { code: string }> {
  const row = await loadRow(id);
  if (!row.signatureId) throw badRequest(`${row.code} has not been signed yet.`);
  const lines = await loadLines(id);
  return { ...(await verifySignature(row.signatureId, declarationContent(row, lines))), code: row.code };
}

/** Delete a draft. A signed declaration is a record of what someone attested to and stays. */
export async function deleteDeclaration(id: string, userOid: string | null): Promise<void> {
  const row = await loadRow(id);
  if (row.status === "signed") throw conflict(`${row.code} is signed and is kept as a record.`);
  await db.delete(hvDeclarations).where(eq(hvDeclarations.id, id));
  await deleteAttachmentsForOwner(OWNER_TYPE, id);
  await publish("declaration.deleted", { declarationId: id, code: row.code, title: row.title }, {
    actor: actorFromOid(userOid),
    subject: { type: OWNER_TYPE, id },
  });
}

/** Declarations that list an item, for its page. */
export async function declarationsForItem(itemId: string): Promise<{ id: string; code: string; title: string; status: string; declaredCents: number; signedAt: Date | null }[]> {
  const lines = await db
    .select({ declarationId: hvDeclarationLines.declarationId, declaredCents: hvDeclarationLines.declaredCents })
    .from(hvDeclarationLines)
    .where(eq(hvDeclarationLines.itemId, itemId));
  if (!lines.length) return [];
  const decls = await db
    .select()
    .from(hvDeclarations)
    .where(inArray(hvDeclarations.id, [...new Set(lines.map((l) => l.declarationId))]))
    .orderBy(desc(hvDeclarations.createdAt));
  return decls.map((d) => ({
    id: d.id,
    code: d.code,
    title: d.title,
    status: d.status,
    declaredCents: lines.filter((l) => l.declarationId === d.id).reduce((n, l) => n + l.declaredCents, 0),
    signedAt: d.signedAt,
  }));
}
