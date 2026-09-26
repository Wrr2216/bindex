import { db, pool } from "../../db/client";
import { placementObservations, type PlacementOutcome } from "../../db/schema";
import { place, type Place } from "./data";
import type { Tree } from "./tree";

/**
 * Placement observations: the room a line was actually found in, the truck
 * it came off, the job it really belongs to. Stage changes are the jobs
 * core's history; these are the facts around them a crew lead needs to fix
 * a wrong delivery.
 */

export type NewObservation = {
  jobId: string;
  jobItemId?: string | null;
  itemId: string;
  unitId?: string | null;
  code?: string | null;
  outcome: PlacementOutcome;
  expectedLocationId?: string | null;
  actualLocationId?: string | null;
  shipmentId?: string | null;
  otherJobId?: string | null;
  deviceId?: string | null;
  via: string;
  userOid?: string | null;
  actor?: string | null;
  note?: string | null;
};

export async function recordObservations(rows: NewObservation[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await db.insert(placementObservations).values(
      part.map((r) => ({
        jobId: r.jobId,
        jobItemId: r.jobItemId ?? null,
        itemId: r.itemId,
        unitId: r.unitId ?? null,
        code: r.code ?? null,
        outcome: r.outcome,
        expectedLocationId: r.expectedLocationId ?? null,
        actualLocationId: r.actualLocationId ?? null,
        shipmentId: r.shipmentId ?? null,
        otherJobId: r.otherJobId ?? null,
        deviceId: r.deviceId ?? null,
        via: r.via,
        userOid: r.userOid ?? null,
        actor: r.actor ?? null,
        note: r.note ?? null,
      })),
    );
  }
}

export type ObservationView = {
  id: number;
  at: string;
  outcome: PlacementOutcome;
  jobItemId: string | null;
  itemId: string;
  unitId: string | null;
  itemName: string;
  assetCode: string;
  unitCode: string | null;
  code: string | null;
  expected: Place | null;
  actual: Place | null;
  shipmentCode: string | null;
  otherJob: { id: string; code: string } | null;
  deviceId: string | null;
  deviceName: string | null;
  via: string;
  actor: string | null;
  note: string | null;
};

/** A job's latest observations, newest first. */
export async function listObservations(jobId: string, tree: Tree, limit = 100): Promise<ObservationView[]> {
  const { rows } = await pool.query(
    `SELECT o.*, i.name AS item_name, i.asset_code, u.asset_code AS unit_code,
            s.code AS shipment_code, oj.code AS other_job_code, d.name AS device_name
       FROM placement_observations o
       JOIN items i ON i.id = o.item_id
       LEFT JOIN item_units u ON u.id = o.unit_id
       LEFT JOIN shipments s ON s.id = o.shipment_id
       LEFT JOIN jobs oj ON oj.id = o.other_job_id
       LEFT JOIN tracking_devices d ON d.id = o.device_id
      WHERE o.job_id = $1
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $2`,
    [jobId, Math.min(Math.max(limit, 1), 1000)],
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    at: new Date(r.created_at as string).toISOString(),
    outcome: r.outcome as PlacementOutcome,
    jobItemId: (r.job_item_id as string) ?? null,
    itemId: r.item_id as string,
    unitId: (r.unit_id as string) ?? null,
    itemName: r.item_name as string,
    assetCode: r.asset_code as string,
    unitCode: (r.unit_code as string) ?? null,
    code: (r.code as string) ?? null,
    expected: place(r.expected_location_id as string | null, tree),
    actual: place(r.actual_location_id as string | null, tree),
    shipmentCode: (r.shipment_code as string) ?? null,
    otherJob: r.other_job_id ? { id: r.other_job_id as string, code: r.other_job_code as string } : null,
    deviceId: (r.device_id as string) ?? null,
    deviceName: (r.device_name as string) ?? null,
    via: r.via as string,
    actor: (r.actor as string) ?? null,
    note: (r.note as string) ?? null,
  }));
}
