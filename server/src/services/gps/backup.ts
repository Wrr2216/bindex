import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { geofences, gpsTrackerLinks, gpsTrackers } from "../../db/schema";
import type { Executor } from "../jobs-core/shared";

/**
 * GPS in the instance backup. services/backup.ts lists the tables and calls
 * these, as it does for jobs.
 *
 * - Geofences are configuration and go in whole.
 * - Tracker links are assignments (which tracker went with which shipment).
 * - Trackers go in as their lifecycle only (available, awaiting return,
 *   disposed); the jump filter's memory rebuilds from the next fixes.
 *
 * Fence states and crossings are history, like sightings, and stay out.
 */

export const GPS_TABLES = ["geofences", "gps_trackers", "gps_tracker_links"] as const;
export type GpsTable = (typeof GPS_TABLES)[number];

export async function exportGpsTables(): Promise<Record<GpsTable, Record<string, unknown>[]>> {
  const [fences, trackers, links] = await Promise.all([
    db.select().from(geofences),
    db
      .select({ deviceId: gpsTrackers.deviceId, status: gpsTrackers.status, statusAt: gpsTrackers.statusAt })
      .from(gpsTrackers),
    db.select().from(gpsTrackerLinks),
  ]);
  return { geofences: fences, gps_trackers: trackers, gps_tracker_links: links };
}

/**
 * Before a restore replaces locations and devices: park the current fences
 * (a file from before GPS keeps them), then clear.
 */
export async function clearGpsTables(tx: Executor): Promise<void> {
  await tx.execute(sql`CREATE TEMP TABLE backup_kept_geofences ON COMMIT DROP AS SELECT * FROM geofences`);
  await tx.delete(gpsTrackerLinks);
  await tx.delete(gpsTrackers);
  await tx.delete(geofences);
}

/** After locations, devices and shipments are back. */
export async function restoreGpsTables(tx: Executor, data: Record<GpsTable, Record<string, unknown>[]>): Promise<void> {
  if (data.geofences.length) {
    for (let i = 0; i < data.geofences.length; i += 500) {
      await tx.insert(geofences).values(data.geofences.slice(i, i + 500) as never);
    }
  } else {
    // A file written before GPS: keep the fences, minus links to places it no
    // longer has. They count as new shapes, so no tracker fires on them.
    await tx.execute(sql`
      UPDATE backup_kept_geofences k SET location_id = NULL
       WHERE location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = k.location_id)`);
    await tx.execute(sql`UPDATE backup_kept_geofences SET geometry_at = now()`);
    await tx.execute(sql`INSERT INTO geofences SELECT * FROM backup_kept_geofences`);
  }
  // Devices restored from the file keep their ids. Rows pointing at anything
  // the file does not have are dropped rather than failing the restore.
  const trackers = data.gps_trackers;
  for (let i = 0; i < trackers.length; i += 500) {
    await tx.execute(sql`
      INSERT INTO gps_trackers (device_id, status, status_at)
      SELECT t."deviceId", t.status, COALESCE(t."statusAt", now())
        FROM jsonb_to_recordset(${JSON.stringify(trackers.slice(i, i + 500))}::jsonb)
          AS t("deviceId" uuid, status text, "statusAt" timestamptz)
       WHERE t.status IN ('available', 'assigned', 'awaiting_return', 'disposed')
         AND EXISTS (SELECT 1 FROM tracking_devices d WHERE d.id = t."deviceId")
      ON CONFLICT (device_id) DO NOTHING`);
  }
  const links = data.gps_tracker_links;
  for (let i = 0; i < links.length; i += 500) {
    await tx.execute(sql`
      INSERT INTO gps_tracker_links (id, device_id, shipment_id, vehicle_location_id, origin_geofence_id,
                                     destination_geofence_id, assigned_at, assigned_by, ended_at, end_reason, ended_by)
      SELECT l.id, l."deviceId", l."shipmentId", l."vehicleLocationId",
             (SELECT g.id FROM geofences g WHERE g.id = l."originGeofenceId"),
             (SELECT g.id FROM geofences g WHERE g.id = l."destinationGeofenceId"),
             COALESCE(l."assignedAt", now()), l."assignedBy", l."endedAt", l."endReason", l."endedBy"
        FROM jsonb_to_recordset(${JSON.stringify(links.slice(i, i + 500))}::jsonb)
          AS l(id uuid, "deviceId" uuid, "shipmentId" uuid, "vehicleLocationId" uuid, "originGeofenceId" uuid,
               "destinationGeofenceId" uuid, "assignedAt" timestamptz, "assignedBy" text, "endedAt" timestamptz,
               "endReason" text, "endedBy" text)
       WHERE EXISTS (SELECT 1 FROM tracking_devices d WHERE d.id = l."deviceId")
         AND (l."shipmentId" IS NULL) <> (l."vehicleLocationId" IS NULL)
         AND (l."shipmentId" IS NULL OR EXISTS (SELECT 1 FROM shipments s WHERE s.id = l."shipmentId"))
         AND (l."vehicleLocationId" IS NULL OR EXISTS (SELECT 1 FROM locations x WHERE x.id = l."vehicleLocationId"))
      ON CONFLICT DO NOTHING`);
  }
}
