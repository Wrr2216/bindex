import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  items,
  itemUnits,
  itemIdentifiers,
  itemImages,
  itemEvents,
  itemAssignments,
  locations,
  companies,
  entities,
  trackingDevices,
  tagIdentifierUnits,
  tagEpcs,
  teardownGuides,
  teardownSteps,
  teardownParts,
} from "../db/schema";
import { badRequest } from "../lib/errors";
import { clearJobsCoreTables, exportJobsCoreTables, restoreJobsCoreTables } from "./jobs-core/backup";
import { clearRegisterTables, registerBackupData, restoreRegisterTables } from "./register-reconcile/backup";
import { consumablesBackupData, restoreConsumables } from "./consumables/backup";
import {
  AI_CONDITION_DATE_FIELDS,
  aiConditionBackupRows,
  parkAiConditionRows,
  restoreAiConditionRows,
} from "./ai-condition/backup";
import { exportInspectionTables, restoreInspectionTables } from "./inspections/backup";
import {
  VALUATION_DATE_FIELDS,
  VALUATION_TABLES,
  afterValuationRestore,
  beforeValuationRestore,
  valuationBackupData,
  valuationTablesPresent,
} from "./valuation/backup";
import { clearCrewTables, exportCrewTables, predatesCrew, restoreCrewTables } from "./crew/backup";
import { clearCustodyTables, exportCustodyTables, restoreCustodyTables } from "./custody/backup";
import { clearGpsTables, exportGpsTables, restoreGpsTables } from "./gps/backup";
import { DOCUMENTS_DATE_FIELDS, exportDocumentsTables, restoreDocumentsTables } from "./documents/backup";
import { exportPortalTables, keepPortalSecrets, restorePortalTables } from "./portal/backup";
import { exportOpsIntelTables, restoreOpsIntelTables } from "./ops-intel/backup";
import { exportPlacementTables, restorePlacementTables } from "./placement/backup";

/**
 * A JSON snapshot that round-trips: relationships, metadata, units,
 * identifiers, images and history all survive an export and re-import.
 *
 * Some things are left out on purpose. Accounts and integration tokens,
 * because a backup file travels and secrets should not. Caches and sync
 * history, because they rebuild themselves. Uploaded photo bytes, because they
 * are binary; a restore keeps the photos of every item that still exists
 * afterwards, and a database dump covers the rest.
 */
export const BACKUP_FORMAT = "bindex.backup";
// 4 added item_units.
export const BACKUP_VERSION = 4;

// Files written before this project was renamed. Accepted on import so an
// existing backup is not stranded; never written.
const LEGACY_FORMATS = ["n8v-inventory-backup"];

/** Tables included in a backup, in parent-before-child insert order. */
const TABLES = [
  "companies",
  "locations",
  "entities",
  "items",
  "item_units",
  "item_identifiers",
  "item_images",
  "item_events",
  "item_assignments",
  "tracking_devices",
  "job_types",
  "projects",
  "project_phases",
  "jobs",
  "job_tasks",
  "shipments",
  "shipment_status_history",
  "job_items",
  "job_item_stage_history",
  "register_imports",
  "register_rows",
  "register_location_map",
  "reconciliation_runs",
  "reconciliation_results",
  "consumable_items",
  "stock_levels",
  "stock_movements",
  "equipment_kits",
  "equipment_kit_lines",
  // Tag commissioning. tag_legacy_stickers is rebuilt from the identifiers by
  // a trigger, and binding sessions are work in progress, so neither is here.
  "tag_identifier_units",
  "tag_epcs",
  "condition_sweeps",
  "condition_reports",
  "container_captures",
  "inspections",
  "inspection_findings",
  ...VALUATION_TABLES,
  "crew_credential_types",
  "crew_workers",
  "crew_credentials",
  "crew_checkins",
  "custody_controls",
  "custody_transfers",
  "custody_transfer_items",
  "teardown_guides",
  "teardown_steps",
  "teardown_parts",
  "geofences",
  "gps_trackers",
  "gps_tracker_links",
  "document_custom_fields",
  "document_templates",
  "document_template_versions",
  "document_packets",
  "document_packet_templates",
  "document_job_packets",
  "documents",
  "document_exports",
  "portal_grants",
  "portal_notes",
  "ops_location_profiles",
  "placement_room_map",
  "placement_observations",
] as const;
type TableName = (typeof TABLES)[number];

