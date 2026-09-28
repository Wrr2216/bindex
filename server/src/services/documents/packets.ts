import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  documentJobPackets,
  documentPacketTemplates,
  documentPackets,
  documentTemplates,
  documents,
  jobs,
  type DocumentPacket,
} from "../../db/schema";
import { HttpError, badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { evaluateConditions, readConditions, type Evaluation, type PacketConditions } from "./conditions";
import { mergeContext, packetJob } from "./context";
import { createDocument, listDocuments } from "./documents";
import { emitDocumentEvent } from "./events";
import type { Actor, Executor } from "./shared";
import { latestPublished } from "./templates";

/**
 * Packets: an ordered set of templates with conditions saying which jobs need
 * them. A job gets the packets it matches when it is created and whenever it
 * changes (through the jobs onJobChanged hook, wired in hooks.ts), and can
 * have more attached by hand.
 *
 * When an automatic packet stops matching (the job's type changed), its
 * documents nobody has touched are removed and filled-in ones are kept. A
 * document someone deleted on purpose is not recreated, because attaching
 * happens once per packet, not on every change.
 */

export type PacketInput = {
  name: string;
  description?: string | null;
  templateIds: string[];
  conditions?: PacketConditions;
  autoAttach?: boolean;
  active?: boolean;
};

const OPEN_STATUSES = ["planned", "in_progress"];

const nameTaken = (err: unknown) => isUniqueViolation(err, "uq_document_packets_name");

async function packetTemplates(packetIds: string[]) {
  if (!packetIds.length) return new Map<string, { id: string; name: string; active: boolean; publishedVersion: number | null }[]>();
  const rows = await db
    .select({
      packetId: documentPacketTemplates.packetId,
      id: documentTemplates.id,
      name: documentTemplates.name,
      active: documentTemplates.active,
      publishedVersion: sql<number | null>`(SELECT max(v.version)::int FROM document_template_versions v WHERE v.template_id = document_templates.id AND v.status = 'published')`,
    })
    .from(documentPacketTemplates)
    .innerJoin(documentTemplates, eq(documentPacketTemplates.templateId, documentTemplates.id))
    .where(inArray(documentPacketTemplates.packetId, packetIds))
    .orderBy(asc(documentPacketTemplates.position));
  const out = new Map<string, { id: string; name: string; active: boolean; publishedVersion: number | null }[]>();
  for (const { packetId, ...t } of rows) {
    const list = out.get(packetId) ?? [];
    list.push(t);
    out.set(packetId, list);
  }
  return out;
}

const present = (p: DocumentPacket, templates: Awaited<ReturnType<typeof packetTemplates>>, jobCount = 0) => ({
  ...p,
  conditions: readConditions(p.conditions),
  templates: templates.get(p.id) ?? [],
  jobCount,
});

export async function listPackets() {
  const rows = await db
    .select({ packet: documentPackets, jobCount: sql<number>`(SELECT count(*)::int FROM document_job_packets jp WHERE jp.packet_id = document_packets.id AND jp.applies)` })
    .from(documentPackets)
    .orderBy(asc(documentPackets.name));
  const templates = await packetTemplates(rows.map((r) => r.packet.id));
  return rows.map((r) => present(r.packet, templates, r.jobCount));
}

async function loadPacket(id: string, ex: Executor = db): Promise<DocumentPacket> {
  const [row] = await ex.select().from(documentPackets).where(eq(documentPackets.id, id)).limit(1);
  if (!row) throw notFound("Packet not found");
  return row;
}

export async function getPacket(id: string) {
  const packet = await loadPacket(id);
  const [templates, [{ n } = { n: 0 }]] = await Promise.all([
    packetTemplates([id]),
    db.select({ n: sql<number>`count(*)::int` }).from(documentJobPackets).where(and(eq(documentJobPackets.packetId, id), eq(documentJobPackets.applies, true))),
  ]);
  return present(packet, templates, n);
}

async function writeTemplates(ex: Executor, packetId: string, templateIds: string[]) {
  const unique = [...new Set(templateIds)];
  if (unique.length !== templateIds.length) throw badRequest("A template can be in a packet once.");
  if (unique.length) {
    const found = await ex.select({ id: documentTemplates.id }).from(documentTemplates).where(inArray(documentTemplates.id, unique));
    if (found.length !== unique.length) throw badRequest("One of the templates does not exist. Reload and pick again.");
  }
  await ex.delete(documentPacketTemplates).where(eq(documentPacketTemplates.packetId, packetId));
  if (unique.length) {
    await ex.insert(documentPacketTemplates).values(unique.map((templateId, position) => ({ packetId, templateId, position })));
  }
}

export async function createPacket(input: PacketInput, actor: Actor) {
  const name = input.name.trim();
  if (!name) throw badRequest("A packet needs a name.");
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(documentPackets)
        .values({
          name,
          description: input.description?.trim() || null,
          conditions: (input.conditions ?? {}) as Record<string, unknown>,
          autoAttach: input.autoAttach ?? true,
          active: input.active ?? true,
          createdBy: actor.userOid,
        })
        .returning();
      await writeTemplates(tx, row!.id, input.templateIds);
      return row!.id;
    });
    logger.info("documents.packet.created", { packetId: id });
    return getPacket(id);
  } catch (err) {
    if (nameTaken(err)) throw conflict(`There is already a packet called "${name}".`);
    throw err;
  }
}

