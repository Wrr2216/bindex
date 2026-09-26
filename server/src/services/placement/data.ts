import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { jobs, locations, type Job } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { OPEN_JOB_STATUSES } from "../jobs-core";
import { floorColor, readFloorColors, type FloorColors } from "./colors";
import type { PlacementLine } from "./match";
import { MISPLACED } from "./model";
import { buildTree, floorOf, pathNames, type Tree } from "./tree";

/**
 * Loading what placement works on: the location tree, a job's manifest lines
 * with the names a crew reads, and a job's placement settings.
 */

// Every scan needs the tree. Locations barely change during a delivery, so a
// few seconds of staleness is a fair price for not reading the table per scan.
const TREE_TTL_MS = 5_000;
let treeCache: { at: number; tree: Promise<Tree> } | null = null;

export function loadTree(): Promise<Tree> {
  const now = Date.now();
  if (!treeCache || now - treeCache.at > TREE_TTL_MS) {
    const tree = db
      .select({ id: locations.id, name: locations.name, parentId: locations.parentId })
      .from(locations)
      .then(buildTree);
    treeCache = { at: now, tree };
    tree.catch(() => {
      if (treeCache?.tree === tree) treeCache = null;
    });
  }
  return treeCache.tree;
}

/** For tests, and after a change that must be seen at once. */
export function forgetTree(): void {
  treeCache = null;
}

export async function loadJob(id: string): Promise<Job> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) throw notFound("Job not found");
  return job;
}

export const isOpenJob = (job: Pick<Job, "status">) => (OPEN_JOB_STATUSES as readonly string[]).includes(job.status);

/** Placement's own settings on a job, kept in jobs.metadata.placement. */
export type JobPlacementSettings = { floorColors: FloorColors };

export function jobSettings(job: Pick<Job, "metadata">): JobPlacementSettings {
  const raw = (job.metadata as Record<string, unknown> | null)?.placement as Record<string, unknown> | undefined;
  return { floorColors: readFloorColors(raw?.floorColors) };
}

export type Place = { id: string; name: string; path: string[] };

export const place = (id: string | null | undefined, tree: Tree): Place | null => {
  if (!id) return null;
  const row = tree.byId.get(id);
  return row ? { id, name: row.name, path: pathNames(id, tree) } : null;
};

/** A manifest line as the placement screens show it. */
export type LineView = PlacementLine & {
  itemName: string;
  assetCode: string;
  unitCode: string | null;
  unitLabel: string | null;
  stageAt: string;
  shipmentCode: string | null;
  shipmentName: string | null;
  shipmentStatus: string | null;
  origin: Place | null;
  destination: Place | null;
  /** Desk or bay as the move plan wrote it. */
  destinationLabel: string | null;
  /** The plan's floor, or the floor the destination's path names. */
  floor: string | null;
  /** The floor exactly as the plan has it. */
  planFloor: string | null;
  floorColor: string;
  department: string | null;
  crateNo: string | null;
  notes: string | null;
  /** Where it was last found out of place, while it is misplaced. */
  lastActual: (Place & { at: string }) | null;
};

type LineRow = {
  id: string;
  job_id: string;
  item_id: string;
  unit_id: string | null;
  stage: string;
  stage_at: Date;
  shipment_id: string | null;
  origin_location_id: string | null;
  destination_location_id: string | null;
  destination_label: string | null;
  floor: string | null;
  department: string | null;
  crate_no: string | null;
  notes: string | null;
  item_name: string;
  asset_code: string;
  unit_code: string | null;
  unit_label: string | null;
  shipment_code: string | null;
  shipment_name: string | null;
  shipment_status: string | null;
  last_actual_id: string | null;
  last_actual_at: Date | null;
};

const LINE_SQL = `
  SELECT ji.id, ji.job_id, ji.item_id, ji.unit_id, ji.stage, ji.stage_at, ji.shipment_id,
         ji.origin_location_id, ji.destination_location_id, ji.destination_label,
         ji.floor, ji.department, ji.crate_no, ji.notes,
         i.name AS item_name, i.asset_code, u.asset_code AS unit_code, u.label AS unit_label,
         s.code AS shipment_code, s.name AS shipment_name, s.status AS shipment_status,
         lo.actual_location_id AS last_actual_id, lo.created_at AS last_actual_at
    FROM job_items ji
    JOIN items i ON i.id = ji.item_id
    LEFT JOIN item_units u ON u.id = ji.unit_id
    LEFT JOIN shipments s ON s.id = ji.shipment_id
    LEFT JOIN LATERAL (
      SELECT o.actual_location_id, o.created_at
        FROM placement_observations o
       WHERE ji.stage = '${MISPLACED}' AND o.job_item_id = ji.id AND o.outcome = 'misplaced'
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT 1
    ) lo ON true`;

/** Natural order for a crew: floor, room, desk, then the item. */
const LINE_ORDER = `ORDER BY ji.floor NULLS LAST, ji.destination_location_id NULLS LAST,
                             ji.destination_label NULLS LAST, i.name, u.asset_code NULLS FIRST`;

