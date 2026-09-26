import { asc, eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { shipments } from "../../db/schema";
import { OPEN_JOB_STATUSES, setJobMetadata } from "../jobs-core";
import { floorColor, readFloorColors, type FloorColors } from "./colors";
import { jobLines, jobSettings, loadJob, loadTree, place, MAX_LINES, type LineView, type Place } from "./data";
import { MISPLACED } from "./model";
import { afterDeliveryReason, tally, tallyBy, tallyCounts, type AfterDeliveryReason, type Tally } from "./progress";
import { floorOf } from "./tree";

/** Jobs as the placement screens see them: how much is in its room, by floor and by room. */

export type PlacementJobSummary = {
  id: string;
  code: string;
  name: string;
  status: string;
  destination: Place | null;
  tally: Tally;
};

/** Open jobs, newest first, each with its placement tally. */
export async function listPlacementJobs(): Promise<PlacementJobSummary[]> {
  const tree = await loadTree();
  const { rows } = await pool.query<{
    id: string;
    code: string;
    name: string;
    status: string;
    destination_location_id: string | null;
    stage: string | null;
    n: number;
  }>(
    `SELECT j.id, j.code, j.name, j.status, j.destination_location_id, ji.stage, count(ji.id)::int AS n
       FROM jobs j LEFT JOIN job_items ji ON ji.job_id = j.id
      WHERE j.status = ANY($1::text[])
      GROUP BY j.id, ji.stage
      ORDER BY j.created_at DESC`,
    [[...OPEN_JOB_STATUSES]],
  );
  const jobs = new Map<string, { row: (typeof rows)[number]; counts: Record<string, number> }>();
  for (const r of rows) {
    const entry = jobs.get(r.id) ?? { row: r, counts: {} };
    if (r.stage) entry.counts[r.stage] = r.n;
    jobs.set(r.id, entry);
  }
  return [...jobs.values()].map(({ row, counts }) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    destination: place(row.destination_location_id, tree),
    tally: tallyCounts(counts),
  }));
}

export type FloorProgress = { floor: string | null; color: string; tally: Tally };
export type RoomProgress = { destination: Place | null; floor: string | null; color: string; tally: Tally };
export type AtRiskLine = LineView & { reason: AfterDeliveryReason };

export type JobProgress = {
  job: {
    id: string;
    code: string;
    name: string;
    status: string;
    origin: Place | null;
    destination: Place | null;
  };
  overall: Tally;
  byFloor: FloorProgress[];
  byRoom: RoomProgress[];
  /** Lines not placed yet, in crew order. */
  remaining: LineView[];
  /** Lines found in the wrong room, with the room. */
  misplaced: LineView[];
  /** Lines at risk once their shipment is delivered. */
  afterDelivery: AtRiskLine[];
  shipments: { id: string; code: string; name: string; status: string }[];
  /** Every floor on the job with its colour, and whether the job overrides it. */
  floors: { floor: string; color: string; custom: boolean }[];
  /** The manifest was larger than one read; the lists are cut short. */
  truncated: boolean;
};

export async function jobProgress(jobId: string): Promise<JobProgress> {
  const job = await loadJob(jobId);
  const tree = await loadTree();
  const { floorColors } = jobSettings(job);
  const [lines, jobShipments] = await Promise.all([
    jobLines(jobId, tree, floorColors),
    db
      .select({ id: shipments.id, code: shipments.code, name: shipments.name, status: shipments.status })
      .from(shipments)
      .where(eq(shipments.jobId, jobId))
      .orderBy(asc(shipments.createdAt)),
  ]);

  const byFloor = tallyBy(lines, (l) => l.floor).map((g) => ({
    floor: g.key,
    color: floorColor(g.key, floorColors),
    tally: g.tally,
  }));
  // Rooms sort by their path, so a floor's rooms sit together.
  const roomKey = (l: LineView) => (l.destination ? l.destination.path.join(" / ") : null);
  const sample = new Map<string | null, LineView>();
  for (const l of lines) if (!sample.has(roomKey(l))) sample.set(roomKey(l), l);
  const byRoom = tallyBy(lines, roomKey).map((g) => {
    const destination = sample.get(g.key)?.destination ?? null;
    const floor = destination ? floorOf(destination.id, tree) : null;
    return { destination, floor, color: floorColor(floor, floorColors), tally: g.tally };
  });
  const afterDelivery: AtRiskLine[] = [];
  for (const l of lines) {
    const reason = afterDeliveryReason(l);
    if (reason) afterDelivery.push({ ...l, reason });
  }
  const custom = new Set(Object.keys(floorColors).map((k) => k.trim().toLowerCase()));

  return {
    job: {
      id: job.id,
      code: job.code,
      name: job.name,
      status: job.status,
      origin: place(job.originLocationId, tree),
      destination: place(job.destinationLocationId, tree),
    },
    overall: tally(lines),
    byFloor,
    byRoom,
    remaining: lines.filter((l) => l.stage !== "placed"),
    misplaced: lines.filter((l) => l.stage === MISPLACED),
    afterDelivery,
    shipments: jobShipments,
    floors: byFloor
      .filter((f): f is FloorProgress & { floor: string } => f.floor !== null)
      .map((f) => ({ floor: f.floor, color: f.color, custom: custom.has(f.floor.trim().toLowerCase()) })),
    truncated: lines.length >= MAX_LINES,
  };
}

/**
 * Replace a job's floor colour overrides. A floor left out goes back to its
 * standard colour.
 */
export async function setFloorColors(jobId: string, colors: FloorColors): Promise<FloorColors> {
  const job = await loadJob(jobId);
  const raw = ((job.metadata as Record<string, unknown> | null)?.placement ?? {}) as Record<string, unknown>;
  const clean = readFloorColors(colors);
  await setJobMetadata(jobId, "placement", { ...raw, floorColors: clean });
  return clean;
}
