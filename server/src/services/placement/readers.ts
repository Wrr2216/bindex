import { pool } from "../../db/client";
import { env } from "../../env";
import { describeError, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { setLineStage } from "../jobs-core";
import { listDevices, readSettings, type SightingTech } from "../tracking";
import { jobAreas, linesForItems, loadTree, place, type Place } from "./data";
import { planReaderReads, type ReaderRead } from "./match";
import { MISPLACED, VIA } from "./model";
import { recordObservations, type NewObservation } from "./observations";

/**
 * Room confirmation from readers. A fixed or handheld reader whose zone is a
 * room (a tracking-core device with that room as its location, or an antenna
 * mapped to it) reads a tag; if the room is the line's destination the line is
 * placed, and if it is another room this job delivers to, the line is
 * misplaced and the room noted.
 *
 * The tracking core has no listener hook and should not need one: sightings
 * are an append-only table with an increasing id, so a worker reads what
 * arrived since last time, a couple of seconds behind. That keeps reader
 * ingest as fast as it is, and a placement failure can never lose a read.
 *
 * Bluetooth: room presence decided by the BLE feature arrives as sightings
 * with tech "ble" and a zone, and is used the same way, but only when that
 * feature is installed. Without it, a BLE read's zone is just the gateway
 * that heard it, which is not a room verdict (see bleAvailable).
 */

const CURSOR = "sightings";
// One worker at a time across replicas. Any constant works; this one spells "plac".
const LOCK_KEY = 0x706c6163;
const BATCH = 5000;
const SETTLE_SECONDS = 2;
const STALE_MINUTES = 30;

type SightingRow = {
  id: string;
  device_id: string | null;
  device_name: string | null;
  item_id: string;
  unit_id: string | null;
  location_id: string;
  tech: SightingTech;
  observed_at: Date;
  placement: { confirm?: unknown; nested?: unknown } | null;
};

export type ReaderRun = {
  /** Room reads considered. */
  reads: number;
  placed: number;
  misplaced: number;
  cursor: number;
  /** The batch was full: there is more to read. */
  more: boolean;
};

// --- Bluetooth ---------------------------------------------------------------------

let bleCache: { at: number; value: Promise<boolean> } | null = null;

/**
 * Whether BLE room presence is installed: its migration (0030) has run, and
 * its switch is not explicitly off. Checked at runtime so this feature ships
 * without it and picks it up when it lands.
 */
export function bleAvailable(): Promise<boolean> {
  const now = Date.now();
  if (!bleCache || now - bleCache.at > 60_000) {
    const value = pool
      .query<{ installed: boolean; switch: string | null }>(
        `SELECT EXISTS (SELECT 1 FROM _migrations WHERE name LIKE '0030\\_%') AS installed,
                (SELECT value FROM app_settings WHERE key = 'features.ble') AS switch`,
      )
      .then(({ rows }) => Boolean(rows[0]?.installed) && rows[0]?.switch !== "false")
      .catch(() => false);
    bleCache = { at: now, value };
  }
  return bleCache.value;
}

export function forgetBle(): void {
  bleCache = null;
}

// --- The worker --------------------------------------------------------------------------

type Read = ReaderRead & { deviceName: string | null; tech: SightingTech };

/** Apply a batch of room reads to the jobs in progress. Exported for tests. */
export async function applyReads(reads: Read[]): Promise<{ placed: number; misplaced: number }> {
  const out = { placed: 0, misplaced: 0 };
  if (!reads.length) return out;
  // Readers only act on jobs under way: a planned job has not started, and a
  // finished one is history.
  const lines = await linesForItems([...new Set(reads.map((r) => r.itemId))], ["in_progress"]);
  if (!lines.length) return out;
  const [tree, areas] = await Promise.all([loadTree(), jobAreas([...new Set(lines.map((l) => l.jobId))])]);
  const decisions = planReaderReads(reads, lines, tree, areas);

  const groups = new Map<string, { jobId: string; outcome: "placed" | "misplaced"; read: Read; lines: typeof lines }>();
  for (const d of decisions) {
    const via = d.read.tech === "ble" ? VIA.ble : VIA.reader;
    const key = [d.line.jobId, d.outcome, d.read.deviceId ?? "", d.read.zoneId, via].join("|");
    const g = groups.get(key) ?? { jobId: d.line.jobId, outcome: d.outcome, read: d.read, lines: [] };
    g.lines.push(d.line);
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    const room: Place | null = place(g.read.zoneId, tree);
    const where = room ? room.path.join(" / ") : "an unknown room";
    const via = g.read.tech === "ble" ? VIA.ble : VIA.reader;
    const note = `Read by ${g.read.deviceName ?? "a reader"} in ${where}`;
    try {
      const result = await setLineStage(
        g.jobId,
        g.lines.map((l) => l.id),
        g.outcome === "placed" ? "placed" : MISPLACED,
        { via, deviceId: g.read.deviceId, actor: g.read.deviceName, note },
      );
      // A misplaced line already flagged elsewhere stays misplaced, but the
      // new room is worth noting; the planner already dropped repeats of the same room.
      const noted = g.outcome === "placed" ? result.advanced : [...result.advanced, ...result.alreadyAt];
      const rows: NewObservation[] = noted.map((o) => ({
        jobId: g.jobId,
        jobItemId: o.jobItemId,
        itemId: o.itemId,
        unitId: o.unitId,
        outcome: g.outcome,
        expectedLocationId: o.destinationLocationId,
        actualLocationId: g.read.zoneId,
        deviceId: g.read.deviceId,
        via,
        actor: g.read.deviceName,
        note,
      }));
      await recordObservations(rows);
      if (g.outcome === "placed") out.placed += result.advanced.length;
      else out.misplaced += noted.length;
    } catch (err) {
      // A job closed between the read and now, or a guard failed: skip this
      // group rather than hold up every other read behind it.
      logger.warn("placement.readers.group_failed", { jobId: g.jobId, err: describeError(err) });
    }
  }
  return out;
}

/**
 * Read the sightings that arrived since the last run and apply them. Returns
 * null when another replica holds the lock.
 */
export async function processNewSightings(
  opts: { limit?: number; settleSeconds?: number } = {},
): Promise<ReaderRun | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows: lock } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
    if (!lock[0]?.ok) return null;
    locked = true;

    const { rows: cursorRows } = await client.query<{ last_id: string }>(
      "SELECT last_id FROM placement_cursors WHERE name = $1",
      [CURSOR],
    );
    if (!cursorRows.length) {
      // The first run starts from now: reads from before placement was on are
      // history, not instructions.
      const { rows } = await client.query<{ id: string }>("SELECT COALESCE(max(id), 0) AS id FROM sightings");
      await client.query(
        "INSERT INTO placement_cursors (name, last_id) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
        [CURSOR, rows[0]!.id],
      );
      return { reads: 0, placed: 0, misplaced: 0, cursor: Number(rows[0]!.id), more: false };
    }
    const from = Number(cursorRows[0]!.last_id);
    const limit = opts.limit ?? BATCH;
    // Ids are handed out when a batch is inserted, not when it commits, so a
    // slow batch can land behind a quicker one. The run stops at the first
    // sighting that arrived less than a moment ago, which gives the batches
    // around it time to commit. Should one still slip past, the tag is read
    // again within the reader's duplicate window.
    const { rows: range } = await client.query<{ id: string; settled: boolean }>(
      `SELECT id, received_at <= now() - make_interval(secs => $3) AS settled
         FROM sightings WHERE id > $1 ORDER BY id LIMIT $2`,
      [from, limit, opts.settleSeconds ?? SETTLE_SECONDS],
    );
    const fresh = range.findIndex((r) => !r.settled);
    const settled = fresh < 0 ? range : range.slice(0, fresh);
    const to = settled.length ? Number(settled[settled.length - 1]!.id) : from;
    const more = fresh < 0 && range.length >= limit;
    if (to === from) return { reads: 0, placed: 0, misplaced: 0, cursor: from, more: false };

    // A read from long ago (a backlog posted after the switch was off for a
    // while, or a reader that was offline) says where something was, not
    // where it is: it is skipped rather than acted on.
    const { rows } = await client.query<SightingRow>(
      `SELECT s.id, s.device_id, d.name AS device_name, s.item_id, s.unit_id, s.location_id, s.tech,
              s.observed_at, d.settings -> 'placement' AS placement
         FROM sightings s
         LEFT JOIN tracking_devices d ON d.id = s.device_id
        WHERE s.id > $1 AND s.id <= $2 AND s.item_id IS NOT NULL AND s.location_id IS NOT NULL
          AND s.observed_at >= now() - make_interval(mins => $3)`,
      [from, to, STALE_MINUTES],
    );
    const ble = rows.some((r) => r.tech === "ble") ? await bleAvailable() : false;
    const reads: Read[] = rows
      .filter((r) => (r.tech !== "ble" || ble) && r.placement?.confirm !== false)
      .map((r) => ({
        deviceId: r.device_id,
        deviceName: r.device_name,
        itemId: r.item_id,
        unitId: r.unit_id,
        zoneId: r.location_id,
        observedAt: new Date(r.observed_at).getTime(),
        nested: r.placement?.nested === true,
        tech: r.tech,
      }));
    const applied = await applyReads(reads);
    await client.query("UPDATE placement_cursors SET last_id = $2, updated_at = now() WHERE name = $1", [CURSOR, to]);
    if (applied.placed || applied.misplaced) {
      logger.info("placement.readers.applied", { reads: reads.length, ...applied });
    }
    return { reads: reads.length, ...applied, cursor: to, more };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

