import type { Company, Entity, ItemDetail, Location, User } from "../../types";
import {
  CACHE_STORES,
  clearStores,
  count,
  done,
  get,
  getAll,
  getAllByIndex,
  getMeta,
  openDb,
  put,
  remove,
  setMeta,
  storeOf,
  write,
} from "./db";
import {
  applyToItem,
  codesFor,
  fromItemDetail,
  itemsTouched,
  pickMatch,
  toItemDetail,
  type Lookups,
} from "./local";
import type {
  CachedItem,
  LogEntry,
  OfflineScope,
  QueuedAction,
  Snapshot,
} from "./types";

/**
 * What this device holds for working offline, in the terms the rest of the
 * feature thinks in. Two halves that never mix: the read copy (items, codes,
 * places, holders), which can be thrown away and fetched again, and the queue
 * of changes made here, which is only ever emptied by sending or by a person
 * deciding to discard a change.
 */

const LOG_KEEP = 100;

// ---- The device switch -----------------------------------------------------

export async function deviceEnabled(): Promise<boolean> {
  return (await getMeta("device"))?.enabled ?? false;
}

export async function setDeviceEnabled(enabled: boolean): Promise<void> {
  await setMeta("device", { enabled, since: new Date().toISOString() });
}

// ---- The read copy ---------------------------------------------------------

function writeItem(tx: IDBTransaction, item: CachedItem, oldCodeKeys: IDBValidKey[]): void {
  const items = storeOf(tx, "items");
  const codes = storeOf(tx, "codes");
  items.put(item);
  for (const k of oldCodeKeys) codes.delete(k);
  for (const row of codesFor(item)) codes.put(row);
}

async function codeKeysFor(itemIds: string[]): Promise<Map<string, IDBValidKey[]>> {
  const db = await openDb();
  const index = db.transaction("codes").objectStore("codes").index("itemId");
  const entries = await Promise.all(
    itemIds.map(async (id) => [id, await done(index.getAllKeys(id))] as const),
  );
  return new Map(entries);
}

/**
 * Store a snapshot from the server. Places, holders and groups come whole and
 * replace what was here; items are added to whatever other scopes already
 * brought in. Changes still waiting to sync are laid back over the top, so the
 * screens keep showing what the person did.
 */
export async function saveSnapshot(snap: Snapshot): Promise<void> {
  const items: CachedItem[] = snap.items.map((i) => ({ ...i, cachedAt: snap.generatedAt }));
  const oldKeys = await codeKeysFor(items.map((i) => i.id));
  await write(["items", "codes", "locations", "entities", "companies"], (tx) => {
    const locations = storeOf(tx, "locations");
    const entities = storeOf(tx, "entities");
    const companies = storeOf(tx, "companies");
    locations.clear();
    entities.clear();
    companies.clear();
    for (const l of snap.locations) locations.put(l);
    for (const e of snap.entities) entities.put(e);
    for (const c of snap.companies) companies.put(c);
    for (const item of items) writeItem(tx, item, oldKeys.get(item.id) ?? []);
  });

  const scopes = ((await getMeta("scopes")) ?? []).filter((s) => s.locationId !== snap.scope.locationId);
  scopes.push({
    locationId: snap.scope.locationId,
    name: snap.scope.name,
    fetchedAt: snap.generatedAt,
    itemCount: items.length,
  });
  await setMeta("scopes", scopes);
  await reapplyQueued(items.map((i) => i.id));
}

export async function scopes(): Promise<OfflineScope[]> {
  return (await getMeta("scopes")) ?? [];
}

/** Drop the item copy so the remaining scopes can be fetched into a clean slate. */
export async function clearItems(): Promise<void> {
  await clearStores(["items", "codes"]);
}

export async function setScopes(list: OfflineScope[]): Promise<void> {
  await setMeta("scopes", list);
}

/** Throw away the read copy. Queued changes are kept. */
export async function clearCache(): Promise<void> {
  await clearStores(CACHE_STORES);
  await setMeta("scopes", []);
}

/**
 * Keep an item the server just sent, when this device is working offline, so
 * a record open on screen when the signal drops still opens from here.
 */
export async function putServerItem(detail: ItemDetail): Promise<void> {
  const item = fromItemDetail(detail, new Date().toISOString());
  const oldKeys = await codeKeysFor([item.id]);
  await write(["items", "codes"], (tx) => writeItem(tx, item, oldKeys.get(item.id) ?? []));
  await reapplyQueued([item.id]);
}

/** Replace a whole list the server sent (places, holders, groups). */
export async function putList(store: "locations" | "entities" | "companies", rows: (Location | Entity | Company)[]) {
  await write([store], (tx) => {
    const os = tx.objectStore(store);
    os.clear();
    for (const r of rows) os.put(r);
  });
}

export const getItem = (id: string) => get("items", id);
export const allItems = () => getAll("items");
export const allLocations = () => getAll("locations");
export const allEntities = () => getAll("entities");
export const allCompanies = () => getAll("companies");
export const getLocation = (id: string) => get("locations", id);

export async function lookups(): Promise<Lookups> {
  const [locations, entities, companies] = await Promise.all([
    allLocations(),
    allEntities(),
    allCompanies(),
  ]);
  return {
    locations: new Map(locations.map((l) => [l.id, l])),
    entities: new Map(entities.map((e) => [e.id, e])),
    companies: new Map(companies.map((c) => [c.id, c])),
  };
}

export async function resolveCode(code: string): Promise<{ itemId: string; unitId: string | null } | null> {
  const value = code.trim();
  if (!value) return null;
  return pickMatch(await getAllByIndex("codes", "code", value));
}

