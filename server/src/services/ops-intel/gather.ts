import { pool } from "../../db/client";
import { logger } from "../../lib/logger";
import type { OpsSettings } from "./model";
import { PlaceIndex, type Coords, type Place } from "./places";
import {
  isPlaceholderIdentity,
  type IdentityFact,
  type PositionFact,
  type RecordFact,
  type ShipmentLineFact,
  type StageLineFact,
  type TransitionFact,
} from "./rules";

/**
 * Reads the facts each rule needs, with plain SQL over the tracking and jobs
 * tables. Nothing here writes. Where a query narrows its rows it only ever
 * returns a superset of what the rule in rules.ts will keep, so the rule stays
 * the one statement of the logic; the database test checks the two together.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const date = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const dateOrNull = (v: unknown): Date | null => (v == null ? null : date(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Every location, with the coordinates and dock distances set on profiles. */
export async function loadPlaces(): Promise<{ places: PlaceIndex; distances: Map<string, number> }> {
  const { rows } = await pool.query<{
    id: string;
    parent_id: string | null;
    name: string;
    lat: number | null;
    lng: number | null;
    distance_to_dock_m: number | null;
  }>(
    `SELECT l.id, l.parent_id, l.name, p.lat, p.lng, p.distance_to_dock_m
       FROM locations l LEFT JOIN ops_location_profiles p ON p.location_id = l.id`,
  );
  const places: Place[] = rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name }));
  const coords: [string, Coords][] = rows
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => [r.id, { lat: Number(r.lat), lng: Number(r.lng) }]);
  const distances = new Map(
    rows.filter((r) => r.distance_to_dock_m != null).map((r) => [r.id, Number(r.distance_to_dock_m)]),
  );
  return { places: new PlaceIndex(places, coords), distances };
}

/**
 * Where an item in a container is: the first location up its chain of
 * containers. Items with a location of their own are not looked up.
 */
export async function containerLocations(itemIds: string[]): Promise<Map<string, string>> {
  if (!itemIds.length) return new Map();
  const { rows } = await pool.query<{ origin: string; loc: string }>(
    `WITH RECURSIVE chain AS (
       SELECT i.id AS origin, i.parent_item_id AS next, i.location_id AS loc, 0 AS depth
         FROM items i WHERE i.id = ANY($1::uuid[])
       UNION ALL
       SELECT c.origin, p.parent_item_id, p.location_id, c.depth + 1
         FROM chain c JOIN items p ON p.id = c.next
        WHERE c.loc IS NULL AND c.depth < 16
     )
     SELECT DISTINCT ON (origin) origin, loc FROM chain WHERE loc IS NOT NULL ORDER BY origin, depth`,
    [itemIds],
  );
  return new Map(rows.map((r) => [r.origin, r.loc]));
}