let lastRun: (ReaderRun & { at: string }) | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { features } = await getConfig();
    if (!features.placement || !features.jobs || !features.tracking) return;
    // Catch up in batches after a pause, without starving the event loop.
    for (let i = 0; i < 20; i++) {
      const run = await processNewSightings();
      // Most runs find nothing new; the status shows the last one that did.
      if (run && (run.reads > 0 || !lastRun)) lastRun = { ...run, at: new Date().toISOString() };
      if (!run?.more) break;
    }
  } catch (err) {
    logger.warn("placement.readers.failed", { err: describeError(err) });
  } finally {
    running = false;
  }
}

/** Start the reader worker. Off when PLACEMENT_READER_POLL_SECONDS is 0. */
export function startPlacementReaders(): void {
  const seconds = env.PLACEMENT_READER_POLL_SECONDS;
  if (seconds <= 0) {
    logger.info("placement.readers.off", {});
    return;
  }
  setInterval(() => void tick(), Math.max(0.5, seconds) * 1000).unref();
  logger.info("placement.readers.started", { pollSeconds: seconds });
}

// --- Which readers confirm placement ---------------------------------------------------

export type PlacementReader = {
  id: string;
  name: string;
  kind: string;
  zone: Place | null;
  /** Antenna ports mapped to rooms of their own. */
  antennaZones: number;
  /** Reads by this device place and misplace lines. On unless switched off. */
  confirm: boolean;
  /** Places inside its zone (desks in the room) count as its zone. */
  nested: boolean;
  disabled: boolean;
  lastSeenAt: string | null;
};

