import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { jobItems, jobs, shipments } from "../../db/schema";
import { jobProgress, rollupCounts, type GroupProgress, type Progress } from "./rollups";

/**
 * Progress read from the database. The arithmetic is in rollups.ts; this only
 * fetches stage counts (or the few columns a breakdown needs) and names the
 * groups.
 */

async function countsBy(
  keyColumn: typeof jobItems.jobId | typeof jobItems.shipmentId | typeof jobs.projectId,
  ids: string[],
): Promise<Map<string, Progress>> {
  const out = new Map<string, Progress>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ key: keyColumn, stage: jobItems.stage, n: sql<number>`count(*)::int` })
    .from(jobItems)
    .innerJoin(jobs, eq(jobs.id, jobItems.jobId))
    .where(inArray(keyColumn, ids))
    .groupBy(keyColumn, jobItems.stage);
  const counts = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (!r.key) continue;
    const c = counts.get(r.key) ?? {};
    c[r.stage] = r.n;
    counts.set(r.key, c);
  }
  for (const id of ids) out.set(id, rollupCounts(counts.get(id) ?? {}));
  return out;
}

export const progressByJob = (jobIds: string[]) => countsBy(jobItems.jobId, jobIds);
export const progressByShipment = (shipmentIds: string[]) => countsBy(jobItems.shipmentId, shipmentIds);
export const progressByProject = (projectIds: string[]) => countsBy(jobs.projectId, projectIds);

export type LabelledGroup = GroupProgress & { label: string; code?: string | null };

export type JobProgressDetail = {
  overall: Progress;
  byShipment: LabelledGroup[];
  byFloor: LabelledGroup[];
  byDepartment: LabelledGroup[];
};

/** Overall, per shipment, per floor and per department, for one job. */
export async function getJobProgress(jobId: string): Promise<JobProgressDetail> {
  const [lines, jobShipments] = await Promise.all([
    db
      .select({
        stage: jobItems.stage,
        shipmentId: jobItems.shipmentId,
        floor: jobItems.floor,
        department: jobItems.department,
      })
      .from(jobItems)
      .where(eq(jobItems.jobId, jobId)),
    db
      .select({ id: shipments.id, code: shipments.code, name: shipments.name })
      .from(shipments)
      .where(eq(shipments.jobId, jobId))
      .orderBy(asc(shipments.createdAt)),
  ]);
  const p = jobProgress(lines);
  const order = new Map(jobShipments.map((s, i) => [s.id, i]));
  const byId = new Map(jobShipments.map((s) => [s.id, s]));
  const byShipment = p.byShipment
    .map((g) => {
      const s = g.key ? byId.get(g.key) : undefined;
      return { ...g, label: s ? s.name : "Not on a shipment", code: s?.code ?? null };
    })
    .sort((a, b) => (a.key ? order.get(a.key) ?? 0 : 1e9) - (b.key ? order.get(b.key) ?? 0 : 1e9));
  const named = (groups: GroupProgress[], none: string): LabelledGroup[] =>
    groups.map((g) => ({ ...g, label: g.key ?? none }));
  return {
    overall: p.overall,
    byShipment,
    byFloor: named(p.byFloor, "No floor"),
    byDepartment: named(p.byDepartment, "No department"),
  };
}
