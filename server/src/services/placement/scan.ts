import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { shipments } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { MAX_BATCH, resolveScanCodes, setLineStage, uniqueCodes, type AdvanceResult, type ScanRef } from "../jobs-core";
import { floorColor } from "./colors";
import {
  isOpenJob,
  itemNames,
  jobLines,
  jobSettings,
  loadJob,
  loadTree,
  loadTreeWith,
  otherOpenJobs,
  place,
  type LineView,
  type Place,
} from "./data";
import { handlingKey, handlingNotesFor } from "./handling";
import { belongsIn, decideCard, planSweep, type CardOutcome, type SweepOutcome } from "./match";
import { MISPLACED, VIA } from "./model";
import { recordObservations, type NewObservation } from "./observations";
import { floorOf, within, type Tree } from "./tree";

/**
 * What people do with placement: scan a label to learn where it goes, press
 * "Placed here", sweep a room with a handheld reader, flag what never
 * arrived. Every stage change goes through the jobs core, so it lands in the
 * job's stage history, its tasks and its events like any other scan.
 */

export type Who = { userOid: string | null; name: string | null };

export type OtherJob = {
  id: string;
  code: string;
  name: string;
  destination: Place | null;
  floor: string | null;
  floorColor: string;
};

export type ItemRef = {
  id: string;
  name: string;
  assetCode: string;
  unitId: string | null;
  unitCode: string | null;
};

const itemOf = (line: LineView): ItemRef => ({
  id: line.itemId,
  name: line.itemName,
  assetCode: line.assetCode,
  unitId: line.unitId,
  unitCode: line.unitCode,
});

const pathText = (p: Place | null) => (p ? p.path.join(" / ") : "");

async function others(itemIds: string[], jobId: string, tree: Tree): Promise<Map<string, OtherJob[]>> {
  const found = await otherOpenJobs(itemIds, jobId, tree);
  const out = new Map<string, OtherJob[]>();
  for (const [itemId, list] of found) {
    // One entry per job: an item on a job as several units still belongs to one job.
    const byJob = new Map<string, OtherJob>();
    for (const o of list) {
      if (!byJob.has(o.id)) byJob.set(o.id, { ...o, floorColor: floorColor(o.floor) });
    }
    out.set(itemId, [...byJob.values()]);
  }
  return out;
}

// --- The where-does-this-go card -------------------------------------------------------

export type Card = {
  outcome: CardOutcome;
  code: string;
  item: ItemRef | null;
  line: LineView | null;
  /** For an item this job does not move: the open jobs it is on instead. */
  otherJobs: OtherJob[];
  /** The shipment being unloaded, when one was picked. */
  shipment: { id: string; code: string; name: string } | null;
  /** This scan changed something: the line was flagged as off the wrong truck. */
  recorded: boolean;
  /** Notes from registered providers, such as AI condition records. */
  handlingNotes: string[];
};

/**
 * One scanned label, looked up for the full-screen card. Read only, except
 * that a label scanned off the wrong truck is flagged wrong_shipment on its
 * line (once), and a label that belongs to another job is noted against this
 * one, both unless `record` is false (the kiosk only looks).
 */