export type ReadersStatus = {
  worker: { on: boolean; pollSeconds: number; lastRun: (ReaderRun & { at: string }) | null };
  ble: boolean;
  readers: PlacementReader[];
};

/** Devices that put reads in a zone, with their placement settings. */
export async function readersStatus(): Promise<ReadersStatus> {
  const [devices, tree, ble] = await Promise.all([listDevices(), loadTree(), bleAvailable()]);
  const readers: PlacementReader[] = [];
  for (const d of devices) {
    const settings = readSettings(d.settings);
    const zones = Object.keys(settings.antennaZones ?? {}).length;
    const zoneId = settings.portal?.inLocationId ?? d.locationId;
    if (!zoneId && !zones) continue;
    const p = (d.settings.placement ?? {}) as { confirm?: unknown; nested?: unknown };
    readers.push({
      id: d.id,
      name: d.name,
      kind: d.kind,
      zone: place(zoneId, tree),
      antennaZones: zones,
      confirm: p.confirm !== false,
      nested: p.nested === true,
      disabled: d.disabled,
      lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
    });
  }
  return {
    worker: { on: env.PLACEMENT_READER_POLL_SECONDS > 0, pollSeconds: env.PLACEMENT_READER_POLL_SECONDS, lastRun },
    ble,
    readers,
  };
}

/**
 * Change a device's placement settings. Merged into its settings in one
 * statement, so an edit to the device's other settings made at the same time
 * is not lost.
 */
export async function setReaderPlacement(deviceId: string, patch: { confirm?: boolean; nested?: boolean }): Promise<void> {
  const value: Record<string, boolean> = {};
  if (patch.confirm !== undefined) value.confirm = patch.confirm;
  if (patch.nested !== undefined) value.nested = patch.nested;
  const { rowCount } = await pool.query(
    `UPDATE tracking_devices
        SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{placement}',
                                 COALESCE(settings -> 'placement', '{}'::jsonb) || $2::jsonb),
            updated_at = now()
      WHERE id = $1`,
    [deviceId, JSON.stringify(value)],
  );
  if (!rowCount) throw notFound("Device not found");
  logger.info("placement.reader.updated", { deviceId, ...value });
}
