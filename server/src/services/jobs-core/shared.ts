import { eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { db } from "../../db/client";
import * as schema from "../../db/schema";
import { jobs, shipments, type Job, type Shipment } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { OPEN_JOB_STATUSES } from "./model";

/** The database or an open transaction: both run the same queries. */
export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

/**
 * Who is acting. `userOid` is the signed-in account (null for a system or
 * external change); `name` is what the history shows.
 */
export type Actor = { userOid: string | null; name?: string | null };

export const actorLabel = (actor: Actor): string | null => actor.name?.trim() || actor.userOid;

/** Trim to null, so an empty form field clears a column instead of storing "". */
export const clean = (s: string | null | undefined): string | null => {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t ? t : null;
};

/** Apply `clean` only to keys that are present, for PATCH semantics. */
export function cleanPatch<T extends Record<string, unknown>>(patch: T, textKeys: (keyof T)[]): T {
  const out = { ...patch };
  for (const key of textKeys) {
    if (key in out) (out as Record<keyof T, unknown>)[key] = clean(out[key] as string | null | undefined);
  }
  return out;
}

export async function loadJob(id: string, ex: Executor = db): Promise<Job> {
  const [job] = await ex.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) throw notFound("Job not found");
  return job;
}

/** A job that still takes scans and manifest changes. */
export function assertJobOpen(job: Job): void {
  if (!(OPEN_JOB_STATUSES as readonly string[]).includes(job.status)) {
    throw badRequest(
      `${job.code} is ${job.status.replace(/_/g, " ")}. Reopen it (set it back to in progress) to change its manifest.`,
    );
  }
}

export async function loadShipment(id: string, ex: Executor = db): Promise<Shipment> {
  const [row] = await ex.select().from(shipments).where(eq(shipments.id, id)).limit(1);
  if (!row) throw notFound("Shipment not found");
  return row;
}

/** A shipment that belongs to `jobId`, or a 400 saying it does not. */
export async function loadShipmentOnJob(jobId: string, shipmentId: string, ex: Executor = db): Promise<Shipment> {
  const shipment = await loadShipment(shipmentId, ex);
  if (shipment.jobId !== jobId) {
    throw badRequest(`${shipment.code} belongs to a different job. Pick one of this job's shipments.`);
  }
  return shipment;
}

/** YYYY-MM-DD ordering check for a start/end pair. */
export function assertDateOrder(start: string | Date | null | undefined, end: string | Date | null | undefined, what: string) {
  if (!start || !end) return;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isFinite(a) && Number.isFinite(b) && b < a) {
    throw badRequest(`${what} ends before it starts. Check the dates.`);
  }
}
