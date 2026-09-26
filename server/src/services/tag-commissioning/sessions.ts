import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { itemUnits, items, locations, tagBindSessions, type TagBindSession } from "../../db/schema";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { recordEvent } from "../items";
import {
  applyBind,
  applySkip,
  applyUndo,
  decideRead,
  sessionCounts,
  type BindAction,
  type BindEntry,
  type BindState,
  type IgnoreReason,
} from "./bulkBind";
import { normalizeTagUid, tagKey } from "./normalize";

/**
 * Bulk binding: walk a list of untagged items with a reader, and each new tag
 * read binds to the next one. The list, the cursor and the history live in
 * the database, so a session survives a reload and can be driven from a second
 * device. The decisions themselves are in ./bulkBind.
 */

export const MAX_QUEUE = 5000;

export type TagType = "rfid" | "nfc";

export type CreateSessionInput = {
  name?: string;
  tagType: TagType;
  locationId?: string;
  includeSubLocations?: boolean;
  itemIds?: string[];
  /** Leave out what already has a tag of this type. */
  onlyUntagged?: boolean;
  /** One entry per tracked unit instead of one per item, for items that have units. */
  includeUnits?: boolean;
};

async function itemsAtLocation(locationId: string, withChildren: boolean): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `WITH RECURSIVE scope(id) AS (
       SELECT $1::uuid
       UNION
       SELECT l.id FROM locations l JOIN scope s ON l.parent_id = s.id WHERE $2::boolean
     )
     SELECT i.id FROM items i
      WHERE i.location_id IN (SELECT id FROM scope)
        AND i.category IS DISTINCT FROM 'Domain'
      ORDER BY i.name, i.asset_code`,
    [locationId, withChildren],
  );
  return rows.map((r) => r.id);
}

async function buildQueue(input: CreateSessionInput): Promise<{ queue: BindEntry[]; label: string }> {
  let itemIds: string[];
  let label: string;
  if (input.itemIds?.length) {
    const found = await db
      .select({ id: items.id, category: items.category })
      .from(items)
      .where(inArray(items.id, input.itemIds));
    const ok = new Set(found.filter((f) => f.category !== "Domain").map((f) => f.id));
    itemIds = [...new Set(input.itemIds)].filter((id) => ok.has(id));
    label = `${itemIds.length} selected`;
  } else if (input.locationId) {
    const [loc] = await db
      .select({ name: locations.name })
      .from(locations)
      .where(eq(locations.id, input.locationId))
      .limit(1);
    if (!loc) throw notFound("Location not found");
    itemIds = await itemsAtLocation(input.locationId, input.includeSubLocations ?? true);
    label = loc.name;
  } else {
    throw badRequest("Choose a location or a list of items to bind.");
  }

  const units = input.includeUnits && itemIds.length
    ? await db
        .select({ id: itemUnits.id, itemId: itemUnits.itemId })
        .from(itemUnits)
        .where(inArray(itemUnits.itemId, itemIds))
        .orderBy(itemUnits.createdAt)
    : [];
  const unitsByItem = new Map<string, string[]>();
  for (const u of units) unitsByItem.set(u.itemId, [...(unitsByItem.get(u.itemId) ?? []), u.id]);

  let taggedItems = new Set<string>();
  let taggedUnits = new Set<string>();
  if ((input.onlyUntagged ?? true) && itemIds.length) {
    const [itemRes, unitRes] = await Promise.all([
      pool.query<{ item_id: string }>(
        "SELECT DISTINCT item_id FROM item_identifiers WHERE type = $1 AND item_id = ANY($2::uuid[])",
        [input.tagType, itemIds],
      ),
      pool.query<{ unit_id: string }>(
        `SELECT DISTINCT tiu.unit_id FROM tag_identifier_units tiu
           JOIN item_identifiers ii ON ii.id = tiu.identifier_id
          WHERE ii.type = $1 AND ii.item_id = ANY($2::uuid[])`,
        [input.tagType, itemIds],
      ),
    ]);
    taggedItems = new Set(itemRes.rows.map((r) => r.item_id));
    taggedUnits = new Set(unitRes.rows.map((r) => r.unit_id));
  }

  const queue: BindEntry[] = [];
  for (const itemId of itemIds) {
    const unitIds = unitsByItem.get(itemId);
    if (unitIds?.length) {
      for (const unitId of unitIds) if (!taggedUnits.has(unitId)) queue.push({ itemId, unitId });
    } else if (!taggedItems.has(itemId)) {
      queue.push({ itemId, unitId: null });
    }
  }
  return { queue, label };
}

const stateOf = (s: TagBindSession): BindState => ({
  queue: s.queue,
  position: s.position,
  history: s.history as BindAction[],
});

export type EntryView = {
  index: number;
  itemId: string;
  unitId: string | null;
  name: string;
  assetCode: string;
  unitLabel: string | null;
  locationName: string | null;
};

export type ActionView = { kind: BindAction["kind"]; value: string | null; at: string; entry: EntryView };