/** Manifest lines at packed, loaded or delivered that could break a stage rule. */
export async function gatherStageLines(now: Date, settings: OpsSettings): Promise<StageLineFact[]> {
  const jobsSince = new Date(now.getTime() - settings.jobLookbackDays * DAY);
  const deliveredBefore = new Date(now.getTime() - settings.rules.delivered_not_placed.hours * HOUR);
  const { rows } = await pool.query(
    `WITH lines AS (
       SELECT ji.id, ji.job_id, ji.shipment_id, ji.stage, ji.stage_at, ji.item_id, ji.unit_id
         FROM job_items ji JOIN jobs j ON j.id = ji.job_id
        WHERE ji.stage IN ('packed', 'loaded', 'delivered')
          AND (j.status IN ('planned', 'in_progress') OR (j.status = 'completed' AND j.completed_at >= $1))
     ),
     job_facts AS (
       SELECT j.id,
              (SELECT count(*) FROM shipments s WHERE s.job_id = j.id)::int AS shipment_count,
              (SELECT count(*) FROM shipments s
                WHERE s.job_id = j.id AND s.status IN ('in_transit', 'delivered', 'closed'))::int AS shipments_left,
              (EXISTS (SELECT 1 FROM job_tasks t WHERE t.job_id = j.id AND t.kind = 'place')
                OR EXISTS (SELECT 1 FROM job_items x WHERE x.job_id = j.id AND x.stage = 'placed')) AS uses_placement
         FROM jobs j WHERE j.id IN (SELECT DISTINCT job_id FROM lines)
     )
     SELECT l.id, l.job_id, l.shipment_id, l.stage, l.stage_at, l.item_id, l.unit_id,
            j.code AS job_code, j.name AS job_name,
            jf.shipment_count, jf.shipments_left, jf.uses_placement,
            s.code AS shipment_code, s.status AS shipment_status, s.arrived_at,
            i.name AS item_name, coalesce(u.asset_code, i.asset_code) AS code
       FROM lines l
       JOIN jobs j ON j.id = l.job_id
       JOIN job_facts jf ON jf.id = l.job_id
       JOIN items i ON i.id = l.item_id
       LEFT JOIN item_units u ON u.id = l.unit_id
       LEFT JOIN shipments s ON s.id = l.shipment_id
      WHERE (l.stage = 'packed'
              AND (s.status IN ('loaded', 'in_transit', 'delivered', 'closed')
                   OR (l.shipment_id IS NULL AND jf.shipment_count > 0 AND jf.shipments_left >= jf.shipment_count)))
         OR (l.stage = 'loaded' AND s.status IN ('delivered', 'closed'))
         OR (l.stage = 'delivered' AND jf.uses_placement AND l.stage_at < $2)`,
    [jobsSince, deliveredBefore],
  );
  return rows.map((r) => ({
    jobItemId: r.id,
    jobId: r.job_id,
    jobCode: r.job_code,
    jobName: r.job_name,
    jobUsesPlacement: Boolean(r.uses_placement),
    jobShipmentCount: Number(r.shipment_count),
    jobShipmentsLeft: Number(r.shipments_left),
    shipmentId: str(r.shipment_id),
    shipmentCode: str(r.shipment_code),
    shipmentStatus: str(r.shipment_status),
    shipmentArrivedAt: dateOrNull(r.arrived_at),
    stage: r.stage,
    stageAt: date(r.stage_at),
    itemId: r.item_id,
    unitId: str(r.unit_id),
    name: r.item_name,
    code: str(r.code),
  }));
}

/** Lines on open shipments of open jobs, for assets that are on more than one shipment. */
export async function gatherShipmentLines(): Promise<ShipmentLineFact[]> {
  const { rows } = await pool.query(
    `WITH open_lines AS (
       SELECT ji.id, ji.job_id, ji.shipment_id, ji.item_id, ji.unit_id
         FROM job_items ji
         JOIN shipments s ON s.id = ji.shipment_id
         JOIN jobs j ON j.id = ji.job_id
        WHERE s.status IN ('planned', 'staged', 'loaded', 'in_transit')
          AND j.status IN ('planned', 'in_progress')
     ),
     multi AS (
       SELECT item_id FROM open_lines GROUP BY item_id HAVING count(DISTINCT shipment_id) > 1
     )
     SELECT ol.id, ol.job_id, ol.shipment_id, ol.item_id, ol.unit_id,
            j.code AS job_code, s.code AS shipment_code, s.status AS shipment_status,
            i.name AS item_name, coalesce(u.asset_code, i.asset_code) AS code
       FROM open_lines ol
       JOIN multi m ON m.item_id = ol.item_id
       JOIN jobs j ON j.id = ol.job_id
       JOIN shipments s ON s.id = ol.shipment_id
       JOIN items i ON i.id = ol.item_id
       LEFT JOIN item_units u ON u.id = ol.unit_id`,
  );
  return rows.map((r) => ({
    jobItemId: r.id,
    jobId: r.job_id,
    jobCode: r.job_code,
    shipmentId: r.shipment_id,
    shipmentCode: r.shipment_code,
    shipmentStatus: r.shipment_status,
    itemId: r.item_id,
    unitId: str(r.unit_id),
    name: r.item_name,
    code: str(r.code),
  }));
}

