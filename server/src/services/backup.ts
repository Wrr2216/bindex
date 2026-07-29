import { eq } from "drizzle-orm";
import { db } from "../db/client";
import {
  items,
  itemIdentifiers,
  itemImages,
  itemEvents,
  itemAssignments,
  locations,
  companies,
  entities,
} from "../db/schema";
import { badRequest } from "../lib/errors";

/**
 * A JSON snapshot that round-trips: relationships, metadata, identifiers,
 * images and history all survive an export and re-import.
 *
 * Three things are left out on purpose. Accounts and integration tokens,
 * because a backup file travels and secrets should not. Caches and sync
 * history, because they rebuild themselves.
 */
export const BACKUP_FORMAT = "bindex.backup";
export const BACKUP_VERSION = 3;

// Files written before this project was renamed. Accepted on import so an
// existing backup is not stranded; never written.
const LEGACY_FORMATS = ["n8v-inventory-backup"];

/** Tables included in a backup, in parent-before-child insert order. */
const TABLES = [
  "companies",
  "locations",
  "entities",
  "items",
  "item_identifiers",
  "item_images",
  "item_events",
  "item_assignments",
] as const;
type TableName = (typeof TABLES)[number];

/** Timestamp columns per table, revived to Date objects on import. */
const DATE_FIELDS: Record<TableName, string[]> = {
  companies: ["createdAt"],
  locations: ["createdAt"],
  entities: ["createdAt"],
  items: ["expiresAt", "ninjaoneSyncedAt", "lastSpotCheckedAt", "createdAt", "updatedAt"],
  item_identifiers: ["createdAt"],
  item_images: [],
  item_events: ["createdAt"],
  item_assignments: ["checkedOutAt", "checkedInAt"],
};

export type Backup = {
  format: string;
  version: number;
  exportedAt: string;
  counts: Record<TableName, number>;
  data: Record<TableName, Record<string, unknown>[]>;
};

export async function buildBackup(): Promise<Backup> {
  const [co, loc, ent, it, ids, imgs, evts, asg] = await Promise.all([
    db.select().from(companies),
    db.select().from(locations),
    db.select().from(entities),
    db.select().from(items),
    db.select().from(itemIdentifiers),
    db.select().from(itemImages),
    db.select().from(itemEvents),
    db.select().from(itemAssignments),
  ]);
  const data: Backup["data"] = {
    companies: co,
    locations: loc,
    entities: ent,
    items: it,
    item_identifiers: ids,
    item_images: imgs,
    item_events: evts,
    item_assignments: asg,
  };
  const counts = Object.fromEntries(
    TABLES.map((t) => [t, data[t].length]),
  ) as Backup["counts"];
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), counts, data };
}

/** Validate the envelope shape and revive Date fields. Throws a 400 on mismatch. */
function parseBackup(input: unknown): Backup {
  const b = input as Partial<Backup> | null;
  if (!b || typeof b !== "object") throw badRequest("Backup file is empty or not JSON.");
  if (b.format !== BACKUP_FORMAT && !LEGACY_FORMATS.includes(String(b.format))) {
    throw badRequest("That is not a backup file from this app.");
  }
  if (typeof b.version !== "number" || b.version < 1 || b.version > BACKUP_VERSION) {
    throw badRequest(`Unsupported backup version ${String(b.version)} (this server expects ${BACKUP_VERSION}).`);
  }
  if (!b.data || typeof b.data !== "object") throw badRequest("Backup file has no data section.");
  for (const table of TABLES) {
    // A table added after the file was written is simply absent; treat it as empty.
    if (!Array.isArray(b.data[table])) b.data[table] = [];
    const rows = b.data[table];
    for (const row of rows) {
      for (const field of DATE_FIELDS[table]) {
        if (row[field] != null) row[field] = new Date(row[field] as string);
      }
    }
  }
  return b as Backup;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Replace everything with the snapshot. Destructive by design, and wrapped in a
 * transaction, so a failure part-way through leaves the current data untouched
 * rather than half-restored.
 */
export async function restoreBackup(input: unknown): Promise<{ restored: Record<TableName, number> }> {
  const backup = parseBackup(input);
  const d = backup.data;

  // items.parent_item_id self-references items(id); null it for the initial
  // insert and re-apply the links afterward so child-before-parent ordering
  // can't violate the FK.
  const parentLinks = new Map<string, string>();
  const itemRows = d.items.map((row) => {
    if (row.parentItemId) parentLinks.set(row.id as string, row.parentItemId as string);
    return { ...row, parentItemId: null };
  });

  await db.transaction(async (tx) => {
    // Children before parents. The foreign keys would cascade anyway; doing it
    // explicitly keeps the order visible.
    await tx.delete(itemAssignments);
    await tx.delete(itemEvents);
    await tx.delete(itemImages);
    await tx.delete(itemIdentifiers);
    await tx.delete(items);
    await tx.delete(entities);
    await tx.delete(locations);
    // Version 1 and 2 files predate groups. Keep the existing list rather than
    // wiping it in the name of a field the file never had.
    if (d.companies.length) await tx.delete(companies);

    // Parents first: companies before locations (locations.company_id references companies),
    // entities before items (items.utilized_by_entity_id references entities).
    for (const part of chunk(d.companies, 500)) await tx.insert(companies).values(part as never);
    for (const part of chunk(d.locations, 500)) await tx.insert(locations).values(part as never);
    for (const part of chunk(d.entities, 500)) await tx.insert(entities).values(part as never);
    for (const part of chunk(itemRows, 500)) await tx.insert(items).values(part as never);
    for (const [id, parentId] of parentLinks) {
      await tx.update(items).set({ parentItemId: parentId }).where(eq(items.id, id));
    }
    for (const part of chunk(d.item_identifiers, 500)) await tx.insert(itemIdentifiers).values(part as never);
    for (const part of chunk(d.item_images, 500)) await tx.insert(itemImages).values(part as never);
    for (const part of chunk(d.item_events, 500)) await tx.insert(itemEvents).values(part as never);
    for (const part of chunk(d.item_assignments, 500)) await tx.insert(itemAssignments).values(part as never);
  });

  return { restored: backup.counts };
}
