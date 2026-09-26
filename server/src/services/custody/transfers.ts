import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db, pool } from "../../db/client";
import {
  custodyTransferItems,
  custodyTransfers,
  entities,
  itemUnits,
  items,
  jobs,
  shipments,
  users,
  type CustodyOutcome,
  type CustodyParty,
  type CustodyTransfer,
  type CustodyTransferItem,
} from "../../db/schema";
import { HttpError, badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { actorFromOid, publish } from "../event-backbone";
import { resolveScanCodes } from "../jobs-core";
import { listSignatures, sign, type Signature } from "../media-ai-core";
import { contentLines, itemsHash, transferContent } from "./content";
import {
  cleanSeals,
  genTransferCode,
  isPurpose,
  missingSignatures,
  normalizeParty,
  purposeInfo,
  statementFor,
  type PartyInput,
  type PartySnapshot,
} from "./model";
import { LINK_HOURS_DEFAULT, LINK_HOURS_MAX, linkState, newLinkToken } from "./rules";

/**
 * Custody transfers: the record of one handoff. A transfer is drafted (parties,
 * place, seals), filled by scanning, locked once the count is confirmed, and
 * completed when every party it needs has signed. Completion is what the rest
 * of the feature listens for: the receipt, the audit-log entry, delivery
 * stages on the job.
 *
 * Every change to one transfer takes a transaction-scoped advisory lock on it,
 * so a signature arriving by link and one on the device cannot both complete
 * it, and a scan cannot slip in after the count was confirmed.
 */

export type Actor = { userOid: string | null; name: string | null };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The most lines one transfer holds; a pallet of archive boxes and their folders fits well within it. */
export const MAX_LINES = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = (s: string | null | undefined, max = 2000): string | null => {
  const t = s?.trim();
  return t ? t.slice(0, max) : null;
};

async function lockRow(tx: Tx, id: string): Promise<CustodyTransfer> {
  if (!UUID.test(id)) throw notFound("Custody transfer not found.");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`custody:${id}`}, 0))`);
  const [row] = await tx.select().from(custodyTransfers).where(eq(custodyTransfers.id, id)).limit(1);
  if (!row) throw notFound("Custody transfer not found.");
  return row;
}

export async function loadTransfer(id: string): Promise<CustodyTransfer> {
  if (!UUID.test(id)) throw notFound("Custody transfer not found.");
  const [row] = await db.select().from(custodyTransfers).where(eq(custodyTransfers.id, id)).limit(1);
  if (!row) throw notFound("Custody transfer not found.");
  return row;
}

export function transferLines(transferId: string, ex: Tx | typeof db = db): Promise<CustodyTransferItem[]> {
  return ex
    .select()
    .from(custodyTransferItems)
    .where(eq(custodyTransferItems.transferId, transferId))
    .orderBy(asc(custodyTransferItems.position));
}

function assertDraft(t: CustodyTransfer): void {
  if (t.status !== "draft") {
    throw new HttpError(
      409,
      "transfer_locked",
      t.status === "void"
        ? `${t.code} was voided. Start a new transfer.`
        : `${t.code}'s list is fixed because the count was confirmed. Void it and start again to change it.`,
    );
  }
}

// --- Parties, places and links ----------------------------------------------------

async function resolveParty(input: PartyInput, which: "releasing" | "receiving", actor: Actor): Promise<PartySnapshot> {
  let resolved: string | null = null;
  if (input.kind === "entity" && input.entityId) {
    if (!UUID.test(input.entityId)) throw badRequest(`The ${which} holder id is not valid.`);
    const [e] = await db.select({ name: entities.name }).from(entities).where(eq(entities.id, input.entityId)).limit(1);
    resolved = e?.name ?? null;
  } else if (input.kind === "user" && input.userOid) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.oid, input.userOid)).limit(1);
    // Under trusted sign-in the owner has no account row.
    resolved = u?.name ?? (input.userOid === actor.userOid ? actor.name ?? input.userOid : null);
  }
  const party = normalizeParty(input, resolved, which);
  if (typeof party === "string") throw badRequest(party);
  return party;
}