/** Identifiers whose normalized form is shared by more than one record. */
export async function gatherIdentities(placeholders: string[]): Promise<IdentityFact[]> {
  const { rows } = await pool.query(
    `WITH ids AS (
       SELECT ii.item_id, NULL::uuid AS unit_id, ii.type, ii.value
         FROM item_identifiers ii WHERE ii.type IN ('serial', 'asset_tag', 'mac', 'rfid')
       UNION ALL
       SELECT u.item_id, u.id, 'unit_serial', u.serial
         FROM item_units u WHERE u.serial IS NOT NULL AND btrim(u.serial) <> ''
     ),
     keyed AS (
       SELECT ids.*, CASE WHEN type = 'unit_serial' THEN 'serial' ELSE type END AS cls,
              ops_identity_key(value) AS k
         FROM ids
     ),
     dup AS (
       SELECT cls, k FROM keyed
        WHERE length(k) >= 3 AND NOT (k = ANY($1::text[])) AND k !~ '^(.)\\1*$'
        GROUP BY cls, k
       HAVING count(DISTINCT item_id) > 1 OR count(DISTINCT unit_id) > 1
     )
     SELECT keyed.item_id, keyed.unit_id, keyed.type, keyed.value,
            i.name AS item_name, coalesce(u.asset_code, i.asset_code) AS code
       FROM keyed
       JOIN dup ON dup.cls = keyed.cls AND dup.k = keyed.k
       JOIN items i ON i.id = keyed.item_id
       LEFT JOIN item_units u ON u.id = keyed.unit_id`,
    [placeholders],
  );
  return rows
    .map((r) => ({
      itemId: r.item_id,
      unitId: str(r.unit_id),
      type: r.type,
      value: r.value,
      name: r.item_name,
      code: str(r.code),
    }))
    .filter((f) => !isPlaceholderIdentity(f.value.replace(/[^0-9A-Za-z]/g, "").toUpperCase()));
}

/**
 * Records sharing a place, a name and a model. The grouping here is looser
 * than the rule's (it drops every non-alphanumeric character), so it can only
 * return more candidates, never fewer.
 */
export async function gatherRecords(): Promise<RecordFact[]> {
  const { rows } = await pool.query(
    `WITH cand AS (
       SELECT i.id, i.name, i.brand, i.model, i.location_id, i.asset_code,
              lower(regexp_replace(i.name, '[^[:alnum:]]+', '', 'g')) AS n,
              lower(regexp_replace(coalesce(i.brand, ''), '[^[:alnum:]]+', '', 'g')) AS b,
              lower(regexp_replace(i.model, '[^[:alnum:]]+', '', 'g')) AS m
         FROM items i
        WHERE i.location_id IS NOT NULL
          AND i.model IS NOT NULL AND btrim(i.model) <> ''
          AND i.category IS DISTINCT FROM 'Domain'
     ),
     groups AS (
       SELECT location_id, n, b, m FROM cand GROUP BY 1, 2, 3, 4 HAVING count(*) > 1
     )
     SELECT c.id, c.name, c.brand, c.model, c.location_id, c.asset_code,
            coalesce((SELECT array_agg(ii.value) FROM item_identifiers ii
                       WHERE ii.item_id = c.id AND ii.type = 'serial'), '{}')
            || coalesce((SELECT array_agg(u.serial) FROM item_units u
                          WHERE u.item_id = c.id AND u.serial IS NOT NULL), '{}') AS serials
       FROM cand c
       JOIN groups g ON g.location_id = c.location_id AND g.n = c.n AND g.b = c.b AND g.m = c.m`,
  );
  return rows.map((r) => ({
    itemId: r.id,
    name: r.name,
    brand: str(r.brand),
    model: str(r.model),
    locationId: r.location_id,
    code: str(r.asset_code),
    serials: (r.serials as string[] | null) ?? [],
  }));
}

// A day of a busy portal can hold millions of reads; the transitions are far
// fewer. Past this many the oldest are skipped and the run says so in the log.
const MAX_TRANSITIONS = 50_000;

/**
 * Consecutive reads of each asset that changed zone, or that moved fast
 * enough between two coordinates to be worth the rule's look.
 */