export async function updatePacket(id: string, patch: Partial<PacketInput>) {
  try {
    await db.transaction(async (tx) => {
      await loadPacket(id, tx);
      const set: Partial<typeof documentPackets.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) {
        if (!patch.name.trim()) throw badRequest("A packet needs a name.");
        set.name = patch.name.trim();
      }
      if (patch.description !== undefined) set.description = patch.description?.trim() || null;
      if (patch.conditions !== undefined) set.conditions = patch.conditions as Record<string, unknown>;
      if (patch.autoAttach !== undefined) set.autoAttach = patch.autoAttach;
      if (patch.active !== undefined) set.active = patch.active;
      await tx.update(documentPackets).set(set).where(eq(documentPackets.id, id));
      if (patch.templateIds !== undefined) await writeTemplates(tx, id, patch.templateIds);
    });
  } catch (err) {
    if (nameTaken(err)) throw conflict(`There is already a packet called "${patch.name?.trim()}".`);
    throw err;
  }
  return getPacket(id);
}

/** Documents already started keep their content; they just stop naming the packet. */
export async function deletePacket(id: string): Promise<void> {
  const deleted = await db.delete(documentPackets).where(eq(documentPackets.id, id)).returning({ id: documentPackets.id });
  if (!deleted.length) throw notFound("Packet not found");
  logger.info("documents.packet.deleted", { packetId: id });
}

type AttachOutcome = { documentIds: string[]; unpublished: string[] };

/**
 * Create the packet's documents for a job, in packet order, skipping templates
 * that already have a document from this packet on the job and templates not
 * published yet (reported back so the screen can say so).
 */
async function createPacketDocuments(
  tx: Executor,
  jobId: string,
  packetId: string,
  actor: Actor,
  context: Record<string, unknown> | undefined,
): Promise<AttachOutcome> {
  const templates = await tx
    .select({ templateId: documentPacketTemplates.templateId, position: documentPacketTemplates.position, name: documentTemplates.name, active: documentTemplates.active })
    .from(documentPacketTemplates)
    .innerJoin(documentTemplates, eq(documentPacketTemplates.templateId, documentTemplates.id))
    .where(eq(documentPacketTemplates.packetId, packetId))
    .orderBy(asc(documentPacketTemplates.position));
  const existing = new Set(
    (
      await tx
        .select({ templateId: documents.templateId })
        .from(documents)
        .where(and(eq(documents.jobId, jobId), eq(documents.packetId, packetId)))
    ).map((d) => d.templateId),
  );
  const out: AttachOutcome = { documentIds: [], unpublished: [] };
  for (const t of templates) {
    if (!t.active || existing.has(t.templateId)) continue;
    if (!(await latestPublished(t.templateId, tx))) {
      out.unpublished.push(t.name);
      continue;
    }
    const doc = await createDocument({ templateId: t.templateId, jobId, packetId, position: t.position }, actor, { ex: tx, context, emit: false });
    out.documentIds.push(doc.id);
  }
  return out;
}

/** Delete a packet's documents on a job that nobody has touched; return what was removed and what was kept. */
async function removeUntouched(tx: Executor, jobId: string, packetId: string) {
  const docs = await tx
    .select({ id: documents.id, status: documents.status, values: documents.values })
    .from(documents)
    .where(and(eq(documents.jobId, jobId), eq(documents.packetId, packetId)));
  const untouched = docs.filter((d) => d.status === "draft" && Object.keys(d.values).length === 0).map((d) => d.id);
  if (untouched.length) await tx.delete(documents).where(inArray(documents.id, untouched));
  return { removed: untouched, kept: docs.length - untouched.length };
}