const fromColumns = (p: PartySnapshot) => ({
  fromKind: p.kind,
  fromEntityId: p.entityId,
  fromUserOid: p.userOid,
  fromName: p.name,
  fromOrg: p.org,
});
const toColumns = (p: PartySnapshot) => ({
  toKind: p.kind,
  toEntityId: p.entityId,
  toUserOid: p.userOid,
  toName: p.name,
  toOrg: p.org,
});

/** A location path such as "HQ / Level 5 / 5.12", as printed on the receipt. */
async function locationPath(id: string): Promise<string> {
  const { rows } = await pool.query<{ path: string | null }>(
    `WITH RECURSIVE up(id, parent_id, name, depth) AS (
       SELECT id, parent_id, name, 0 FROM locations WHERE id = $1
       UNION ALL
       SELECT l.id, l.parent_id, l.name, up.depth + 1 FROM locations l JOIN up ON l.id = up.parent_id WHERE up.depth < 20
     )
     SELECT string_agg(name, ' / ' ORDER BY depth DESC) AS path FROM up`,
    [id],
  );
  const path = rows[0]?.path;
  if (!path) throw badRequest("That place does not exist. Pick another.");
  return path;
}

type Placement = {
  locationId?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  jobId?: string | null;
  shipmentId?: string | null;
};

async function placementColumns(input: Placement, current?: CustodyTransfer) {
  const out: Partial<typeof custodyTransfers.$inferInsert> = {};
  if (input.locationId !== undefined) {
    out.locationId = input.locationId;
    out.locationName = input.locationId ? await locationPath(input.locationId) : null;
  }
  if (input.lat !== undefined || input.lng !== undefined) {
    const lat = input.lat ?? null;
    const lng = input.lng ?? null;
    if ((lat === null) !== (lng === null)) throw badRequest("Give both latitude and longitude, or neither.");
    out.lat = lat;
    out.lng = lng;
    out.accuracyM = lat === null ? null : input.accuracyM ?? null;
  }
  let jobId = input.jobId === undefined ? current?.jobId ?? null : input.jobId;
  if (input.shipmentId !== undefined) {
    if (input.shipmentId) {
      const [s] = await db
        .select({ id: shipments.id, code: shipments.code, jobId: shipments.jobId })
        .from(shipments)
        .where(eq(shipments.id, input.shipmentId))
        .limit(1);
      if (!s) throw badRequest("That shipment does not exist. Pick another.");
      if (jobId && jobId !== s.jobId) throw badRequest(`${s.code} belongs to a different job. Pick one of this job's shipments.`);
      jobId = s.jobId;
      out.shipmentId = s.id;
      out.shipmentCode = s.code;
    } else {
      out.shipmentId = null;
      out.shipmentCode = null;
    }
  }
  if (input.jobId !== undefined || out.shipmentId) {
    if (jobId) {
      const [j] = await db.select({ code: jobs.code }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!j) throw badRequest("That job does not exist. Pick another.");
      out.jobId = jobId;
      out.jobCode = j.code;
    } else {
      out.jobId = null;
      out.jobCode = null;
    }
  }
  return out;
}

// --- Creating and editing ------------------------------------------------------------

export type TransferInput = Placement & {
  purpose: string;
  from: PartyInput;
  to: PartyInput;
  sealNumbers?: string[];
  conditionNote?: string | null;
  notes?: string | null;
};

export async function createTransfer(input: TransferInput, actor: Actor, metadata: Record<string, unknown> = {}) {
  if (!isPurpose(input.purpose)) throw badRequest(`Unknown purpose "${input.purpose}".`);
  const from = await resolveParty(input.from, "releasing", actor);
  const to = await resolveParty(input.to, "receiving", actor);
  const placement = await placementColumns(input);
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await db
        .insert(custodyTransfers)
        .values({
          code: genTransferCode((n) => randomBytes(n)),
          purpose: input.purpose,
          ...fromColumns(from),
          ...toColumns(to),
          ...placement,
          sealNumbers: cleanSeals(input.sealNumbers ?? []),
          conditionNote: clean(input.conditionNote),
          notes: clean(input.notes),
          metadata,
          createdBy: actor.userOid,
        })
        .returning();
      logger.info("custody.transfer.created", { id: row!.id, code: row!.code, purpose: row!.purpose });
      return row!;
    } catch (err) {
      if (attempt < 4 && isUniqueViolation(err, "uq_custody_transfers_code")) continue;
      throw err;
    }
  }
}