async function describeEntries(entries: (BindEntry & { index: number })[]): Promise<EntryView[]> {
  const itemIds = [...new Set(entries.map((e) => e.itemId))];
  const unitIds = [...new Set(entries.flatMap((e) => (e.unitId ? [e.unitId] : [])))];
  const [itemRows, unitRows] = await Promise.all([
    itemIds.length
      ? db
          .select({ id: items.id, name: items.name, assetCode: items.assetCode, locationName: locations.name })
          .from(items)
          .leftJoin(locations, eq(items.locationId, locations.id))
          .where(inArray(items.id, itemIds))
      : [],
    unitIds.length
      ? db
          .select({ id: itemUnits.id, assetCode: itemUnits.assetCode, label: itemUnits.label, serial: itemUnits.serial })
          .from(itemUnits)
          .where(inArray(itemUnits.id, unitIds))
      : [],
  ]);
  const itemsById = new Map(itemRows.map((r) => [r.id, r]));
  const unitsById = new Map(unitRows.map((r) => [r.id, r]));
  return entries.map((e) => {
    const item = itemsById.get(e.itemId);
    const unit = e.unitId ? unitsById.get(e.unitId) : undefined;
    return {
      index: e.index,
      itemId: e.itemId,
      unitId: e.unitId,
      // A record deleted mid-session still has a row to show.
      name: item?.name ?? "Deleted record",
      assetCode: unit?.assetCode ?? item?.assetCode ?? "",
      unitLabel: unit ? (unit.label ?? unit.serial ?? null) : null,
      locationName: item?.locationName ?? null,
    };
  });
}

export async function sessionView(s: TagBindSession) {
  const state = stateOf(s);
  const counts = sessionCounts(state);
  const recentActions = state.history.slice(-10).reverse();
  const wanted = [
    ...state.queue.slice(state.position, state.position + 6).map((e, i) => ({ ...e, index: state.position + i })),
    ...recentActions.map((a) => ({ ...state.queue[a.index]!, index: a.index })),
  ];
  const views = await describeEntries(wanted);
  const byIndex = new Map(views.map((v) => [v.index, v]));
  const ahead = views.filter((v) => v.index >= state.position).sort((a, b) => a.index - b.index);
  return {
    id: s.id,
    name: s.name,
    tagType: s.tagType,
    status: s.status,
    createdAt: s.createdAt,
    total: state.queue.length,
    position: state.position,
    ...counts,
    current: ahead[0] ?? null,
    upcoming: ahead.slice(1),
    recent: recentActions.map<ActionView>((a) => ({
      kind: a.kind,
      value: a.kind === "bind" ? a.value : null,
      at: a.at,
      entry: byIndex.get(a.index)!,
    })),
    canUndo: state.history.length > 0 && s.status === "active",
  };
}

export type SessionView = Awaited<ReturnType<typeof sessionView>>;

export async function createSession(input: CreateSessionInput, userOid: string | null) {
  const { queue, label } = await buildQueue(input);
  if (!queue.length) {
    throw badRequest(
      input.onlyUntagged ?? true
        ? `Nothing to bind: everything there already has ${input.tagType === "rfid" ? "an RFID" : "an NFC"} tag.`
        : "Nothing to bind: that list is empty.",
    );
  }
  if (queue.length > MAX_QUEUE) {
    throw badRequest(`That is ${queue.length} records. Bind at most ${MAX_QUEUE} in one session; pick a smaller location.`);
  }
  const name = input.name?.trim() || `${label} · ${input.tagType === "rfid" ? "RFID" : "NFC"}`;
  const [row] = await db
    .insert(tagBindSessions)
    .values({ name, tagType: input.tagType, queue, createdBy: userOid })
    .returning();
  logger.info("tags.bind_session.created", { id: row!.id, size: queue.length, tagType: input.tagType });
  return sessionView(row!);
}

export async function listSessions(status: "active" | "finished" = "active") {
  const rows = await db
    .select()
    .from(tagBindSessions)
    .where(eq(tagBindSessions.status, status))
    .orderBy(desc(tagBindSessions.updatedAt))
    .limit(20);
  return rows.map((s) => {
    const counts = sessionCounts(stateOf(s));
    return { id: s.id, name: s.name, tagType: s.tagType, status: s.status, total: s.queue.length, updatedAt: s.updatedAt, ...counts };
  });
}

