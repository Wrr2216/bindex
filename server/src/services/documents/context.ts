import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { companies, projectPhases, projects } from "../../db/schema";
import { getConfig } from "../config";
import * as jobsCore from "../jobs-core";
import type { PacketJob } from "./conditions";
import type { Snapshot } from "./layout";
import type { MergeContext } from "./merge";
import type { Block } from "./model";
import { sampleContext } from "./sample";
import { MAX_TABLE_ROWS, setTableLoader, tableSource, type TableData, type TableFilter } from "./sources";

/**
 * The job data a document merges and tabulates, read live. A draft shows it as
 * it is now; completing a document freezes it into the snapshot.
 */

const iso = (d: Date | string | null | undefined) => (d instanceof Date ? d.toISOString() : d ?? null);

/** Each location's chain upwards, nearest first: [itself, parent, grandparent, ...]. */
export async function locationChains(ids: (string | null)[]): Promise<Map<string, { id: string; name: string }[]>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, { id: string; name: string }[]>();
  if (!wanted.length) return out;
  const { rows } = await pool.query<{ start: string; id: string; name: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id AS start, id, name, parent_id, 0 AS depth FROM locations WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT c.start, l.id, l.name, l.parent_id, c.depth + 1
         FROM chain c JOIN locations l ON l.id = c.parent_id
        WHERE c.depth < 50
     )
     SELECT start, id, name FROM chain ORDER BY start, depth`,
    [wanted],
  );
  for (const r of rows) {
    const chain = out.get(r.start) ?? [];
    chain.push({ id: r.id, name: r.name });
    out.set(r.start, chain);
  }
  return out;
}

const pathOf = (chain: { name: string }[] | undefined) =>
  chain?.length ? [...chain].reverse().map((l) => l.name).join(" / ") : null;

/** Today's date as YYYY-MM-DD in a time zone, for {{today}}. */
export function todayIn(timeZone: string, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

async function instanceContext(): Promise<MergeContext> {
  const config = await getConfig();
  return { org: { name: config.orgName || config.appName }, app: { name: config.appName } };
}

/**
 * Merge context for a job, or just the instance names for a document with no
 * job. Values are JSON (dates as ISO strings) so the context can be frozen
 * into a snapshot as it is.
 */
export async function mergeContext(jobId: string | null): Promise<MergeContext> {
  const base = await instanceContext();
  if (!jobId) return base;
  const job = await jobsCore.getJob(jobId);
  const [project, phase, chains] = await Promise.all([
    job.projectId
      ? db
          .select({
            code: projects.code,
            name: projects.name,
            status: projects.status,
            startsOn: projects.startsOn,
            endsOn: projects.endsOn,
            client: companies.name,
          })
          .from(projects)
          .leftJoin(companies, eq(projects.companyId, companies.id))
          .where(eq(projects.id, job.projectId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : null,
    job.phaseId
      ? db
          .select({ name: projectPhases.name, startsOn: projectPhases.startsOn, endsOn: projectPhases.endsOn })
          .from(projectPhases)
          .where(eq(projectPhases.id, job.phaseId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : null,
    locationChains([job.originLocationId, job.destinationLocationId]),
  ]);
  const overall = job.progress.overall;
  const keys = (groups: { key: string | null }[]) => groups.flatMap((g) => (g.key ? [g.key] : [])).join(", ");
  return {
    ...base,
    job: {
      id: job.id,
      code: job.code,
      name: job.name,
      type: job.jobTypeName ?? null,
      status: job.status,
      origin: job.originName ?? null,
      destination: job.destinationName ?? null,
      originPath: pathOf(chains.get(job.originLocationId ?? "")),
      destinationPath: pathOf(chains.get(job.destinationLocationId ?? "")),
      scheduledStart: iso(job.scheduledStart),
      scheduledEnd: iso(job.scheduledEnd),
      startedAt: iso(job.startedAt),
      completedAt: iso(job.completedAt),
      notes: job.notes,
      metadata: job.metadata ?? {},
    },
    project: project ? { ...project, client: project.client ?? null } : null,
    phase,
    manifest: {
      count: overall.total,
      floors: keys(job.progress.byFloor),
      departments: keys(job.progress.byDepartment),
      packed: overall.reached.packed,
      loaded: overall.reached.loaded,
      delivered: overall.reached.delivered,
      placed: overall.reached.placed,
    },
    shipments: { count: job.shipments.length, codes: job.shipments.map((s) => s.code).join(", ") },
    tasks: { count: job.tasks.length, done: job.tasks.filter((t) => t.status === "done").length },
  };
}

/** Recent jobs matching a search, for pickers: newest first, at most 50. */
export async function pickJobs(q?: string) {
  const term = q?.trim();
  const { rows } = await pool.query<{ id: string; code: string; name: string; status: string; jobTypeName: string | null }>(
    `SELECT j.id, j.code, j.name, j.status, t.name AS "jobTypeName"
       FROM jobs j LEFT JOIN job_types t ON t.id = j.job_type_id
      WHERE $1::text IS NULL OR j.name ILIKE $1 OR j.code ILIKE $1
      ORDER BY j.created_at DESC
      LIMIT 50`,
    [term ? `%${term}%` : null],
  );
  return rows;
}

/** Every project with its phases, for the packet condition editor. */
export async function projectsWithPhases() {
  const [projects, phases] = await Promise.all([
    pool.query<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM projects ORDER BY created_at DESC`),
    pool.query<{ id: string; projectId: string; name: string }>(
      `SELECT id, project_id AS "projectId", name FROM project_phases ORDER BY sequence, created_at`,
    ),
  ]);
  return projects.rows.map((p) => ({
    ...p,
    phases: phases.rows.filter((ph) => ph.projectId === p.id).map(({ id, name }) => ({ id, name })),
  }));
}