export async function updateTransfer(id: string, patch: Partial<TransferInput>, actor: Actor) {
  const current = await loadTransfer(id);
  assertDraft(current);
  const set: Partial<typeof custodyTransfers.$inferInsert> = { updatedAt: new Date() };
  if (patch.purpose !== undefined) {
    if (!isPurpose(patch.purpose)) throw badRequest(`Unknown purpose "${patch.purpose}".`);
    set.purpose = patch.purpose;
  }
  if (patch.from) Object.assign(set, fromColumns(await resolveParty(patch.from, "releasing", actor)));
  if (patch.to) Object.assign(set, toColumns(await resolveParty(patch.to, "receiving", actor)));
  Object.assign(set, await placementColumns(patch, current));
  if (patch.sealNumbers !== undefined) set.sealNumbers = cleanSeals(patch.sealNumbers);
  if (patch.conditionNote !== undefined) set.conditionNote = clean(patch.conditionNote);
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  return db.transaction(async (tx) => {
    assertDraft(await lockRow(tx, id));
    const [row] = await tx.update(custodyTransfers).set(set).where(eq(custodyTransfers.id, id)).returning();
    return row!;
  });
}

// --- Filling the list ---------------------------------------------------------------------

type NewLine = Omit<typeof custodyTransferItems.$inferInsert, "transferId" | "position">;

const key = (itemId: string, unitId: string | null) => `${itemId}:${unitId ?? ""}`;

export type ScanOutcome = {
  added: { code: string; itemId: string; unitId: string | null; name: string; assetCode: string; contents: number }[];
  already: { code: string; name: string; assetCode: string }[];
  unknown: string[];
  /** A product code several items share: which one is meant cannot be told. */
  ambiguous: { code: string; count: number }[];
  total: number;
};

/** Everything packed inside `rootIds`, at any depth, with the scanned container it travels in. */
async function contentsOf(rootIds: string[]) {
  if (!rootIds.length) return [];
  const { rows } = await pool.query<{ id: string; root: string; name: string; asset_code: string }>(
    `WITH RECURSIVE down(id, root, depth) AS (
       SELECT id, parent_item_id, 1 FROM items WHERE parent_item_id = ANY($1::uuid[])
       UNION ALL
       SELECT i.id, down.root, down.depth + 1 FROM items i JOIN down ON i.parent_item_id = down.id WHERE down.depth < 20
     )
     SELECT DISTINCT ON (down.id) down.id, down.root, i.name, i.asset_code
       FROM down JOIN items i ON i.id = down.id
      ORDER BY down.id, down.depth`,
    [rootIds],
  );
  return rows;
}

/**
 * Add what a batch of scanned codes names. A container brings everything
 * packed inside it (as "contained" lines, so the count a person confirms is
 * the boxes they can see). A code is added once however often it is read.
 */