export async function gatherTransitions(now: Date, settings: OpsSettings): Promise<TransitionFact[]> {
  const { lookbackHours, minDistanceM, maxSpeedKmh } = settings.rules.impossible_travel;
  const since = new Date(now.getTime() - lookbackHours * HOUR);
  const { rows } = await pool.query(
    `WITH s AS (
       SELECT id, item_id, unit_id, location_id, lat, lng, accuracy_m, observed_at,
              lag(id) OVER w AS p_id, lag(location_id) OVER w AS p_loc,
              lag(lat) OVER w AS p_lat, lag(lng) OVER w AS p_lng,
              lag(accuracy_m) OVER w AS p_acc, lag(observed_at) OVER w AS p_at
         FROM sightings
        WHERE observed_at >= $1 AND observed_at <= $4 AND item_id IS NOT NULL
          AND (location_id IS NOT NULL OR lat IS NOT NULL)
       WINDOW w AS (PARTITION BY item_id, unit_id ORDER BY observed_at, id)
     ),
     pairs AS (
       SELECT s.*,
              CASE WHEN s.lat IS NOT NULL AND s.p_lat IS NOT NULL
                   THEN ops_haversine_m(s.p_lat, s.p_lng, s.lat, s.lng)
                        - coalesce(s.accuracy_m, 0) - coalesce(s.p_acc, 0)
              END AS gps_m
         FROM s WHERE s.p_id IS NOT NULL
     )
     SELECT p.*, i.name AS item_name, coalesce(u.asset_code, i.asset_code) AS code
       FROM pairs p
       JOIN items i ON i.id = p.item_id
       LEFT JOIN item_units u ON u.id = p.unit_id
      WHERE p.location_id IS DISTINCT FROM p.p_loc
         OR (p.gps_m >= $2
             AND p.gps_m / greatest(1, extract(epoch FROM p.observed_at - p.p_at)) * 3.6 > $3)
      ORDER BY p.observed_at DESC
      LIMIT ${MAX_TRANSITIONS + 1}`,
    [since, minDistanceM, maxSpeedKmh, now],
  );
  if (rows.length > MAX_TRANSITIONS) {
    logger.warn("ops.gather.transitions_capped", { kept: MAX_TRANSITIONS, lookbackHours });
    rows.length = MAX_TRANSITIONS;
  }
  return rows.map((r) => ({
    itemId: r.item_id,
    unitId: str(r.unit_id),
    name: r.item_name,
    code: str(r.code),
    from: {
      sightingId: Number(r.p_id),
      at: date(r.p_at),
      locationId: str(r.p_loc),
      lat: num(r.p_lat),
      lng: num(r.p_lng),
      accuracyM: num(r.p_acc),
    },
    to: {
      sightingId: Number(r.id),
      at: date(r.observed_at),
      locationId: str(r.location_id),
      lat: num(r.lat),
      lng: num(r.lng),
      accuracyM: num(r.accuracy_m),
    },
  }));
}

/**
 * Latest positions that are either quiet for longer than the not-seen
 * threshold or in a zone other than the recorded place, with what the rules
 * need to know about the record.
 */
export async function gatherPositions(now: Date, settings: OpsSettings): Promise<PositionFact[]> {
  const quietBefore = new Date(now.getTime() - settings.rules.not_seen.days * DAY);
  const { rows } = await pool.query(
    `WITH p AS (
       SELECT p.item_id, p.unit_id, p.location_id, p.entered_at, p.observed_at,
              i.name AS item_name, coalesce(u.asset_code, i.asset_code) AS code,
              i.parent_item_id,
              CASE WHEN p.unit_id IS NULL THEN i.location_id ELSE coalesce(u.location_id, i.location_id) END AS recorded,
              CASE WHEN p.unit_id IS NULL THEN i.updated_at
                   WHEN u.location_id IS NULL THEN greatest(i.updated_at, u.updated_at)
                   ELSE u.updated_at END AS changed_at,
              (i.status = 'active' AND (p.unit_id IS NULL OR u.status = 'active')) AS active,
              EXISTS (SELECT 1 FROM item_assignments a
                       WHERE a.item_id = p.item_id AND a.checked_in_at IS NULL
                         AND (a.unit_id IS NULL OR a.unit_id = p.unit_id)) AS checked_out
         FROM asset_positions p
         JOIN items i ON i.id = p.item_id
         LEFT JOIN item_units u ON u.id = p.unit_id
     )
     SELECT * FROM p
      WHERE p.observed_at < $1
         OR (p.location_id IS NOT NULL AND p.location_id IS DISTINCT FROM p.recorded)`,
    [quietBefore],
  );
  // An item packed in a container is where its container is.
  const inContainers = rows.filter((r) => r.recorded == null && r.parent_item_id != null).map((r) => r.item_id as string);
  const containerLoc = await containerLocations([...new Set(inContainers)]);
  return rows.map((r) => ({
    itemId: r.item_id,
    unitId: str(r.unit_id),
    name: r.item_name,
    code: str(r.code),
    zoneId: str(r.location_id),
    enteredAt: dateOrNull(r.entered_at),
    observedAt: date(r.observed_at),
    recordedLocationId: str(r.recorded) ?? containerLoc.get(r.item_id) ?? null,
    recordChangedAt: dateOrNull(r.changed_at),
    active: Boolean(r.active),
    checkedOut: Boolean(r.checked_out),
  }));
}