/** A resolver over every code at once, for reconciling a long list of reads. */
export async function codeResolver(): Promise<(code: string) => { itemId: string } | null> {
  const rows = await getAll("codes");
  const byCode = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byCode.get(r.code) ?? [];
    list.push(r);
    byCode.set(r.code, list);
  }
  return (code) => pickMatch(byCode.get(code.trim()) ?? []);
}

export async function itemDetail(id: string, matchedUnitId: string | null = null): Promise<ItemDetail | null> {
  const item = await getItem(id);
  if (!item) return null;
  const [lk, children, queue] = await Promise.all([
    lookups(),
    getAllByIndex("items", "parentItemId", id),
    listQueue(),
  ]);
  return toItemDetail(
    item,
    lk,
    children.sort((a, b) => a.name.localeCompare(b.name)),
    queue.filter((q) => q.status === "pending"),
    matchedUnitId,
  );
}

// ---- The queue -------------------------------------------------------------

export async function listQueue(): Promise<QueuedAction[]> {
  // The key is the creation order, so this is already oldest first.
  return getAll("queue");
}

export async function enqueue(entry: QueuedAction): Promise<QueuedAction> {
  const seq = (await put("queue", entry)) as number;
  return { ...entry, seq };
}

export async function updateQueued(entry: QueuedAction, patch: Partial<QueuedAction>): Promise<QueuedAction> {
  const next = { ...entry, ...patch };
  await put("queue", next);
  return next;
}

/** Records the change may touch, for keeping changes to one record in order. */
export function subjectsOf(q: Pick<QueuedAction, "action">): string[] {
  const a = q.action;
  if (a.type === "verify_apply" || a.type === "audit_apply") return [];
  if (a.unitId) return [`unit:${a.unitId}`];
  return a.itemId ? [`item:${a.itemId}`] : [];
}

/** Whether a change to these records is still waiting, so a new one must queue behind it. */
export async function hasQueuedFor(subjects: string[]): Promise<boolean> {
  if (!subjects.length) return false;
  const queue = await listQueue();
  return queue.some((q) => subjectsOf(q).some((s) => subjects.includes(s)));
}

/**
 * Take a change out of the queue for good: sent, found already done, or
 * discarded by a person. Kept in a short log so the device can show it.
 */
export async function finishQueued(
  entry: QueuedAction,
  outcome: LogEntry["outcome"],
  note: string | null = null,
): Promise<void> {
  await write(["queue", "blobs", "log"], (tx) => {
    tx.objectStore("queue").delete(entry.seq!);
    if (entry.request.blobId) tx.objectStore("blobs").delete(entry.request.blobId);
    tx.objectStore("log").put({
      id: entry.id,
      label: entry.action.label,
      outcome,
      note,
      createdAt: entry.createdAt,
      at: new Date().toISOString(),
    } satisfies LogEntry);
  });
  await trimLog();
}

async function trimLog(): Promise<void> {
  const db = await openDb();
  const keys = (await done(db.transaction("log").objectStore("log").getAllKeys())) as number[];
  if (keys.length <= LOG_KEEP) return;
  const drop = keys.slice(0, keys.length - LOG_KEEP);
  await write(["log"], (tx) => {
    for (const k of drop) tx.objectStore("log").delete(k);
  });
}

export async function recentLog(limit = 20): Promise<LogEntry[]> {
  return (await getAll("log")).reverse().slice(0, limit);
}

/**
 * Lay the effect of every change still waiting to sync back over the copy of
 * these items, after something replaced them with the server's version.
 */
export async function reapplyQueued(itemIds: string[]): Promise<void> {
  const wanted = new Set(itemIds);
  const pending = (await listQueue()).filter(
    (q) => q.status === "pending" && itemsTouched(q.action).some((id) => wanted.has(id)),
  );
  if (!pending.length) return;
  const touched = new Map<string, CachedItem>();
  for (const q of pending) {
    for (const id of itemsTouched(q.action)) {
      if (!wanted.has(id)) continue;
      const item = touched.get(id) ?? (await getItem(id));
      if (!item) continue;
      touched.set(id, applyToItem(item, q.action, { now: q.createdAt, userName: q.userName }, `local-${q.id}`));
    }
  }
  await write(["items"], (tx) => {
    for (const item of touched.values()) tx.objectStore("items").put(item);
  });
}

/** Apply a new change to the local copy of every item it touches. */
export async function applyLocally(q: QueuedAction): Promise<void> {
  const updated: CachedItem[] = [];
  for (const id of itemsTouched(q.action)) {
    const item = await getItem(id);
    if (item) updated.push(applyToItem(item, q.action, { now: q.createdAt, userName: q.userName }, `local-${q.id}`));
  }
  if (!updated.length) return;
  await write(["items"], (tx) => {
    for (const item of updated) tx.objectStore("items").put(item);
  });
}

// ---- Photos waiting to be sent ---------------------------------------------

export async function putBlob(id: string, blob: Blob): Promise<void> {
  await put("blobs", { id, blob, mime: blob.type || "image/jpeg", size: blob.size });
}

export const getBlob = (id: string) => get("blobs", id);

// ---- Session, for opening without a connection -----------------------------

export async function cachedUser(): Promise<User | undefined> {
  return getMeta("me");
}

// ---- Sizes, for the device panel -------------------------------------------

export async function stats() {
  const [items, locations, entities, queued, blobs] = await Promise.all([
    count("items"),
    count("locations"),
    count("entities"),
    count("queue"),
    getAll("blobs"),
  ]);
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    usage = est?.usage ?? null;
    quota = est?.quota ?? null;
  } catch {
    // Not every browser can say.
  }
  return {
    items,
    locations,
    entities,
    queued,
    photoBytes: blobs.reduce((n, b) => n + b.size, 0),
    usage,
    quota,
  };
}

