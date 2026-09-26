import { pool } from "../../db/client";
import { badRequest, notFound } from "../../lib/errors";
import { loadPlaces } from "./gather";
import {
  NO_STOP,
  capacityOf,
  measureLine,
  planLoad,
  shipmentLoad,
  type Capacity,
  type LoadPlan,
  type PlanLineInput,
  type PlanVehicleInput,
  type VehicleProfile,
} from "./load";
import type { PlaceIndex } from "./places";
import { getSettings } from "./settings";

/** Reads a job's manifest, shipments and vehicles for the load planner. Nothing here writes. */

/** Shipments that can still take a load. */
const LOADABLE = ["planned", "staged", "loaded"];
const OPEN = ["planned", "staged", "loaded", "in_transit"];

const num = (v: unknown): number | null => (v == null ? null : Number(v));

const profileOf = (r: Record<string, unknown>): VehicleProfile | null =>
  r.has_profile
    ? {
        maxKg: num(r.max_kg),
        maxM3: num(r.max_m3),
        interiorLengthM: num(r.interior_length_m),
        interiorWidthM: num(r.interior_width_m),
        interiorHeightM: num(r.interior_height_m),
      }
    : null;

/** "5" reads as "Floor 5"; "Level 5" is left alone. The printed manifest uses the same rule. */
const floorLabel = (f: string) => (/^(floor|level|lvl|fl)\b/i.test(f) ? f : `Floor ${f}`);

function stopOf(
  r: { destination_location_id: string | null; destination_label: string | null; floor: string | null },
  jobDestination: string | null,
  places: PlaceIndex,
): { key: string; label: string } {
  const loc = r.destination_location_id ?? null;
  if (loc) return { key: `loc:${loc}`, label: places.path(loc) ?? "Destination" };
  const text = r.destination_label?.trim();
  if (text) return { key: `label:${text.toLowerCase()}`, label: text };
  const floor = r.floor?.trim();
  if (floor) return { key: `floor:${floor.toLowerCase()}`, label: floorLabel(floor) };
  if (jobDestination) return { key: `loc:${jobDestination}`, label: places.path(jobDestination) ?? "Destination" };
  return { key: NO_STOP, label: "No destination" };
}

async function jobLines(jobId: string, jobDestination: string | null, places: PlaceIndex): Promise<PlanLineInput[]> {
  const settings = await getSettings();
  const { rows } = await pool.query(
    `SELECT ji.id, ji.item_id, ji.unit_id, ji.stage, ji.shipment_id,
            ji.destination_location_id, ji.destination_label, ji.floor,
            i.name, coalesce(u.asset_code, i.asset_code) AS code, i.category, i.quantity, i.metadata
       FROM job_items ji
       JOIN items i ON i.id = ji.item_id
       LEFT JOIN item_units u ON u.id = ji.unit_id
      WHERE ji.job_id = $1
      ORDER BY ji.created_at, ji.id`,
    [jobId],
  );
  return rows.map((r) => {
    const stop = stopOf(r, jobDestination, places);
    return {
      jobItemId: r.id,
      itemId: r.item_id,
      unitId: r.unit_id ?? null,
      name: r.name,
      code: r.code ?? null,
      stage: r.stage,
      shipmentId: r.shipment_id ?? null,
      stopKey: stop.key,
      stopLabel: stop.label,
      measure: measureLine(
        { metadata: r.metadata, category: r.category, quantity: r.quantity, wholeItem: r.unit_id == null },
        settings.load,
      ),
    };
  });
}

export type JobLoadPlan = {
  job: { id: string; code: string; name: string; status: string };
  plan: LoadPlan;
  generatedAt: string;
};