export async function scanIntoTransfer(id: string, codes: string[], via: "scan" | "manual" = "scan"): Promise<ScanOutcome> {
  const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (unique.length > MAX_LINES) throw badRequest(`Send at most ${MAX_LINES} codes at a time.`);
  const resolved = await resolveScanCodes(unique);
  const out: ScanOutcome = { added: [], already: [], unknown: [], ambiguous: [], total: 0 };

  return db.transaction(async (tx) => {
    const t = await lockRow(tx, id);
    assertDraft(t);
    const existing = await transferLines(id, tx);
    const have = new Set(existing.map((l) => key(l.itemId, l.unitId)));
    const wholeItems = new Set(existing.filter((l) => !l.unitId).map((l) => l.itemId));
    let position = existing.reduce((max, l) => Math.max(max, l.position), 0);

    const refs = unique.flatMap((code) => {
      const list = resolved.get(code) ?? [];
      if (!list.length) {
        out.unknown.push(code);
        return [];
      }
      const distinctItems = new Set(list.map((r) => r.itemId));
      if (list.length > 1 && distinctItems.size > 1) {
        out.ambiguous.push({ code, count: distinctItems.size });
        return [];
      }
      return [{ code, ref: list[0]! }];
    });
    const itemIds = [...new Set(refs.map((r) => r.ref.itemId))];
    const unitIds = [...new Set(refs.flatMap((r) => (r.ref.unitId ? [r.ref.unitId] : [])))];
    const [itemRows, unitRows] = await Promise.all([
      itemIds.length
        ? tx.select({ id: items.id, name: items.name, assetCode: items.assetCode }).from(items).where(inArray(items.id, itemIds))
        : [],
      unitIds.length
        ? tx
            .select({ id: itemUnits.id, assetCode: itemUnits.assetCode, label: itemUnits.label })
            .from(itemUnits)
            .where(inArray(itemUnits.id, unitIds))
        : [],
    ]);
    const itemById = new Map(itemRows.map((i) => [i.id, i]));
    const unitById = new Map(unitRows.map((u) => [u.id, u]));

    const lines: NewLine[] = [];
    const scannedContainers: { code: string; itemId: string }[] = [];
    for (const { code, ref } of refs) {
      const item = itemById.get(ref.itemId);
      if (!item) {
        out.unknown.push(code);
        continue;
      }
      const unit = ref.unitId ? unitById.get(ref.unitId) : undefined;
      const k = key(ref.itemId, ref.unitId);
      if (have.has(k) || (ref.unitId && wholeItems.has(ref.itemId))) {
        out.already.push({ code, name: item.name, assetCode: unit?.assetCode ?? item.assetCode });
        continue;
      }
      have.add(k);
      if (!ref.unitId) wholeItems.add(ref.itemId);
      lines.push({
        itemId: ref.itemId,
        unitId: ref.unitId,
        assetCode: item.assetCode,
        unitCode: unit?.assetCode ?? null,
        name: unit?.label ? `${item.name} (${unit.label})` : item.name,
        via,
      });
      out.added.push({ code, itemId: ref.itemId, unitId: ref.unitId, name: item.name, assetCode: unit?.assetCode ?? item.assetCode, contents: 0 });
      if (!ref.unitId) scannedContainers.push({ code, itemId: ref.itemId });
    }

    const inside = await contentsOf(scannedContainers.map((c) => c.itemId));
    const addedByItem = new Map(out.added.map((a) => [a.itemId, a]));
    for (const row of inside) {
      const k = key(row.id, null);
      if (have.has(k)) continue;
      have.add(k);
      wholeItems.add(row.id);
      lines.push({ itemId: row.id, unitId: null, assetCode: row.asset_code, unitCode: null, name: row.name, via: "contained", parentItemId: row.root });
      const parent = addedByItem.get(row.root);
      if (parent) parent.contents += 1;
    }

    if (existing.length + lines.length > MAX_LINES) {
      throw badRequest(`A transfer holds at most ${MAX_LINES} lines. Split the handoff into two transfers.`);
    }
    for (let i = 0; i < lines.length; i += 500) {
      await tx.insert(custodyTransferItems).values(
        lines.slice(i, i + 500).map((l) => ({ ...l, transferId: id, position: ++position })),
      );
    }
    if (lines.length) {
      await tx.update(custodyTransfers).set({ updatedAt: new Date() }).where(eq(custodyTransfers.id, id));
    }
    out.total = existing.length + lines.length;
    return out;
  });
}