export async function getSession(id: string) {
  const [row] = await db.select().from(tagBindSessions).where(eq(tagBindSessions.id, id)).limit(1);
  if (!row) throw notFound("That binding session no longer exists.");
  return sessionView(row);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockSession(tx: Tx, id: string): Promise<TagBindSession> {
  const [row] = await tx.select().from(tagBindSessions).where(eq(tagBindSessions.id, id)).for("update");
  if (!row) throw notFound("That binding session no longer exists.");
  if (row.status !== "active") throw conflict("That binding session is finished. Start a new one.");
  return row;
}

async function saveState(tx: Tx, id: string, state: BindState, status?: "finished"): Promise<TagBindSession> {
  const [row] = await tx
    .update(tagBindSessions)
    .set({ position: state.position, history: state.history, updatedAt: new Date(), ...(status ? { status } : {}) })
    .where(eq(tagBindSessions.id, id))
    .returning();
  return row!;
}

async function entryExists(tx: Tx, entry: BindEntry): Promise<boolean> {
  const { rows } = entry.unitId
    ? await tx.execute(sql`SELECT 1 FROM item_units WHERE id = ${entry.unitId} AND item_id = ${entry.itemId}`)
    : await tx.execute(sql`SELECT 1 FROM items WHERE id = ${entry.itemId}`);
  return rows.length > 0;
}

export type ReadOutcome =
  | { kind: "bound"; value: string; index: number; itemId: string; unitId: string | null }
  | { kind: "ignored"; reason: IgnoreReason; value: string; heldBy?: string };

/**
 * One tag read. Reads are serialized per session by a row lock, because a UHF
 * reader delivers them in bursts and two binds must never take the same slot.
 */
export async function recordRead(id: string, raw: string, userOid: string | null) {
  const value = normalizeTagUid(raw);
  const key = tagKey(value);
  const { outcome, row } = await db.transaction(async (tx) => {
    const session = await lockSession(tx, id);
    const state = stateOf(session);
    const holder = key
      ? (
          await tx.execute<{ name: string; asset_code: string }>(sql`
            SELECT i.name, i.asset_code
              FROM item_identifiers ii JOIN items i ON i.id = ii.item_id
             WHERE (ii.type IN ('rfid', 'nfc')
                    AND upper(regexp_replace(ii.value, '[^0-9A-Za-z]', '', 'g')) = ${key})
                OR ii.value = ${value}
             LIMIT 1`)
        ).rows[0]
      : undefined;

    // A record deleted since the session started cannot take a tag; step past
    // it rather than fail every read on the foreign key.
    let current = state;
    let decision = decideRead(current, value, Boolean(holder));
    while (decision.kind === "bind" && !(await entryExists(tx, decision.entry))) {
      current = applySkip(current, new Date().toISOString());
      decision = decideRead(current, value, Boolean(holder));
    }
    const unchanged = async () => (current === state ? session : saveState(tx, id, current));
    if (decision.kind === "ignore") {
      const heldBy = holder ? `${holder.name} (${holder.asset_code})` : undefined;
      return {
        outcome: { kind: "ignored", reason: decision.reason, value, heldBy } as ReadOutcome,
        row: await unchanged(),
      };
    }

    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO item_identifiers (item_id, type, value)
      VALUES (${decision.entry.itemId}, ${session.tagType}, ${value})
      ON CONFLICT DO NOTHING
      RETURNING id`);
    const identifierId = inserted.rows[0]?.id;
    if (!identifierId) {
      return { outcome: { kind: "ignored", reason: "in_use", value } as ReadOutcome, row: await unchanged() };
    }
    if (decision.entry.unitId) {
      await tx.execute(sql`
        INSERT INTO tag_identifier_units (identifier_id, unit_id)
        VALUES (${identifierId}, ${decision.entry.unitId})`);
    }
    const next = applyBind(current, value, identifierId, new Date().toISOString());
    const saved = await saveState(tx, id, next);
    return {
      outcome: {
        kind: "bound",
        value,
        index: decision.index,
        itemId: decision.entry.itemId,
        unitId: decision.entry.unitId,
      } as ReadOutcome,
      row: saved,
    };
  });

  if (outcome.kind === "bound") {
    await recordEvent(outcome.itemId, userOid, "updated", {
      tagBound: { type: row.tagType, value: outcome.value, unitId: outcome.unitId, sessionId: id },
    });
  }
  return { outcome, session: await sessionView(row) };
}

export async function skipEntry(id: string) {
  const row = await db.transaction(async (tx) => {
    const session = await lockSession(tx, id);
    return saveState(tx, id, applySkip(stateOf(session), new Date().toISOString()));
  });
  return sessionView(row);
}

/** Take back the last bind (removing the tag) or skip. */
export async function undoLast(id: string, userOid: string | null) {
  const { row, undone } = await db.transaction(async (tx) => {
    const session = await lockSession(tx, id);
    const { state, undone } = applyUndo(stateOf(session));
    if (!undone) throw conflict("Nothing to undo yet.");
    if (undone.kind === "bind") {
      await tx.execute(sql`DELETE FROM item_identifiers WHERE id = ${undone.identifierId}`);
    }
    return { row: await saveState(tx, id, state), undone };
  });
  if (undone.kind === "bind") {
    const entry = row.queue[undone.index];
    if (entry) {
      await recordEvent(entry.itemId, userOid, "updated", {
        tagUnbound: { type: row.tagType, value: undone.value, unitId: entry.unitId, sessionId: id },
      });
    }
  }
  return sessionView(row);
}

export async function finishSession(id: string) {
  const row = await db.transaction(async (tx) => {
    const session = await lockSession(tx, id);
    return saveState(tx, id, stateOf(session), "finished");
  });
  return sessionView(row);
}