export async function jobLoadPlan(
  jobId: string,
  opts: { stops?: string[]; vehicleLocationIds?: string[]; repack?: boolean } = {},
): Promise<JobLoadPlan> {
  const settings = await getSettings();
  const { rows: jobRows } = await pool.query(
    "SELECT id, code, name, status, destination_location_id FROM jobs WHERE id = $1",
    [jobId],
  );
  const job = jobRows[0];
  if (!job) throw notFound("That job does not exist.");
  const { places } = await loadPlaces();

  const { rows: shipmentRows } = await pool.query(
    `SELECT s.id, s.code, s.name, s.vehicle_location_id, l.name AS vehicle_name,
            (p.location_id IS NOT NULL) AS has_profile,
            p.max_kg, p.max_m3, p.interior_length_m, p.interior_width_m, p.interior_height_m
       FROM shipments s
       LEFT JOIN locations l ON l.id = s.vehicle_location_id
       LEFT JOIN ops_location_profiles p ON p.location_id = s.vehicle_location_id
      WHERE s.job_id = $1 AND s.status = ANY($2::text[])
      ORDER BY s.created_at, s.code`,
    [jobId, LOADABLE],
  );
  const vehicles: PlanVehicleInput[] = shipmentRows.map((r) => ({
    key: r.id,
    shipmentId: r.id,
    shipmentCode: r.code,
    name: r.name,
    vehicleLocationId: r.vehicle_location_id ?? null,
    vehicleName: r.vehicle_name ?? null,
    capacity: capacityOf(profileOf(r), settings.load.fillFactor),
  }));

  // Vehicles picked for a what-if plan, with no shipment yet.
  const extra = [...new Set(opts.vehicleLocationIds ?? [])];
  if (extra.length) {
    const { rows } = await pool.query(
      `SELECT l.id, l.name, (p.location_id IS NOT NULL) AS has_profile,
              p.max_kg, p.max_m3, p.interior_length_m, p.interior_width_m, p.interior_height_m
         FROM locations l LEFT JOIN ops_location_profiles p ON p.location_id = l.id
        WHERE l.id = ANY($1::uuid[])`,
      [extra],
    );
    const found = new Map(rows.map((r) => [r.id as string, r]));
    const missing = extra.filter((id) => !found.has(id));
    if (missing.length) throw badRequest(`No such vehicle: ${missing.join(", ")}. Pick one that exists.`);
    for (const id of extra) {
      const r = found.get(id)!;
      vehicles.push({
        key: `loc:${id}`,
        shipmentId: null,
        shipmentCode: null,
        name: r.name,
        vehicleLocationId: id,
        vehicleName: r.name,
        capacity: capacityOf(profileOf(r), settings.load.fillFactor),
      });
    }
  }

  const lines = await jobLines(jobId, job.destination_location_id ?? null, places);
  const plan = planLoad({
    lines,
    vehicles,
    stopOrder: opts.stops,
    repack: opts.repack,
    fillFactor: settings.load.fillFactor,
  });
  return {
    job: { id: job.id, code: job.code, name: job.name, status: job.status },
    plan,
    generatedAt: new Date().toISOString(),
  };
}

export type ShipmentCapacity = {
  shipmentId: string;
  code: string;
  name: string;
  status: string;
  jobId: string;
  jobCode: string;
  vehicleLocationId: string | null;
  vehicleName: string | null;
  capacity: Capacity | null;
  /** What the shipment itself says it weighs and holds, when someone entered it. */
  declared: { weightKg: number | null; volumeM3: number | null };
} & ReturnType<typeof shipmentLoad>;

/** Every open shipment's estimated load against its vehicle, for one job or all of them. */
export async function shipmentCapacities(jobId?: string): Promise<ShipmentCapacity[]> {
  const settings = await getSettings();
  const { rows: shipments } = await pool.query(
    `SELECT s.id, s.code, s.name, s.status, s.job_id, j.code AS job_code, s.vehicle_location_id,
            l.name AS vehicle_name, s.weight_kg, s.volume_m3,
            (p.location_id IS NOT NULL) AS has_profile,
            p.max_kg, p.max_m3, p.interior_length_m, p.interior_width_m, p.interior_height_m
       FROM shipments s
       JOIN jobs j ON j.id = s.job_id
       LEFT JOIN locations l ON l.id = s.vehicle_location_id
       LEFT JOIN ops_location_profiles p ON p.location_id = s.vehicle_location_id
      WHERE s.status = ANY($1::text[]) AND ($2::uuid IS NULL OR s.job_id = $2::uuid)
      ORDER BY s.created_at DESC
      LIMIT 500`,
    [OPEN, jobId ?? null],
  );
  if (!shipments.length) return [];
  const { rows: lines } = await pool.query(
    `SELECT ji.shipment_id, ji.stage, ji.unit_id, i.category, i.quantity, i.metadata
       FROM job_items ji JOIN items i ON i.id = ji.item_id
      WHERE ji.shipment_id = ANY($1::uuid[])`,
    [shipments.map((s) => s.id)],
  );
  const byShipment = new Map<string, { stage: string; measure: ReturnType<typeof measureLine> }[]>();
  for (const r of lines) {
    const list = byShipment.get(r.shipment_id) ?? [];
    list.push({
      stage: r.stage,
      measure: measureLine(
        { metadata: r.metadata, category: r.category, quantity: r.quantity, wholeItem: r.unit_id == null },
        settings.load,
      ),
    });
    byShipment.set(r.shipment_id, list);
  }
  return shipments.map((s) => {
    const capacity = capacityOf(profileOf(s), settings.load.fillFactor);
    return {
      shipmentId: s.id,
      code: s.code,
      name: s.name,
      status: s.status,
      jobId: s.job_id,
      jobCode: s.job_code,
      vehicleLocationId: s.vehicle_location_id ?? null,
      vehicleName: s.vehicle_name ?? null,
      capacity,
      declared: { weightKg: num(s.weight_kg), volumeM3: num(s.volume_m3) },
      ...shipmentLoad(byShipment.get(s.id) ?? [], capacity),
    };
  });
}