// One job's packets are changed by one caller at a time: a job saved twice in
// quick succession must not attach the same packet twice.
const lockJob = (tx: Executor, jobId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`documents:job:${jobId}`}))`);

export type SyncResult = {
  attached: { packetId: string; name: string; documents: number; unpublished: string[] }[];
  withdrawn: { packetId: string; name: string; removed: number; kept: number }[];
};

/**
 * Attach every automatic packet the job now matches, and withdraw automatic
 * ones it no longer does. Does nothing while the documents feature is off.
 */
export async function syncJobPackets(jobId: string, actor: Actor): Promise<SyncResult | null> {
  if (!(await getConfig()).features.documents) return null;
  const job = await packetJob(jobId);
  if (!job) return null;
  const packets = (await db.select().from(documentPackets).where(and(eq(documentPackets.active, true), eq(documentPackets.autoAttach, true)))).map(
    (p) => ({ ...p, evaluation: evaluateConditions(readConditions(p.conditions), job) }),
  );
  if (!packets.length) return { attached: [], withdrawn: [] };
  // Reading the job for document titles is the expensive part, and most job
  // saves attach nothing new, so it is read only when something will be.
  const before = new Map(
    (await db.select().from(documentJobPackets).where(eq(documentJobPackets.jobId, jobId))).map((r) => [r.packetId, r]),
  );
  const attaching = packets.some((p) => p.evaluation.matches && !before.get(p.id)?.applies && (before.get(p.id)?.auto ?? true));
  // Undefined lets a document created after all (a race) read the job itself.
  const context = attaching ? await mergeContext(jobId) : undefined;
  const result: SyncResult = { attached: [], withdrawn: [] };

  await db.transaction(async (tx) => {
    await lockJob(tx, jobId);
    const rows = await tx.select().from(documentJobPackets).where(eq(documentJobPackets.jobId, jobId));
    const byPacket = new Map(rows.map((r) => [r.packetId, r]));
    for (const p of packets) {
      const row = byPacket.get(p.id);
      if (p.evaluation.matches) {
        if (row?.applies) continue;
        if (row && !row.auto) continue;
        if (row) {
          await tx
            .update(documentJobPackets)
            .set({ applies: true, updatedAt: new Date() })
            .where(and(eq(documentJobPackets.jobId, jobId), eq(documentJobPackets.packetId, p.id)));
        } else {
          await tx.insert(documentJobPackets).values({ jobId, packetId: p.id, auto: true, attachedBy: actor.userOid });
        }
        const outcome = await createPacketDocuments(tx, jobId, p.id, actor, context);
        result.attached.push({ packetId: p.id, name: p.name, documents: outcome.documentIds.length, unpublished: outcome.unpublished });
      }
    }
    // Withdraw automatic packets that stopped matching. A packet switched off,
    // or set to attach by hand only, leaves the jobs it is already on alone:
    // that setting is about new jobs, not a recall.
    const matching = new Set(packets.filter((p) => p.evaluation.matches).map((p) => p.id));
    const live = new Set(packets.map((p) => p.id));
    for (const row of rows) {
      if (!row.auto || !row.applies || matching.has(row.packetId) || !live.has(row.packetId)) continue;
      const { removed, kept } = await removeUntouched(tx, jobId, row.packetId);
      if (kept === 0) {
        await tx.delete(documentJobPackets).where(and(eq(documentJobPackets.jobId, jobId), eq(documentJobPackets.packetId, row.packetId)));
      } else {
        await tx
          .update(documentJobPackets)
          .set({ applies: false, updatedAt: new Date() })
          .where(and(eq(documentJobPackets.jobId, jobId), eq(documentJobPackets.packetId, row.packetId)));
      }
      const name = packets.find((p) => p.id === row.packetId)?.name ?? "";
      result.withdrawn.push({ packetId: row.packetId, name, removed: removed.length, kept });
    }
  });

  for (const a of result.attached) {
    logger.info("documents.packet.attached", { jobId, packetId: a.packetId, documents: a.documents, auto: true });
    await emitDocumentEvent("document_packet.attached", { type: "job", id: jobId }, { ...a, auto: true }, actor);
  }
  for (const w of result.withdrawn) {
    logger.info("documents.packet.withdrawn", { jobId, packetId: w.packetId, removed: w.removed, kept: w.kept });
    await emitDocumentEvent("document_packet.withdrawn", { type: "job", id: jobId }, w, actor);
  }
  return result;
}

/**
 * Attach a packet to a job. By hand (the default) it goes on whatever its
 * conditions say and is never withdrawn automatically; `auto` marks it as
 * attached by its conditions, so it is withdrawn if the job stops matching.
 */
export async function attachPacket(jobId: string, packetId: string, actor: Actor, opts: { auto?: boolean } = {}) {
  const auto = opts.auto ?? false;
  const packet = await loadPacket(packetId);
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw notFound("Job not found");
  const context = await mergeContext(jobId);
  const outcome = await db.transaction(async (tx) => {
    await lockJob(tx, jobId);
    const [row] = await tx
      .select()
      .from(documentJobPackets)
      .where(and(eq(documentJobPackets.jobId, jobId), eq(documentJobPackets.packetId, packetId)));
    if (row?.applies) throw conflict(`"${packet.name}" is already on this job.`);
    if (row) {
      await tx
        .update(documentJobPackets)
        .set({ applies: true, auto, updatedAt: new Date() })
        .where(and(eq(documentJobPackets.jobId, jobId), eq(documentJobPackets.packetId, packetId)));
    } else {
      await tx.insert(documentJobPackets).values({ jobId, packetId, auto, attachedBy: actor.userOid });
    }
    return createPacketDocuments(tx, jobId, packetId, actor, context);
  });
  const summary = { packetId, name: packet.name, documents: outcome.documentIds.length, unpublished: outcome.unpublished };
  logger.info("documents.packet.attached", { jobId, packetId, documents: summary.documents, auto });
  await emitDocumentEvent("document_packet.attached", { type: "job", id: jobId }, { ...summary, auto }, actor);
  return summary;
}

/** Take a packet off a job: untouched documents go, filled-in ones stay. */
export async function detachPacket(jobId: string, packetId: string, actor: Actor) {
  const packet = await loadPacket(packetId);
  const result = await db.transaction(async (tx) => {
    await lockJob(tx, jobId);
    const deleted = await tx
      .delete(documentJobPackets)
      .where(and(eq(documentJobPackets.jobId, jobId), eq(documentJobPackets.packetId, packetId)))
      .returning({ jobId: documentJobPackets.jobId });
    if (!deleted.length) throw notFound("That packet is not on this job.");
    return removeUntouched(tx, jobId, packetId);
  });
  const summary = { packetId, name: packet.name, removed: result.removed.length, kept: result.kept };
  await emitDocumentEvent("document_packet.withdrawn", { type: "job", id: jobId }, { ...summary, manual: true }, actor);
  return summary;
}

/** Attach a packet to every open job it matches now, for a packet created after its jobs. */
export async function applyPacketToOpenJobs(packetId: string, actor: Actor) {
  const packet = await loadPacket(packetId);
  if (!packet.active) throw conflict("Switch the packet on before applying it.");
  const conditions = readConditions(packet.conditions);
  const open = await db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.status, OPEN_STATUSES as ("planned" | "in_progress")[]));
  const already = new Set(
    (
      await db
        .select({ jobId: documentJobPackets.jobId })
        .from(documentJobPackets)
        .where(and(eq(documentJobPackets.packetId, packetId), eq(documentJobPackets.applies, true)))
    ).map((r) => r.jobId),
  );
  const attached: string[] = [];
  for (const { id } of open) {
    if (already.has(id)) continue;
    const job = await packetJob(id);
    if (!job || !evaluateConditions(conditions, job).matches) continue;
    try {
      await attachPacket(id, packetId, actor, { auto: packet.autoAttach });
      attached.push(id);
    } catch (err) {
      // Attached by a job change in the meantime: nothing left to do.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
  }
  return { checked: open.length, attached: attached.length, jobIds: attached };
}

/** Would these conditions attach to that job, and why. */
export async function testConditions(conditions: PacketConditions, jobId: string): Promise<Evaluation> {
  const job = await packetJob(jobId);
  if (!job) throw notFound("Job not found");
  return evaluateConditions(conditions, job);
}

/** A job's packets and documents, for the job's documents screen. */
export async function jobDocuments(jobId: string) {
  const [job] = await db
    .select({ id: jobs.id, code: jobs.code, name: jobs.name, status: jobs.status, jobTypeId: jobs.jobTypeId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) throw notFound("Job not found");
  const [packets, docs] = await Promise.all([
    db
      .select({
        packetId: documentJobPackets.packetId,
        name: documentPackets.name,
        auto: documentJobPackets.auto,
        applies: documentJobPackets.applies,
        attachedAt: documentJobPackets.attachedAt,
      })
      .from(documentJobPackets)
      .innerJoin(documentPackets, eq(documentJobPackets.packetId, documentPackets.id))
      .where(eq(documentJobPackets.jobId, jobId))
      .orderBy(asc(documentJobPackets.attachedAt)),
    listDocuments({ jobId, limit: 1000 }),
  ]);
  return { job, packets, documents: docs };
}