export async function lookup(
  jobId: string,
  rawCode: string,
  opts: { shipmentId?: string | null; record?: boolean; who: Who },
): Promise<Card> {
  const code = rawCode.trim();
  if (!code) throw badRequest("Scan or type a code.");
  const job = await loadJob(jobId);
  const record = opts.record !== false && isOpenJob(job);
  const [tree, resolved] = await Promise.all([loadTree(), resolveScanCodes([code])]);
  const { floorColors } = jobSettings(job);

  let shipment: Card["shipment"] = null;
  if (opts.shipmentId) {
    const [row] = await db
      .select({ id: shipments.id, code: shipments.code, name: shipments.name })
      .from(shipments)
      .where(and(eq(shipments.id, opts.shipmentId), eq(shipments.jobId, jobId)))
      .limit(1);
    if (!row) throw badRequest("That shipment is not on this job. Pick one of the job's shipments.");
    shipment = row;
  }

  const refs: ScanRef[] = resolved.get(code) ?? [];
  const itemIds = [...new Set(refs.map((r) => r.itemId))];
  const lines = await jobLines(jobId, tree, floorColors, { itemIds });
  const decision = decideCard(refs, lines, shipment?.id ?? null);
  let line = decision.line ? (lines.find((l) => l.id === decision.line!.id) ?? null) : null;
  let recorded = false;
  let otherJobs: OtherJob[] = [];

  if (decision.outcome === "wrong_shipment" && line && record && line.stage !== "wrong_shipment") {
    const note = shipment
      ? `Came off ${shipment.code}; planned for ${line.shipmentCode ?? "another shipment"}`
      : "Came off the wrong shipment";
    const result = await setLineStage(jobId, [line.id], "wrong_shipment", {
      via: VIA.scan,
      userOid: opts.who.userOid,
      actor: opts.who.name,
      note,
    });
    if (result.advanced.length) {
      recorded = true;
      await recordObservations([
        {
          jobId,
          jobItemId: line.id,
          itemId: line.itemId,
          unitId: line.unitId,
          code,
          outcome: "wrong_shipment",
          expectedLocationId: line.destinationLocationId,
          shipmentId: shipment?.id ?? null,
          via: VIA.scan,
          userOid: opts.who.userOid,
          actor: opts.who.name,
          note,
        },
      ]);
      line = (await jobLines(jobId, tree, floorColors, { lineIds: [line.id] }))[0] ?? line;
    }
  }

  let item: ItemRef | null = line ? itemOf(line) : null;
  if (decision.outcome === "not_on_job") {
    const ref = refs[0]!;
    const [names, elsewhere] = await Promise.all([itemNames([ref.itemId]), others([ref.itemId], jobId, tree)]);
    const named = names.get(ref.itemId);
    item = named ? { id: named.id, name: named.name, assetCode: named.assetCode, unitId: ref.unitId, unitCode: null } : null;
    otherJobs = elsewhere.get(ref.itemId) ?? [];
    if (record) {
      await recordObservations([
        {
          jobId,
          itemId: ref.itemId,
          unitId: ref.unitId,
          code,
          outcome: "wrong_job",
          otherJobId: otherJobs[0]?.id ?? null,
          shipmentId: shipment?.id ?? null,
          via: VIA.scan,
          userOid: opts.who.userOid,
          actor: opts.who.name,
        },
      ]);
    }
  }

  const refForNotes = line ? { itemId: line.itemId, unitId: line.unitId } : refs[0];
  const notes = refForNotes ? await handlingNotesFor([refForNotes]) : new Map<string, string[]>();
  logger.info("placement.lookup", { jobId, outcome: decision.outcome, recorded });
  return {
    outcome: decision.outcome,
    code,
    item,
    line,
    otherJobs,
    shipment,
    recorded,
    handlingNotes: refForNotes ? (notes.get(handlingKey(refForNotes)) ?? []) : [],
  };
}

// --- Placed here ---------------------------------------------------------------------------

export type PlaceResult = {
  placed: LineView[];
  already: string[];
  blocked: { jobItemId: string; reason: string }[];
};

/** "Placed here": the crew put these lines in their destination. */
export async function placeLines(
  jobId: string,
  jobItemIds: string[],
  opts: { via?: string; code?: string | null; who: Who },
): Promise<PlaceResult> {
  const via = opts.via ?? VIA.scan;
  const result = await setLineStage(jobId, jobItemIds, "placed", {
    via,
    userOid: opts.who.userOid,
    actor: opts.who.name,
    note: "Placed at its destination",
  });
  await recordObservations(
    result.advanced.map((o) => ({
      jobId,
      jobItemId: o.jobItemId,
      itemId: o.itemId,
      unitId: o.unitId,
      code: opts.code ?? null,
      outcome: "placed" as const,
      expectedLocationId: o.destinationLocationId,
      actualLocationId: o.destinationLocationId,
      via,
      userOid: opts.who.userOid,
      actor: opts.who.name,
    })),
  );
  const job = await loadJob(jobId);
  const tree = await loadTree();
  const placed = await jobLines(jobId, tree, jobSettings(job).floorColors, {
    lineIds: result.advanced.map((o) => o.jobItemId),
  });
  return {
    placed,
    already: result.alreadyAt.map((o) => o.jobItemId),
    blocked: result.blocked.map((o) => ({ jobItemId: o.jobItemId, reason: o.reason })),
  };
}

