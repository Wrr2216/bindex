import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { jobItems, jobs, locations, projects, shipments, type PortalGrant, type PortalScope } from "../../db/schema";
import { HttpError } from "../../lib/errors";

/**
 * What one grant can see: its project, job or shipment and nothing else.
 *
 * Every portal query about manifest lines takes its WHERE from `lineScope`,
 * and every id a portal request names (a line, a shipment, a file) is checked
 * against the scope loaded here. Loaded fresh on every request, so a line
 * moved off a shipment disappears from that shipment's portal at once.
 */

export type ScopeJob = {
  id: string;
  code: string;
  name: string;
  status: string;
  projectId: string | null;
  originName: string | null;
  destinationName: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type ScopeShipment = {
  id: string;
  code: string;
  name: string;
  jobId: string;
  status: string;
  carrier: string | null;
  vehicleName: string | null;
  sealNumbers: string[];
  weightKg: number | null;
  volumeM3: number | null;
  distanceKm: number | null;
  eta: Date | null;
  departedAt: Date | null;
  arrivedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type PortalScopeView = {
  kind: PortalScope;
  /** The granted record's id. */
  targetId: string;
  code: string;
  name: string;
  createdAt: Date;
  project: { id: string; code: string; name: string; status: string } | null;
  jobs: ScopeJob[];
  shipments: ScopeShipment[];
  jobIds: string[];
  shipmentIds: string[];
  /** The condition on job_items that selects exactly this scope's lines. */
  lines: SQL;
};

/** A missing target reads the same as a bad link: nothing is revealed. */
const gone = () => new HttpError(401, "link_invalid", "This link does not work any more. Ask whoever shared it for a new one.");

export function grantTarget(g: Pick<PortalGrant, "scope" | "projectId" | "jobId" | "shipmentId">): string | null {
  return g.scope === "project" ? g.projectId : g.scope === "job" ? g.jobId : g.shipmentId;
}

/** The job_items condition for a scope. Exported for the tests. */
export function lineScope(kind: PortalScope, targetId: string): SQL {
  if (kind === "shipment") return eq(jobItems.shipmentId, targetId);
  if (kind === "job") return eq(jobItems.jobId, targetId);
  return sql`${jobItems.jobId} IN (SELECT ${jobs.id} FROM ${jobs} WHERE ${jobs.projectId} = ${targetId})`;
}

const origin = alias(locations, "portal_origin");
const destination = alias(locations, "portal_destination");

function jobQuery() {
  return db
    .select({
      id: jobs.id,
      code: jobs.code,
      name: jobs.name,
      status: jobs.status,
      projectId: jobs.projectId,
      originName: origin.name,
      destinationName: destination.name,
      scheduledStart: jobs.scheduledStart,
      scheduledEnd: jobs.scheduledEnd,
      startedAt: jobs.startedAt,
      completedAt: jobs.completedAt,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .leftJoin(origin, eq(jobs.originLocationId, origin.id))
    .leftJoin(destination, eq(jobs.destinationLocationId, destination.id));
}

function shipmentQuery() {
  return db
    .select({
      id: shipments.id,
      code: shipments.code,
      name: shipments.name,
      jobId: shipments.jobId,
      status: shipments.status,
      carrier: shipments.carrier,
      vehicleName: locations.name,
      sealNumbers: shipments.sealNumbers,
      weightKg: shipments.weightKg,
      volumeM3: shipments.volumeM3,
      distanceKm: shipments.distanceKm,
      eta: shipments.eta,
      departedAt: shipments.departedAt,
      arrivedAt: shipments.arrivedAt,
      metadata: shipments.metadata,
      createdAt: shipments.createdAt,
    })
    .from(shipments)
    .leftJoin(locations, eq(shipments.vehicleLocationId, locations.id));
}

/** Jobs of a project past this are not listed one by one; their lines still count. */
const MAX_PROJECT_JOBS = 500;

export async function loadScope(grant: PortalGrant): Promise<PortalScopeView> {
  const targetId = grantTarget(grant);
  if (!targetId) throw gone();

  if (grant.scope === "shipment") {
    const [shipment] = await shipmentQuery().where(eq(shipments.id, targetId)).limit(1);
    if (!shipment) throw gone();
    const scopeJobs = await jobQuery().where(eq(jobs.id, shipment.jobId)).limit(1);
    return {
      kind: "shipment",
      targetId,
      code: shipment.code,
      name: shipment.name,
      createdAt: shipment.createdAt,
      project: null,
      jobs: scopeJobs,
      shipments: [shipment],
      jobIds: scopeJobs.map((j) => j.id),
      shipmentIds: [shipment.id],
      lines: lineScope("shipment", targetId),
    };
  }

  if (grant.scope === "job") {
    const [job] = await jobQuery().where(eq(jobs.id, targetId)).limit(1);
    if (!job) throw gone();
    const scopeShipments = await shipmentQuery().where(eq(shipments.jobId, targetId)).orderBy(asc(shipments.createdAt));
    return {
      kind: "job",
      targetId,
      code: job.code,
      name: job.name,
      createdAt: job.createdAt,
      project: null,
      jobs: [job],
      shipments: scopeShipments,
      jobIds: [job.id],
      shipmentIds: scopeShipments.map((s) => s.id),
      lines: lineScope("job", targetId),
    };
  }

  const [project] = await db
    .select({ id: projects.id, code: projects.code, name: projects.name, status: projects.status, createdAt: projects.createdAt })
    .from(projects)
    .where(eq(projects.id, targetId))
    .limit(1);
  if (!project) throw gone();
  const scopeJobs = await jobQuery()
    .where(eq(jobs.projectId, targetId))
    .orderBy(asc(jobs.createdAt))
    .limit(MAX_PROJECT_JOBS);
  const jobIds = scopeJobs.map((j) => j.id);
  const scopeShipments = jobIds.length
    ? await shipmentQuery().where(inArray(shipments.jobId, jobIds)).orderBy(asc(shipments.createdAt))
    : [];
  return {
    kind: "project",
    targetId,
    code: project.code,
    name: project.name,
    createdAt: project.createdAt,
    project: { id: project.id, code: project.code, name: project.name, status: project.status },
    jobs: scopeJobs,
    shipments: scopeShipments,
    jobIds,
    shipmentIds: scopeShipments.map((s) => s.id),
    lines: lineScope("project", targetId),
  };
}

/** "Truck 1 (SHP-7F3K2A)" and the like, for emails and the audit log. */
export function scopeLabel(scope: Pick<PortalScopeView, "name" | "code">): string {
  return `${scope.name} (${scope.code})`;
}