export function lineView(r: LineRow, tree: Tree, colors: FloorColors): LineView {
  const destination = place(r.destination_location_id, tree);
  const floor = r.floor ?? (r.destination_location_id ? floorOf(r.destination_location_id, tree) : null);
  const actual = r.last_actual_id ? place(r.last_actual_id, tree) : null;
  return {
    id: r.id,
    jobId: r.job_id,
    itemId: r.item_id,
    unitId: r.unit_id,
    stage: r.stage,
    stageAt: new Date(r.stage_at).toISOString(),
    shipmentId: r.shipment_id,
    shipmentCode: r.shipment_code,
    shipmentName: r.shipment_name,
    shipmentStatus: r.shipment_status,
    destinationLocationId: r.destination_location_id,
    lastActualId: r.last_actual_id,
    itemName: r.item_name,
    assetCode: r.asset_code,
    unitCode: r.unit_code,
    unitLabel: r.unit_label,
    origin: place(r.origin_location_id, tree),
    destination,
    destinationLabel: r.destination_label,
    floor,
    planFloor: r.floor,
    floorColor: floorColor(floor, colors),
    department: r.department,
    crateNo: r.crate_no,
    notes: r.notes,
    lastActual: actual && r.last_actual_at ? { ...actual, at: new Date(r.last_actual_at).toISOString() } : null,
  };
}

/** Largest manifest the progress screens read in one go. */
export const MAX_LINES = 20_000;

/** A job's lines, all of them or those of some items, in crew order. */
export async function jobLines(
  jobId: string,
  tree: Tree,
  colors: FloorColors,
  opts: { itemIds?: string[]; lineIds?: string[] } = {},
): Promise<LineView[]> {
  if ((opts.itemIds && !opts.itemIds.length) || (opts.lineIds && !opts.lineIds.length)) return [];
  const params: unknown[] = [jobId];
  let where = "WHERE ji.job_id = $1";
  if (opts.itemIds) {
    params.push(opts.itemIds);
    where += ` AND ji.item_id = ANY($${params.length}::uuid[])`;
  }
  if (opts.lineIds) {
    params.push(opts.lineIds);
    where += ` AND ji.id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await pool.query<LineRow>(`${LINE_SQL} ${where} ${LINE_ORDER} LIMIT ${MAX_LINES}`, params);
  // A room made in the last few seconds is not in the cached tree yet; one
  // fresh read names it rather than showing the line with no destination.
  const known = (id: string | null) => !id || tree.byId.has(id);
  if (!rows.every((r) => known(r.destination_location_id) && known(r.origin_location_id) && known(r.last_actual_id))) {
    forgetTree();
    tree = await loadTree();
  }
  return rows.map((r) => lineView(r, tree, colors));
}

/**
 * Lines of these items on jobs in the given statuses, across jobs: what the
 * reader worker matches a batch of reads against.
 */
export async function linesForItems(itemIds: string[], statuses: readonly string[]): Promise<PlacementLine[]> {
  if (!itemIds.length) return [];
  const { rows } = await pool.query<LineRow>(
    `${LINE_SQL}
      JOIN jobs j ON j.id = ji.job_id
     WHERE ji.item_id = ANY($1::uuid[]) AND j.status = ANY($2::text[])`,
    [itemIds, [...statuses]],
  );
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    itemId: r.item_id,
    unitId: r.unit_id,
    stage: r.stage,
    shipmentId: r.shipment_id,
    destinationLocationId: r.destination_location_id,
    lastActualId: r.last_actual_id,
  }));
}

/** Every place a job delivers to. A reader in one of them is in a room that matters. */
export async function jobAreas(jobIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!jobIds.length) return out;
  const { rows } = await pool.query<{ job_id: string; destination_location_id: string }>(
    `SELECT DISTINCT job_id, destination_location_id FROM job_items
      WHERE job_id = ANY($1::uuid[]) AND destination_location_id IS NOT NULL`,
    [jobIds],
  );
  for (const r of rows) out.set(r.job_id, [...(out.get(r.job_id) ?? []), r.destination_location_id]);
  return out;
}

/** Open jobs, other than `exceptJobId`, that these items are on, with where each goes there. */
export async function otherOpenJobs(
  itemIds: string[],
  exceptJobId: string | null,
  tree: Tree,
): Promise<
  Map<string, { id: string; code: string; name: string; unitId: string | null; destination: Place | null; floor: string | null }[]>
> {
  const out = new Map<string, { id: string; code: string; name: string; unitId: string | null; destination: Place | null; floor: string | null }[]>();
  if (!itemIds.length) return out;
  const { rows } = await pool.query<{
    item_id: string;
    unit_id: string | null;
    id: string;
    code: string;
    name: string;
    destination_location_id: string | null;
    floor: string | null;
  }>(
    `SELECT ji.item_id, ji.unit_id, j.id, j.code, j.name, ji.destination_location_id, ji.floor
       FROM job_items ji JOIN jobs j ON j.id = ji.job_id
      WHERE ji.item_id = ANY($1::uuid[]) AND j.status = ANY($2::text[])
        AND ($3::uuid IS NULL OR j.id <> $3::uuid)
      ORDER BY j.created_at DESC`,
    [itemIds, [...OPEN_JOB_STATUSES], exceptJobId],
  );
  for (const r of rows) {
    const list = out.get(r.item_id) ?? [];
    list.push({
      id: r.id,
      code: r.code,
      name: r.name,
      unitId: r.unit_id,
      destination: place(r.destination_location_id, tree),
      floor: r.floor ?? (r.destination_location_id ? floorOf(r.destination_location_id, tree) : null),
    });
    out.set(r.item_id, list);
  }
  return out;
}

export type ItemName = { id: string; name: string; assetCode: string };

export async function itemNames(itemIds: string[]): Promise<Map<string, ItemName>> {
  if (!itemIds.length) return new Map();
  const { rows } = await pool.query<{ id: string; name: string; asset_code: string }>(
    "SELECT id, name, asset_code FROM items WHERE id = ANY($1::uuid[])",
    [itemIds],
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, assetCode: r.asset_code }]));
}
