import type { Company, Entity, Location } from "../../types";
import type { CachedItem, CodeRow, LogEntry, MetaValues, QueuedAction } from "./types";

/**
 * A small typed wrapper over IndexedDB: promises instead of callbacks, and one
 * place that knows the stores. Nothing here knows what the data means.
 */

const DB_NAME = "bindex-offline";
const DB_VERSION = 1;

export type BlobRow = { id: string; blob: Blob; mime: string; size: number };
export type MetaRow = { key: keyof MetaValues; value: unknown };

export type Stores = {
  items: CachedItem;
  codes: CodeRow;
  locations: Location;
  entities: Entity;
  companies: Company;
  meta: MetaRow;
  queue: QueuedAction;
  blobs: BlobRow;
  log: LogEntry;
};
export type StoreName = keyof Stores;

/** The read copy, cleared by "Clear offline copy". The queue is never in here. */
export const CACHE_STORES: StoreName[] = ["items", "codes", "locations", "entities", "companies"];

let opening: Promise<IDBDatabase> | null = null;

export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    // Some privacy modes throw on the mere access.
    return false;
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) {
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("parentItemId", "parentItemId");
        items.createIndex("locationId", "locationId");
      }
      if (!db.objectStoreNames.contains("codes")) {
        const codes = db.createObjectStore("codes", { keyPath: "key" });
        codes.createIndex("code", "code");
        codes.createIndex("itemId", "itemId");
      }
      for (const name of ["locations", "entities", "companies", "blobs"]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("queue")) {
        db.createObjectStore("queue", { keyPath: "seq", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("log")) {
        db.createObjectStore("log", { keyPath: "seq", autoIncrement: true });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema needs this one to let go.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("Could not open offline storage"));
    req.onblocked = () => reject(new Error("Offline storage is blocked by another tab"));
  });
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

export function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Offline storage write was aborted"));
  });
}

export async function get<S extends StoreName>(store: S, key: IDBValidKey): Promise<Stores[S] | undefined> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).get(key)) as Promise<Stores[S] | undefined>;
}

export async function getAll<S extends StoreName>(store: S): Promise<Stores[S][]> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).getAll()) as Promise<Stores[S][]>;
}

export async function getAllByIndex<S extends StoreName>(
  store: S,
  index: string,
  key: IDBValidKey,
): Promise<Stores[S][]> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).index(index).getAll(key)) as Promise<
    Stores[S][]
  >;
}

export async function count(store: StoreName): Promise<number> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).count());
}

export async function put<S extends StoreName>(store: S, value: Stores[S]): Promise<IDBValidKey> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const key = done(tx.objectStore(store).put(value));
  await finished(tx);
  return key;
}

export async function remove(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await finished(tx);
}

/**
 * Several writes that land together or not at all. The callback must issue
 * its requests synchronously: IndexedDB commits a transaction as soon as it
 * has nothing left to do, so an await inside would end it early.
 */
export async function write(
  stores: StoreName[],
  fn: (tx: IDBTransaction) => void,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(stores, "readwrite");
  fn(tx);
  await finished(tx);
}

/** Store accessor typed to what it holds. */
export function storeOf<S extends StoreName>(tx: IDBTransaction, store: S) {
  const os = tx.objectStore(store);
  return {
    put: (value: Stores[S]) => os.put(value),
    delete: (key: IDBValidKey) => os.delete(key),
    clear: () => os.clear(),
    index: (name: string) => os.index(name),
  };
}

export async function clearStores(stores: StoreName[]): Promise<void> {
  await write(stores, (tx) => {
    for (const s of stores) tx.objectStore(s).clear();
  });
}

export async function getMeta<K extends keyof MetaValues>(key: K): Promise<MetaValues[K] | undefined> {
  const row = await get("meta", key);
  return row?.value as MetaValues[K] | undefined;
}

export async function setMeta<K extends keyof MetaValues>(key: K, value: MetaValues[K] | null): Promise<void> {
  if (value === null) {
    await remove("meta", key);
    return;
  }
  await put("meta", { key, value });
}