/** Flag lines missing: the "missing after delivery" list's action. */
export async function markMissing(jobId: string, jobItemIds: string[], who: Who, note?: string | null) {
  const result = await setLineStage(jobId, jobItemIds, "missing", {
    via: VIA.manual,
    userOid: who.userOid,
    actor: who.name,
    note: note?.trim() || "Not found after delivery",
  });
  return {
    missing: result.advanced.length,
    already: result.alreadyAt.length,
    blocked: result.blocked.map((o) => ({ jobItemId: o.jobItemId, reason: o.reason })),
  };
}

// --- Rooms and sweeps ---------------------------------------------------------------------

export type RoomStatus = {
  room: Place & { floor: string | null; floorColor: string };
  nested: boolean;
  /** Lines whose destination is this room. */
  belongs: { total: number; placed: number };
  /** Of those, the ones not placed yet. */
  remaining: LineView[];
  /** Lines last found here that belong somewhere else. */
  extras: LineView[];
  extrasByDestination: { destination: Place | null; floor: string | null; floorColor: string; count: number }[];
  /** Lines going to places inside this one, which only count with `nested`. */
  nearby: number;
};

export function roomStatusOf(
  roomId: string,
  lines: readonly LineView[],
  tree: Tree,
  colors: Record<string, string>,
  nested: boolean,
): RoomStatus {
  const room = place(roomId, tree);
  if (!room) throw notFound("Location not found");
  const floor = floorOf(roomId, tree);
  const expected = lines.filter((l) => belongsIn(roomId, l, tree, nested));
  const extras = lines.filter((l) => l.stage === MISPLACED && l.lastActualId && within(l.lastActualId, roomId, tree));
  const groups = new Map<string, RoomStatus["extrasByDestination"][number]>();
  for (const l of extras) {
    const key = l.destinationLocationId ?? "";
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { destination: l.destination, floor: l.floor, floorColor: l.floorColor, count: 1 });
  }
  const nearby = nested
    ? 0
    : lines.filter(
        (l) => l.destinationLocationId && l.destinationLocationId !== roomId && within(l.destinationLocationId, roomId, tree),
      ).length;
  return {
    room: { ...room, floor, floorColor: floorColor(floor, colors) },
    nested,
    belongs: { total: expected.length, placed: expected.filter((l) => l.stage === "placed").length },
    remaining: expected.filter((l) => l.stage !== "placed"),
    extras,
    extrasByDestination: [...groups.values()].sort((a, b) => b.count - a.count),
    nearby,
  };
}

export async function roomStatus(jobId: string, roomId: string, opts: { nested?: boolean } = {}): Promise<RoomStatus> {
  const job = await loadJob(jobId);
  const tree = await loadTreeWith([roomId]);
  const { floorColors } = jobSettings(job);
  if (!tree.byId.has(roomId)) throw notFound("Location not found");
  const lines = await jobLines(jobId, tree, floorColors);
  return roomStatusOf(roomId, lines, tree, floorColors, Boolean(opts.nested));
}

export type SweepResultOutcome = SweepOutcome | "blocked";

export type SweepResultEntry = {
  code: string;
  outcome: SweepResultOutcome;
  line: LineView | null;
  item: ItemRef | null;
  otherJobs: OtherJob[];
  reason: string | null;
};

export type SweepResult = {
  entries: SweepResultEntry[];
  counts: Partial<Record<SweepResultOutcome, number>>;
  status: RoomStatus;
};

/**
 * A batch of codes read while sweeping one room: lines that belong here are
 * placed, lines that belong elsewhere are flagged misplaced with this room
 * noted, and the rest is reported. Send each batch as it is read; the room's
 * running totals come back with every answer.
 */