/** Timestamp columns per table, revived to Date objects on import. */
const DATE_FIELDS: Record<TableName, string[]> = {
  companies: ["createdAt"],
  locations: ["createdAt"],
  entities: ["createdAt"],
  items: ["expiresAt", "ninjaoneSyncedAt", "lastSpotCheckedAt", "createdAt", "updatedAt"],
  item_units: ["createdAt", "updatedAt"],
  item_identifiers: ["createdAt"],
  item_images: [],
  item_events: ["createdAt"],
  item_assignments: ["checkedOutAt", "checkedInAt"],
  tracking_devices: ["lastSeenAt", "createdAt", "updatedAt"],
  job_types: ["createdAt", "updatedAt"],
  projects: ["createdAt", "updatedAt"],
  project_phases: ["createdAt"],
  jobs: ["scheduledStart", "scheduledEnd", "startedAt", "completedAt", "createdAt", "updatedAt"],
  job_tasks: ["dueAt", "startedAt", "completedAt", "createdAt", "updatedAt"],
  shipments: ["eta", "departedAt", "arrivedAt", "createdAt", "updatedAt"],
  shipment_status_history: ["createdAt"],
  job_items: ["stageAt", "createdAt", "updatedAt"],
  job_item_stage_history: ["createdAt"],
  register_imports: ["createdAt", "updatedAt"],
  register_rows: [],
  register_location_map: ["createdAt", "updatedAt"],
  reconciliation_runs: ["createdAt"],
  reconciliation_results: ["resolvedAt"],
  consumable_items: ["createdAt", "updatedAt"],
  stock_levels: ["updatedAt"],
  stock_movements: ["createdAt"],
  equipment_kits: ["expectedReturnAt", "createdAt", "closedAt"],
  equipment_kit_lines: ["createdAt"],
  tag_identifier_units: ["createdAt"],
  tag_epcs: ["encodedAt", "createdAt", "updatedAt"],
  ...AI_CONDITION_DATE_FIELDS,
  inspections: ["startedAt", "completedAt", "signedAt", "createdAt", "updatedAt"],
  inspection_findings: ["createdAt", "updatedAt"],
  ...VALUATION_DATE_FIELDS,
  crew_credential_types: ["createdAt", "updatedAt"],
  crew_workers: ["createdAt", "updatedAt"],
  crew_credentials: ["verifiedAt", "createdAt", "updatedAt"],
  crew_checkins: ["checkedInAt", "checkedOutAt", "createdAt", "updatedAt"],
  custody_controls: ["setAt"],
  custody_transfers: ["at", "lockedAt", "linkExpiresAt", "linkUsedAt", "voidedAt", "completedAt", "createdAt", "updatedAt"],
  custody_transfer_items: ["createdAt"],
  teardown_guides: ["refinedAt", "jobQueuedAt", "jobStartedAt", "jobHeartbeatAt", "jobFinishedAt", "createdAt", "updatedAt"],
  teardown_steps: ["createdAt", "updatedAt"],
  teardown_parts: ["reassembledAt", "createdAt", "updatedAt"],
  geofences: ["geometryAt", "createdAt", "updatedAt"],
  gps_trackers: ["statusAt"],
  gps_tracker_links: ["assignedAt", "endedAt"],
  ...DOCUMENTS_DATE_FIELDS,
  portal_grants: ["expiresAt", "revokedAt", "lastUsedAt", "createdAt", "updatedAt"],
  portal_notes: ["createdAt"],
  ops_location_profiles: ["createdAt", "updatedAt"],
  placement_room_map: ["createdAt", "updatedAt"],
  placement_observations: ["createdAt"],
};

export type Backup = {
  format: string;
  version: number;
  exportedAt: string;
  counts: Record<TableName, number>;
  data: Record<TableName, Record<string, unknown>[]>;
};