/** Take lines off a draft. A container takes the lines packed inside it with it. */
export async function removeLines(id: string, lineIds: string[]): Promise<{ removed: number }> {
  return db.transaction(async (tx) => {
    assertDraft(await lockRow(tx, id));
    const lines = await transferLines(id, tx);
    const chosen = lines.filter((l) => lineIds.includes(l.id));
    const containers = new Set(chosen.filter((l) => !l.unitId).map((l) => l.itemId));
    const ids = lines
      .filter((l) => lineIds.includes(l.id) || (l.via === "contained" && l.parentItemId && containers.has(l.parentItemId)))
      .map((l) => l.id);
    if (ids.length) await tx.delete(custodyTransferItems).where(inArray(custodyTransferItems.id, ids));
    return { removed: ids.length };
  });
}

export type OutcomeInput = { lineId: string; outcome: CustodyOutcome; note?: string | null };

async function applyOutcomes(tx: Tx, id: string, lines: CustodyTransferItem[], outcomes: OutcomeInput[]) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  for (const o of outcomes) {
    const line = byId.get(o.lineId);
    if (!line) throw badRequest("One of the lines is not on this transfer. Reload and try again.");
    const note = clean(o.note, 500);
    if (line.outcome === o.outcome && line.note === note) continue;
    await tx
      .update(custodyTransferItems)
      .set({ outcome: o.outcome, note })
      .where(and(eq(custodyTransferItems.id, o.lineId), eq(custodyTransferItems.transferId, id)));
    line.outcome = o.outcome;
    line.note = note;
  }
}

/** Mark lines missing, damaged or refused (or back to accepted) while the list is still open. */
export async function setOutcomes(id: string, outcomes: OutcomeInput[]) {
  return db.transaction(async (tx) => {
    assertDraft(await lockRow(tx, id));
    await applyOutcomes(tx, id, await transferLines(id, tx), outcomes);
    return { updated: outcomes.length };
  });
}

// --- Locking and signing ------------------------------------------------------------------

/** The lines a person counts: what they can see, not what is packed inside it. */
export const countable = (lines: Pick<CustodyTransferItem, "via">[]) => lines.filter((l) => l.via !== "contained").length;

async function lockInTx(
  tx: Tx,
  t: CustodyTransfer,
  opts: { expectedCount?: number; outcomes?: OutcomeInput[] },
): Promise<CustodyTransfer> {
  const lines = await transferLines(t.id, tx);
  if (!lines.length) throw badRequest("Scan the items being handed over first. The list is empty.");
  if (opts.expectedCount !== undefined) {
    const counted = countable(lines);
    if (counted !== opts.expectedCount) {
      throw new HttpError(
        409,
        "count_mismatch",
        `The list has ${counted} but ${opts.expectedCount} were counted. Scan what is missing, or remove what is not here, and count again.`,
        { listed: counted, counted: opts.expectedCount },
      );
    }
  }
  if (opts.outcomes?.length) await applyOutcomes(tx, t.id, lines, opts.outcomes);
  const now = new Date();
  const [row] = await tx
    .update(custodyTransfers)
    .set({ status: "locked", lockedAt: now, contentHash: itemsHash(contentLines(lines)), updatedAt: now })
    .where(eq(custodyTransfers.id, t.id))
    .returning();
  logger.info("custody.transfer.locked", { id: t.id, code: t.code, lines: lines.length });
  return row!;
}

/**
 * Confirm the count and fix the list. `expectedCount` is what the person
 * handing over counted; it must match the lines they can see.
 */
export async function lockTransfer(id: string, opts: { expectedCount: number; outcomes?: OutcomeInput[] }) {
  return db.transaction(async (tx) => {
    const t = await lockRow(tx, id);
    assertDraft(t);
    return lockInTx(tx, t, opts);
  });
}

/** The content every signature on this transfer covers, rebuilt from the stored rows. */
export async function signableContent(t: CustodyTransfer, ex: Tx | typeof db = db) {
  return transferContent(t, contentLines(await transferLines(t.id, ex)));
}

export type SignerInput = {
  signerName: string;
  signerEmail?: string | null;
  signerRole?: string | null;
  image: Buffer | null;
};