export async function sweep(
  jobId: string,
  opts: { locationId: string; codes: string[]; nested?: boolean; via?: string; who: Who },
): Promise<SweepResult> {
  const codes = uniqueCodes(opts.codes);
  if (codes.length > MAX_BATCH) throw badRequest(`Send at most ${MAX_BATCH} codes at a time.`);
  const job = await loadJob(jobId);
  const [tree, resolved] = await Promise.all([loadTreeWith([opts.locationId]), resolveScanCodes(codes)]);
  const room = place(opts.locationId, tree);
  if (!room) throw notFound("Location not found");
  const { floorColors } = jobSettings(job);
  const via = opts.via ?? VIA.sweep;
  const nested = Boolean(opts.nested);
  const roomText = pathText(room);

  const itemIds = [...new Set([...resolved.values()].flat().map((r) => r.itemId))];
  const before = await jobLines(jobId, tree, floorColors, { itemIds });
  const plan = planSweep(opts.locationId, codes, resolved, before, tree, { nested });
  const reasons = new Map<string, string>();
  const common = { userOid: opts.who.userOid, actor: opts.who.name };
  const observations: NewObservation[] = [];

  const apply = async (outcome: "placed" | typeof MISPLACED, note: string): Promise<AdvanceResult | null> => {
    const ids = plan.filter((e) => e.outcome === (outcome === "placed" ? "placed" : "misplaced")).map((e) => e.line!.id);
    if (!ids.length) return null;
    const result = await setLineStage(jobId, ids, outcome, { via, note, ...common });
    for (const b of result.blocked) reasons.set(b.jobItemId, b.reason);
    return result;
  };

  const placedResult = await apply("placed", `Found in ${roomText} during a sweep`);
  const misplacedResult = await apply(MISPLACED, `Found in ${roomText} during a sweep`);
  const byLine = new Map(before.map((l) => [l.id, l]));
  const codeOf = new Map(plan.filter((e) => e.line).map((e) => [e.line!.id, e.code]));

  for (const o of placedResult?.advanced ?? []) {
    observations.push({
      jobId,
      jobItemId: o.jobItemId,
      itemId: o.itemId,
      unitId: o.unitId,
      code: codeOf.get(o.jobItemId) ?? null,
      outcome: "placed",
      expectedLocationId: o.destinationLocationId,
      actualLocationId: opts.locationId,
      via,
      ...common,
    });
  }
  // A misplaced line is noted again only when it turned up in a new room.
  for (const o of [...(misplacedResult?.advanced ?? []), ...(misplacedResult?.alreadyAt ?? [])]) {
    const prior = byLine.get(o.jobItemId);
    if (prior?.stage === MISPLACED && prior.lastActualId === opts.locationId) continue;
    observations.push({
      jobId,
      jobItemId: o.jobItemId,
      itemId: o.itemId,
      unitId: o.unitId,
      code: codeOf.get(o.jobItemId) ?? null,
      outcome: "misplaced",
      expectedLocationId: o.destinationLocationId,
      actualLocationId: opts.locationId,
      via,
      ...common,
      note: `Found in ${roomText}`,
    });
  }

  const strangers = plan.filter((e) => e.outcome === "not_on_job");
  const strangerIds = [...new Set(strangers.map((e) => e.refs[0]!.itemId))];
  const [names, elsewhere] = await Promise.all([itemNames(strangerIds), others(strangerIds, jobId, tree)]);
  if (isOpenJob(job)) {
    for (const e of strangers) {
      const ref = e.refs[0]!;
      observations.push({
        jobId,
        itemId: ref.itemId,
        unitId: ref.unitId,
        code: e.code,
        outcome: "wrong_job",
        actualLocationId: opts.locationId,
        otherJobId: elsewhere.get(ref.itemId)?.[0]?.id ?? null,
        via,
        ...common,
      });
    }
  }
  await recordObservations(observations);

  const all = await jobLines(jobId, tree, floorColors);
  const after = new Map(all.map((l) => [l.id, l]));
  const entries: SweepResultEntry[] = plan.map((e) => {
    const line = e.line ? (after.get(e.line.id) ?? byLine.get(e.line.id) ?? null) : null;
    const reason = e.line ? (reasons.get(e.line.id) ?? null) : null;
    const ref = e.refs[0];
    const named = ref ? names.get(ref.itemId) : undefined;
    return {
      code: e.code,
      outcome: reason ? "blocked" : e.outcome,
      line,
      item: line
        ? itemOf(line)
        : named
          ? { id: named.id, name: named.name, assetCode: named.assetCode, unitId: ref!.unitId, unitCode: null }
          : null,
      otherJobs: e.outcome === "not_on_job" && ref ? (elsewhere.get(ref.itemId) ?? []) : [],
      reason,
    };
  });
  const counts: SweepResult["counts"] = {};
  for (const e of entries) counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
  logger.info("placement.sweep", { jobId, locationId: opts.locationId, codes: codes.length, ...counts });
  return { entries, counts, status: roomStatusOf(opts.locationId, all, tree, floorColors, nested) };
}