export async function buildBackup(): Promise<Backup> {
  const [co, loc, ent, it, units, ids, imgs, evts, asg, devs, tagUnits, epcs, tdGuides, tdSteps, tdParts] =
    await Promise.all([
    db.select().from(companies),
    db.select().from(locations),
    db.select().from(entities),
    db.select().from(items),
    db.select().from(itemUnits),
    db.select().from(itemIdentifiers),
    db.select().from(itemImages),
    db.select().from(itemEvents),
    db.select().from(itemAssignments),
    // Device tokens are secrets and stay out of the file; see restoreBackup.
    db.select().from(trackingDevices).then((rows) => rows.map(({ tokenHash: _t, tokenLast4: _l, ...d }) => d)),
    db.select().from(tagIdentifierUnits),
    db.select().from(tagEpcs),
    db.select().from(teardownGuides),
    db.select().from(teardownSteps),
    db.select().from(teardownParts),
  ]);
  const data: Backup["data"] = {
    companies: co,
    locations: loc,
    entities: ent,
    items: it,
    item_units: units,
    item_identifiers: ids,
    item_images: imgs,
    item_events: evts,
    item_assignments: asg,
    tracking_devices: devs,
    ...(await exportJobsCoreTables()),
    ...(await registerBackupData()),
    ...(await consumablesBackupData()),
    tag_identifier_units: tagUnits,
    tag_epcs: epcs,
    ...(await aiConditionBackupRows()),
    ...(await exportInspectionTables()),
    ...(await valuationBackupData()),
    ...(await exportCrewTables()),
    ...(await exportCustodyTables()),
    teardown_guides: tdGuides,
    teardown_steps: tdSteps,
    teardown_parts: tdParts,
    ...(await exportGpsTables()),
    ...(await exportDocumentsTables()),
    ...(await exportPortalTables()),
    ...(await exportOpsIntelTables()),
    ...(await exportPlacementTables()),
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
  const valuationPresent = valuationTablesPresent(input);
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

  // Files written before version 4 predate units in the backup. Like groups
  // below, keep the existing units rather than wipe them for a table the file
  // never had.
  const keepUnits = backup.version < 4;
  let unitCount = 0;

  await db.transaction(async (tx) => {
    // Photo bytes are not in the file, and deleting items cascades to them.
    // Park them for the length of the transaction and put back those whose
    // item is in the snapshot, so /api/photos/:id links keep resolving.
    await tx.execute(sql`CREATE TEMP TABLE backup_kept_photos ON COMMIT DROP AS SELECT * FROM item_photos`);
    await clearRegisterTables(tx);
    if (keepUnits) {
      await tx.execute(sql`CREATE TEMP TABLE backup_kept_units ON COMMIT DROP AS SELECT * FROM item_units`);
    }
    // Device tokens are not in the file, so keep the current devices aside to
    // carry their tokens over (and the devices themselves, for an older file).
    await tx.execute(sql`CREATE TEMP TABLE backup_kept_devices ON COMMIT DROP AS SELECT * FROM tracking_devices`);
    // Condition records point at items, units and locations; set them aside too.
    await parkAiConditionRows(tx);
    await beforeValuationRestore(tx, valuationPresent);
    await keepPortalSecrets(tx);

    // Children before parents. The foreign keys would cascade anyway; doing it
    // explicitly keeps the order visible.
    await clearCrewTables(tx, { keep: predatesCrew(d) });
    await clearCustodyTables(tx);
    await clearGpsTables(tx);
    await clearJobsCoreTables(tx, { keepJobTypes: d.job_types.length === 0 });
    await tx.delete(itemAssignments);
    await tx.delete(trackingDevices);
    await tx.delete(itemEvents);
    await tx.delete(itemImages);
    await tx.delete(itemIdentifiers);
    await tx.delete(itemUnits);
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
    await tx.execute(
      sql`INSERT INTO item_photos SELECT k.* FROM backup_kept_photos k WHERE EXISTS (SELECT 1 FROM items i WHERE i.id = k.item_id)`,
    );
    // Units before assignments (item_assignments.unit_id references item_units).
    if (keepUnits) {
      // A kept unit may point at a location or holder the snapshot no longer has.
      await tx.execute(sql`
        UPDATE backup_kept_units k SET location_id = NULL
        WHERE location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = k.location_id)`);
      await tx.execute(sql`
        UPDATE backup_kept_units k SET utilized_by_entity_id = NULL
        WHERE utilized_by_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = k.utilized_by_entity_id)`);
      await tx.execute(
        sql`INSERT INTO item_units SELECT k.* FROM backup_kept_units k WHERE EXISTS (SELECT 1 FROM items i WHERE i.id = k.item_id)`,
      );
    } else {
      for (const part of chunk(d.item_units, 500)) await tx.insert(itemUnits).values(part as never);
    }
    for (const part of chunk(d.item_identifiers, 500)) await tx.insert(itemIdentifiers).values(part as never);
    for (const part of chunk(d.item_images, 500)) await tx.insert(itemImages).values(part as never);
    for (const part of chunk(d.item_events, 500)) await tx.insert(itemEvents).values(part as never);

    // A unit assignment needs its unit. One whose unit is gone (an older file
    // restored over an instance that never had that unit) cannot be restored;
    // drop it rather than fail the whole restore on the foreign key.
    const present = new Set((await tx.select({ id: itemUnits.id }).from(itemUnits)).map((u) => u.id));
    d.item_assignments = d.item_assignments.filter((a) => !a.unitId || present.has(a.unitId as string));
    for (const part of chunk(d.item_assignments, 500)) await tx.insert(itemAssignments).values(part as never);
    await restoreRegisterTables(tx, d);
    // Deleting items and identifiers above cascaded to these. Rows whose unit
    // did not come back are dropped, as unit assignments are.
    const identifierIds = new Set(d.item_identifiers.map((r) => r.id as string));
    d.tag_identifier_units = d.tag_identifier_units.filter(
      (r) => identifierIds.has(r.identifierId as string) && present.has(r.unitId as string),
    );
    for (const part of chunk(d.tag_identifier_units, 500)) {
      await tx.insert(tagIdentifierUnits).values(part as never);
    }
    const itemIds = new Set(d.items.map((r) => r.id as string));
    d.tag_epcs = d.tag_epcs.filter(
      (r) => itemIds.has(r.itemId as string) && (!r.unitId || present.has(r.unitId as string)),
    );
    for (const part of chunk(d.tag_epcs, 500)) await tx.insert(tagEpcs).values(part as never);
    unitCount = present.size;

    // Devices come after the zones, items and units they point at.
    if (d.tracking_devices.length) {
      for (const part of chunk(d.tracking_devices, 500)) await tx.insert(trackingDevices).values(part as never);
      await tx.execute(sql`
        UPDATE tracking_devices t SET token_hash = k.token_hash, token_last4 = k.token_last4
          FROM backup_kept_devices k WHERE k.id = t.id`);
    } else {
      // A file from before devices existed: keep the registry, minus links to
      // records the snapshot no longer has.
      await tx.execute(sql`
        UPDATE backup_kept_devices k SET location_id = NULL
        WHERE location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = k.location_id)`);
      await tx.execute(sql`
        UPDATE backup_kept_devices k SET item_id = NULL, unit_id = NULL
        WHERE item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = k.item_id)`);
      await tx.execute(sql`
        UPDATE backup_kept_devices k SET unit_id = NULL
        WHERE unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM item_units u WHERE u.id = k.unit_id)`);
      await tx.execute(sql`INSERT INTO tracking_devices SELECT * FROM backup_kept_devices`);
    }
    await restoreJobsCoreTables(tx, d);
    await restoreConsumables(tx, d);

    await restoreAiConditionRows(tx, d);
    await restoreInspectionTables(tx, d);
    await afterValuationRestore(tx, d, valuationPresent);
    await restoreCrewTables(tx, d, { keep: predatesCrew(d) });
    await restoreCustodyTables(tx, d);

    // Teardown guides point at items without a foreign key, so deleting the
    // items above left them in place. A file with guides replaces them; an
    // older file keeps them. Their videos and pictures are attachments, which
    // the file does not carry either way.
    if (d.teardown_guides.length) {
      await tx.delete(teardownParts);
      await tx.delete(teardownSteps);
      await tx.delete(teardownGuides);
      for (const part of chunk(d.teardown_guides, 500)) await tx.insert(teardownGuides).values(part as never);
      for (const part of chunk(d.teardown_steps, 500)) await tx.insert(teardownSteps).values(part as never);
      for (const part of chunk(d.teardown_parts, 500)) await tx.insert(teardownParts).values(part as never);
    }
    await restoreGpsTables(tx, d);
    await restoreDocumentsTables(tx, d);
    await restorePortalTables(tx, d);
    await restoreOpsIntelTables(tx, d);
    // Cleared with the jobs they hang off (ON DELETE CASCADE).
    await restorePlacementTables(tx, d);
  });

  // Counted from what was inserted: an older file's counts lack newer tables,
  // and dropped assignments are not restored.
  const restored = Object.fromEntries(TABLES.map((t) => [t, d[t].length])) as Record<TableName, number>;
  restored.item_units = unitCount;
  return { restored };
}