/** Rows for every table block, read for `jobId`; sample rows when there is no job. */
export async function tableData(body: Block[], jobId: string | null, opts: { sample?: boolean } = {}): Promise<Record<string, TableData>> {
  const out: Record<string, TableData> = {};
  for (const block of body) {
    if (block.type !== "table") continue;
    const source = tableSource(block.source);
    if (!source) continue;
    if (!jobId) {
      out[block.id] = opts.sample ? { rows: source.sample, total: source.sample.length } : { rows: [], total: 0 };
      continue;
    }
    out[block.id] = source.load ? await source.load(jobId, block.filter ?? {}) : { rows: [], total: 0 };
  }
  return out;
}

/** What a preview without a job merges. */
export async function sampleMergeContext(): Promise<MergeContext> {
  const config = await getConfig();
  return sampleContext({ orgName: config.orgName, appName: config.appName });
}

/** Freeze the live data for a document being completed. */
export async function takeSnapshot(body: Block[], jobId: string | null, timeZone: string, now = new Date()): Promise<Snapshot> {
  const [context, tables] = await Promise.all([mergeContext(jobId), tableData(body, jobId)]);
  return { context, tables, today: todayIn(timeZone, now), capturedAt: now.toISOString() };
}

/** The job as packet conditions see it. Null when the job does not exist. */
export async function packetJob(jobId: string): Promise<PacketJob | null> {
  const { rows } = await pool.query<{
    id: string;
    code: string;
    name: string;
    status: string;
    notes: string | null;
    metadata: Record<string, unknown> | null;
    job_type_id: string | null;
    project_id: string | null;
    phase_id: string | null;
    origin_location_id: string | null;
    destination_location_id: string | null;
    scheduled_start: Date | null;
    scheduled_end: Date | null;
    type_name: string | null;
    project_name: string | null;
    phase_name: string | null;
    origin_name: string | null;
    destination_name: string | null;
  }>(
    `SELECT j.id, j.code, j.name, j.status, j.notes, j.metadata, j.job_type_id, j.project_id, j.phase_id,
            j.origin_location_id, j.destination_location_id, j.scheduled_start, j.scheduled_end,
            t.name AS type_name, p.name AS project_name, ph.name AS phase_name,
            o.name AS origin_name, d.name AS destination_name
       FROM jobs j
       LEFT JOIN job_types t ON t.id = j.job_type_id
       LEFT JOIN projects p ON p.id = j.project_id
       LEFT JOIN project_phases ph ON ph.id = j.phase_id
       LEFT JOIN locations o ON o.id = j.origin_location_id
       LEFT JOIN locations d ON d.id = j.destination_location_id
      WHERE j.id = $1`,
    [jobId],
  );
  const j = rows[0];
  if (!j) return null;
  const chains = await locationChains([j.origin_location_id, j.destination_location_id]);
  const ids = (id: string | null) => (id ? (chains.get(id) ?? []).map((l) => l.id) : []);
  return {
    jobTypeId: j.job_type_id,
    projectId: j.project_id,
    phaseId: j.phase_id,
    originSites: ids(j.origin_location_id),
    destinationSites: ids(j.destination_location_id),
    fields: {
      status: j.status,
      name: j.name,
      code: j.code,
      notes: j.notes,
      type: j.type_name,
      project: j.project_name,
      phase: j.phase_name,
      origin: j.origin_name,
      destination: j.destination_name,
      scheduledStart: iso(j.scheduled_start),
      scheduledEnd: iso(j.scheduled_end),
      metadata: j.metadata ?? {},
    },
  };
}

// --- Built-in table loaders ------------------------------------------------------

setTableLoader("manifest", async (jobId, filter: TableFilter) => {
  const { lines, total } = await jobsCore.listJobItems(jobId, {
    floor: filter.floor || undefined,
    department: filter.department || undefined,
    stage: filter.stage || undefined,
    limit: MAX_TABLE_ROWS,
  });
  return {
    total,
    rows: lines.map((l) => ({
      code: l.unitCode ?? l.assetCode,
      item: l.unitLabel ? `${l.itemName} (${l.unitLabel})` : l.itemName,
      description: [l.itemBrand, l.itemModel].filter(Boolean).join(" ") || null,
      serial: l.unitSerial ?? null,
      origin: l.originName ?? null,
      destination: l.destinationName ?? l.destinationLabel ?? null,
      floor: l.floor,
      department: l.department,
      crate: l.crateNo,
      stage: l.stage,
      shipment: l.shipmentCode ?? null,
      notes: l.notes,
    })),
  };
});

setTableLoader("tasks", async (jobId) => {
  const tasks = await jobsCore.listTasks(jobId);
  return {
    total: tasks.length,
    rows: tasks.map((t) => ({
      title: t.title,
      kind: t.kind,
      status: t.status,
      assignee: t.assigneeEntityName ?? t.assigneeUserOid ?? null,
      due: iso(t.dueAt),
      completed: iso(t.completedAt),
    })),
  };
});

setTableLoader("shipments", async (jobId) => {
  const rows = await jobsCore.listShipments({ jobId });
  return {
    total: rows.length,
    rows: [...rows].reverse().map((s) => ({
      code: s.code,
      name: s.name,
      carrier: s.carrier,
      status: s.status,
      seals: s.sealNumbers.join(", ") || null,
      eta: iso(s.eta),
      lines: s.progress.total,
    })),
  };
});
