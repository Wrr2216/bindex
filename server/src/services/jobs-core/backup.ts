import { db } from "../../db/client";
import {
  jobItemStageHistory,
  jobItems,
  jobTasks,
  jobTypes,
  jobs,
  projectPhases,
  projects,
  shipmentStatusHistory,
  shipments,
} from "../../db/schema";
import type { Executor } from "./shared";

/**
 * Jobs in the instance backup. services/backup.ts lists these tables and calls
 * the three functions below, so the backup format stays in one place while the
 * knowledge of these tables stays here.
 */

/** Parent-before-child order, which is also the insert order. */
export const JOBS_CORE_TABLES = [
  "job_types",
  "projects",
  "project_phases",
  "jobs",
  "job_tasks",
  "shipments",
  "shipment_status_history",
  "job_items",
  "job_item_stage_history",
] as const;
export type JobsCoreTable = (typeof JOBS_CORE_TABLES)[number];

const TABLE = {
  job_types: jobTypes,
  projects,
  project_phases: projectPhases,
  jobs,
  job_tasks: jobTasks,
  shipments,
  shipment_status_history: shipmentStatusHistory,
  job_items: jobItems,
  job_item_stage_history: jobItemStageHistory,
} as const;

export async function exportJobsCoreTables(): Promise<Record<JobsCoreTable, Record<string, unknown>[]>> {
  const rows: Record<string, unknown>[][] = await Promise.all(
    JOBS_CORE_TABLES.map((t) => db.select().from(TABLE[t])),
  );
  const out = {} as Record<JobsCoreTable, Record<string, unknown>[]>;
  JOBS_CORE_TABLES.forEach((t, i) => {
    out[t] = rows[i]!;
  });
  return out;
}

/**
 * Clear jobs before a restore. Job types are configuration rather than data,
 * so a file with none (one written before jobs existed) leaves them alone, the
 * way groups are kept for files that predate groups.
 */
export async function clearJobsCoreTables(tx: Executor, opts: { keepJobTypes: boolean }): Promise<void> {
  for (const t of [...JOBS_CORE_TABLES].reverse()) {
    if (t === "job_types" && opts.keepJobTypes) continue;
    await tx.delete(TABLE[t]);
  }
}

/** Insert the snapshot's jobs, after items, units and locations are back. */
export async function restoreJobsCoreTables(
  tx: Executor,
  data: Record<JobsCoreTable, Record<string, unknown>[]>,
): Promise<void> {
  for (const t of JOBS_CORE_TABLES) {
    const rows = data[t];
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(TABLE[t]).values(rows.slice(i, i + 500) as never);
    }
  }
}
