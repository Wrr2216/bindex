import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { placementRoomMap } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { updateJobItems } from "../jobs-core";
import { jobLines, jobSettings, loadJob, loadTree, place, type LineView, type Place } from "./data";
import { proposeDestinations, type ProposalReason } from "./propose";
import type { Tree } from "./tree";

/**
 * Destination rules for a job: its room map (origin room to destination
 * room), and proposals for lines that have no destination yet, applied in
 * bulk. The rules themselves are in propose.ts.
 */

export type RoomMapRow = { id: string; origin: Place; destination: Place };

export async function getRoomMap(jobId: string, tree?: Tree): Promise<RoomMapRow[]> {
  await loadJob(jobId);
  const t = tree ?? (await loadTree());
  const rows = await db.select().from(placementRoomMap).where(eq(placementRoomMap.jobId, jobId));
  return rows
    .map((r) => ({ id: r.id, origin: place(r.originLocationId, t), destination: place(r.destinationLocationId, t) }))
    .filter((r): r is RoomMapRow => r.origin !== null && r.destination !== null)
    .sort((a, b) => a.origin.path.join(" / ").localeCompare(b.origin.path.join(" / "), undefined, { numeric: true }));
}

/** Replace a job's room map with these rows. */
export async function setRoomMap(
  jobId: string,
  rows: { originLocationId: string; destinationLocationId: string }[],
): Promise<RoomMapRow[]> {
  await loadJob(jobId);
  const tree = await loadTree();
  const seen = new Set<string>();
  for (const r of rows) {
    if (!tree.byId.has(r.originLocationId) || !tree.byId.has(r.destinationLocationId)) {
      throw badRequest("A room in the map no longer exists. Pick it again.");
    }
    if (r.originLocationId === r.destinationLocationId) {
      throw badRequest(`${tree.byId.get(r.originLocationId)!.name} is mapped to itself. Pick where it is going.`);
    }
    if (seen.has(r.originLocationId)) {
      throw badRequest(`${tree.byId.get(r.originLocationId)!.name} is in the map twice. Keep one row for it.`);
    }
    seen.add(r.originLocationId);
  }
  await db.transaction(async (tx) => {
    await tx.delete(placementRoomMap).where(eq(placementRoomMap.jobId, jobId));
    if (rows.length) {
      await tx.insert(placementRoomMap).values(
        rows.map((r) => ({ jobId, originLocationId: r.originLocationId, destinationLocationId: r.destinationLocationId })),
      );
    }
  });
  logger.info("placement.room_map.set", { jobId, rows: rows.length });
  return getRoomMap(jobId, tree);
}

export type ProposalOptions = {
  overwrite?: boolean;
  /** Defaults to the job's origin location. */
  originRootId?: string | null;
  /** Defaults to the job's destination location. */
  destinationRootId?: string | null;
};

export type ProposalView = {
  line: LineView;
  destination: Place;
  reason: ProposalReason;
  floor: string | null;
  replaces: Place | null;
};

export type ProposalsResult = {
  originRoot: Place | null;
  destinationRoot: Place | null;
  proposals: ProposalView[];
  unmatched: { line: LineView; reason: "no_origin" | "no_match" | "ambiguous"; candidates: Place[] }[];
  /** Origins with lines that matched nothing, for adding room map rows. */
  unmatchedOrigins: { origin: Place; lines: number }[];
  /** Lines left alone: they already have a destination, or it would not change. */
  skipped: number;
};

async function compute(jobId: string, opts: ProposalOptions) {
  const job = await loadJob(jobId);
  const tree = await loadTree();
  const originRootId = opts.originRootId === undefined ? job.originLocationId : opts.originRootId;
  const destinationRootId = opts.destinationRootId === undefined ? job.destinationLocationId : opts.destinationRootId;
  for (const id of [originRootId, destinationRootId]) {
    if (id && !tree.byId.has(id)) throw notFound("Location not found");
  }
  const [lines, map] = await Promise.all([
    jobLines(jobId, tree, jobSettings(job).floorColors),
    db.select().from(placementRoomMap).where(eq(placementRoomMap.jobId, jobId)),
  ]);
  const result = proposeDestinations(
    lines.map((l) => ({
      id: l.id,
      originLocationId: l.origin?.id ?? null,
      destinationLocationId: l.destinationLocationId,
      department: l.department,
      floor: l.planFloor,
    })),
    tree,
    {
      roomMap: new Map(map.map((r) => [r.originLocationId, r.destinationLocationId])),
      originRootId,
      destinationRootId,
      overwrite: opts.overwrite,
    },
  );
  return { tree, lines, result, originRootId, destinationRootId };
}

export async function proposals(jobId: string, opts: ProposalOptions = {}): Promise<ProposalsResult> {
  const { tree, lines, result, originRootId, destinationRootId } = await compute(jobId, opts);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const origins = new Map<string, number>();
  for (const u of result.unmatched) {
    if (u.originLocationId) origins.set(u.originLocationId, (origins.get(u.originLocationId) ?? 0) + 1);
  }
  return {
    originRoot: place(originRootId, tree),
    destinationRoot: place(destinationRootId, tree),
    proposals: result.proposals.map((p) => ({
      line: byId.get(p.jobItemId)!,
      destination: place(p.destinationLocationId, tree)!,
      reason: p.reason,
      floor: p.floor,
      replaces: place(p.replaces, tree),
    })),
    unmatched: result.unmatched.map((u) => ({
      line: byId.get(u.jobItemId)!,
      reason: u.reason,
      candidates: u.candidates.map((c) => place(c, tree)!).filter(Boolean),
    })),
    unmatchedOrigins: [...origins.entries()]
      .map(([id, n]) => ({ origin: place(id, tree)!, lines: n }))
      .sort((a, b) => b.lines - a.lines),
    skipped: result.skipped,
  };
}

/**
 * Apply proposals: all of them, or only those for `jobItemIds`. Proposals are
 * worked out again here rather than trusted from the client, so what is
 * applied is what the rules say now.
 */
export async function applyProposals(
  jobId: string,
  opts: ProposalOptions & { jobItemIds?: string[] },
): Promise<{ updated: number }> {
  const { result } = await compute(jobId, opts);
  const only = opts.jobItemIds ? new Set(opts.jobItemIds) : null;
  const groups = new Map<string, { destinationLocationId: string; floor: string | null; ids: string[] }>();
  for (const p of result.proposals) {
    if (only && !only.has(p.jobItemId)) continue;
    const key = `${p.destinationLocationId}|${p.floor ?? ""}`;
    const g = groups.get(key) ?? { destinationLocationId: p.destinationLocationId, floor: p.floor, ids: [] };
    g.ids.push(p.jobItemId);
    groups.set(key, g);
  }
  let updated = 0;
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += 1000) {
      const r = await updateJobItems(jobId, g.ids.slice(i, i + 1000), {
        destinationLocationId: g.destinationLocationId,
        ...(g.floor ? { floor: g.floor } : {}),
      });
      updated += r.updated;
    }
  }
  logger.info("placement.proposals.applied", { jobId, updated });
  return { updated };
}