export type SignContext = {
  via: "device" | "link";
  /** Who held the device, or null for a signature made by link. */
  capturedBy: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** For a delivery signed by link: the receiver's own findings, applied before the list is fixed. */
  outcomes?: OutcomeInput[];
  expectedCount?: number;
};

export type SignResult = { transfer: CustodyTransfer; signature: Signature; completed: boolean };

async function signInTx(tx: Tx, t: CustodyTransfer, party: CustodyParty, signer: SignerInput, ctx: SignContext): Promise<SignResult> {
  if (t.status === "completed") throw conflict(`${t.code} is already complete.`);
  if (t.status === "void") throw conflict(`${t.code} was voided. Start a new transfer.`);
  if (t.status === "draft") {
    // A delivery is reviewed and signed in one step; everything else is
    // counted first, so its list is fixed before anyone signs.
    if (t.purpose !== "delivery" && ctx.expectedCount === undefined) {
      throw new HttpError(409, "not_locked", "Confirm the count before anyone signs.");
    }
    t = await lockInTx(tx, t, { expectedCount: ctx.expectedCount, outcomes: ctx.outcomes });
  } else if (ctx.outcomes?.length) {
    throw new HttpError(409, "transfer_locked", "The list is already fixed. Its lines can no longer be marked.");
  }
  const already = party === "from" ? t.fromSignatureId : t.toSignatureId;
  if (already) throw conflict(`The ${party === "from" ? "releasing" : "receiving"} party has already signed ${t.code}.`);
  if (!signer.image?.length) throw badRequest("Draw the signature before saving.");

  const lines = await transferLines(t.id, tx);
  const content = transferContent(t, contentLines(lines));
  const partyUser = party === "from" ? t.fromUserOid : t.toUserOid;
  const signature = await sign({
    ownerType: "custody_transfer",
    ownerId: t.id,
    signerName: signer.signerName,
    signerEmail: signer.signerEmail ?? null,
    signerRole: signer.signerRole ?? (party === "from" ? "Releasing party" : "Receiving party"),
    statement: statementFor(t.purpose, party, {
      code: t.code,
      fromName: t.fromName,
      toName: t.toName,
      count: countable(lines),
    }),
    content,
    image: signer.image,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    // Only an account holder signing as themselves is recorded as that
    // account; a customer signing on the crew's tablet is not the crew.
    signedByUser: partyUser && partyUser === ctx.capturedBy ? partyUser : null,
  });

  const signedIds = {
    from: party === "from" ? signature.id : t.fromSignatureId,
    to: party === "to" ? signature.id : t.toSignatureId,
  };
  const completed = missingSignatures(t.purpose, signedIds).length === 0;
  const now = new Date();
  const [row] = await tx
    .update(custodyTransfers)
    .set({
      ...(party === "from" ? { fromSignatureId: signature.id } : { toSignatureId: signature.id }),
      signing: { ...t.signing, [party]: { via: ctx.via, capturedBy: ctx.capturedBy } },
      ...(ctx.via === "link" ? { linkUsedAt: now, linkTokenHash: null } : {}),
      ...(completed ? { status: "completed" as const, at: now, completedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(custodyTransfers.id, t.id))
    .returning();
  logger.info("custody.transfer.signed", { id: t.id, code: t.code, party, via: ctx.via, completed });
  return { transfer: row!, signature, completed };
}

/** Record one party's signature, on the device in hand. */
export async function signTransfer(id: string, party: CustodyParty, signer: SignerInput, ctx: SignContext): Promise<SignResult> {
  return db.transaction(async (tx) => signInTx(tx, await lockRow(tx, id), party, signer, ctx));
}

/** Record the signature of whoever holds the one-time link. */
export async function signByLink(tokenHash: string, signer: SignerInput, ctx: Omit<SignContext, "via" | "capturedBy">) {
  const [found] = await db
    .select({ id: custodyTransfers.id })
    .from(custodyTransfers)
    .where(eq(custodyTransfers.linkTokenHash, tokenHash))
    .limit(1);
  if (!found) throw linkGone();
  return db.transaction(async (tx) => {
    const t = await lockRow(tx, found.id);
    // Re-checked under the lock: the link may have been used or revoked since.
    if (t.linkTokenHash !== tokenHash || linkState(t) !== "active" || !t.linkParty) throw linkGone();
    return signInTx(tx, t, t.linkParty, signer, { ...ctx, via: "link", capturedBy: null });
  });
}

export const linkGone = () =>
  new HttpError(410, "link_gone", "This signing link has expired or was already used. Ask for a new one.");

/**
 * A one-time link for one party to sign on their own device. Only its hash is
 * stored; the token is returned once. A new link replaces the old one.
 */
export async function issueLink(id: string, party: CustodyParty, hours: number | undefined, actor: Actor) {
  const life = Math.min(Math.max(hours ?? LINK_HOURS_DEFAULT, 1), LINK_HOURS_MAX);
  const { token, hash } = newLinkToken();
  const expiresAt = new Date(Date.now() + life * 3600_000);
  const row = await db.transaction(async (tx) => {
    const t = await lockRow(tx, id);
    if (t.status === "completed" || t.status === "void") throw conflict(`${t.code} is ${t.status}; nobody else can sign it.`);
    if (t.status === "draft" && !(t.purpose === "delivery" && party === "to")) {
      throw new HttpError(409, "not_locked", "Confirm the count before sending a signing link.");
    }
    if ((party === "from" ? t.fromSignatureId : t.toSignatureId) !== null) {
      throw conflict(`The ${party === "from" ? "releasing" : "receiving"} party has already signed.`);
    }
    const [updated] = await tx
      .update(custodyTransfers)
      .set({
        linkTokenHash: hash,
        linkParty: party,
        linkExpiresAt: expiresAt,
        linkCreatedBy: actor.userOid,
        linkUsedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(custodyTransfers.id, id))
      .returning();
    return updated!;
  });
  logger.info("custody.link.issued", { id, code: row.code, party, hours: life });
  await publish(
    "custody.link_issued",
    { code: row.code, party, expiresAt, signerName: party === "from" ? row.fromName : row.toName },
    { actor: actorFromOid(actor.userOid, actor.name), subject: { type: "custody_transfer", id } },
  );
  return { transfer: row, token, expiresAt };
}

export async function revokeLink(id: string) {
  return db.transaction(async (tx) => {
    await lockRow(tx, id);
    const [row] = await tx
      .update(custodyTransfers)
      .set({ linkTokenHash: null, linkExpiresAt: null, updatedAt: new Date() })
      .where(eq(custodyTransfers.id, id))
      .returning();
    return row!;
  });
}

export async function findByLinkHash(tokenHash: string): Promise<CustodyTransfer | null> {
  const [row] = await db.select().from(custodyTransfers).where(eq(custodyTransfers.linkTokenHash, tokenHash)).limit(1);
  return row ?? null;
}

export async function voidTransfer(id: string, reason: string | null, actor: Actor) {
  let changed = false;
  const row = await db.transaction(async (tx) => {
    const t = await lockRow(tx, id);
    if (t.status === "completed") {
      throw conflict(`${t.code} is complete and signed; it cannot be voided. Record a new transfer to correct it.`);
    }
    if (t.status === "void") return t;
    changed = true;
    const now = new Date();
    const [row] = await tx
      .update(custodyTransfers)
      .set({
        status: "void",
        voidReason: clean(reason, 1000),
        voidedAt: now,
        voidedBy: actor.userOid,
        linkTokenHash: null,
        updatedAt: now,
      })
      .where(eq(custodyTransfers.id, id))
      .returning();
    return row!;
  });
  if (changed) {
    await publish(
      "custody.voided",
      { code: row.code, purpose: row.purpose, reason: row.voidReason, wasSigned: Boolean(row.fromSignatureId || row.toSignatureId) },
      { actor: actorFromOid(actor.userOid, actor.name), subject: { type: "custody_transfer", id } },
    );
  }
  return row;
}

/** Store the audit-log evidence and the receipt once they exist. */
export async function recordEvidence(
  id: string,
  set: { receiptAttachmentId?: string; auditEntryId?: number; auditHash?: string; metadata?: Record<string, unknown> },
) {
  const { metadata, ...rest } = set;
  await db
    .update(custodyTransfers)
    .set({
      ...rest,
      ...(metadata ? { metadata: sql`${custodyTransfers.metadata} || ${JSON.stringify(metadata)}::jsonb` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(custodyTransfers.id, id));
}

// --- Reading ------------------------------------------------------------------------------

/** Never hand the stored link hash to a client. */
function present(t: CustodyTransfer) {
  const { linkTokenHash: _hash, ...rest } = t;
  return rest;
}

export async function getTransfer(id: string) {
  const t = await loadTransfer(id);
  const [lines, signatures] = await Promise.all([transferLines(id), listSignatures("custody_transfer", id)]);
  const info = purposeInfo(t.purpose);
  return {
    ...present(t),
    purposeLabel: info.label,
    required: info.requires,
    missing: t.status === "void" ? [] : missingSignatures(t.purpose, { from: t.fromSignatureId, to: t.toSignatureId }),
    link: { state: linkState(t), party: t.linkParty, expiresAt: t.linkExpiresAt },
    counted: countable(lines),
    // Exactly the words each party will be asked to agree to.
    statements: {
      from: statementFor(t.purpose, "from", { code: t.code, fromName: t.fromName, toName: t.toName, count: countable(lines) }),
      to: statementFor(t.purpose, "to", { code: t.code, fromName: t.fromName, toName: t.toName, count: countable(lines) }),
    },
    lines,
    signatures,
  };
}

export type TransferFilters = {
  status?: string;
  purpose?: string;
  jobId?: string;
  shipmentId?: string;
  q?: string;
  limit?: number;
  before?: string;
};

export async function listTransfers(f: TransferFilters = {}) {
  const q = f.q?.trim();
  const where: (SQL | undefined)[] = [
    f.status ? eq(custodyTransfers.status, f.status as CustodyTransfer["status"]) : undefined,
    f.purpose ? eq(custodyTransfers.purpose, f.purpose) : undefined,
    f.jobId ? eq(custodyTransfers.jobId, f.jobId) : undefined,
    f.shipmentId ? eq(custodyTransfers.shipmentId, f.shipmentId) : undefined,
    q
      ? or(
          ilike(custodyTransfers.code, `%${q}%`),
          ilike(custodyTransfers.fromName, `%${q}%`),
          ilike(custodyTransfers.toName, `%${q}%`),
          ilike(custodyTransfers.fromOrg, `%${q}%`),
          ilike(custodyTransfers.toOrg, `%${q}%`),
          sql`${q} = ANY(${custodyTransfers.sealNumbers})`,
        )
      : undefined,
  ];
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      transfer: custodyTransfers,
      // Spelled out: inside a subquery drizzle would print the bare column name, which binds to ti.id.
      lines: sql<number>`(SELECT count(*)::int FROM custody_transfer_items ti WHERE ti.transfer_id = custody_transfers.id)`,
      exceptions: sql<number>`(SELECT count(*)::int FROM custody_transfer_items ti
                               WHERE ti.transfer_id = custody_transfers.id AND ti.outcome <> 'accepted')`,
    })
    .from(custodyTransfers)
    .where(and(...where))
    .orderBy(desc(custodyTransfers.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    ...present(r.transfer),
    purposeLabel: purposeInfo(r.transfer.purpose).label,
    lineCount: r.lines,
    exceptionCount: r.exceptions,
  }));
}

/** Open (unfinished) deliveries for a shipment, newest first. */
export async function openDeliveryFor(shipmentId: string) {
  const [row] = await db
    .select()
    .from(custodyTransfers)
    .where(
      and(
        eq(custodyTransfers.shipmentId, shipmentId),
        eq(custodyTransfers.purpose, "delivery"),
        inArray(custodyTransfers.status, ["draft", "locked"]),
      ),
    )
    .orderBy(desc(custodyTransfers.createdAt))
    .limit(1);
  return row ?? null;
}

