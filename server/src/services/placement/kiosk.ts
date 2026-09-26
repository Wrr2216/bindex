import { candidatesFor, type ScanRef } from "../jobs-core";
import { getDeviceRow, getFeed, readSettings, type SightingDirection } from "../tracking";
import { floorColor } from "./colors";
import { jobLines, jobSettings, loadJob, loadTree, otherOpenJobs, place, type LineView, type Place } from "./data";
import { handlingKey, handlingNotesFor } from "./handling";
import { lookup, type Who } from "./scan";
import { relation, type Tree } from "./tree";

/**
 * The kiosk: a tablet on a tripod at a floor entrance, next to a door
 * portal, listing what just went through and where each thing goes. It reads
 * the tracking core's live feed (one device, or all of them) and matches each
 * read to the job's lines; it never changes anything.
 */

export type KioskOutcome =
  /** Its destination is behind this entrance. */
  | "this_way"
  /** It goes somewhere this entrance does not lead: the floor on the entry says where. */
  | "elsewhere"
  /** On this job with no destination on the plan. */
  | "no_destination"
  /** Already placed. */
  | "placed"
  /** A known item this job does not move. */
  | "not_on_job"
  /** No zone to compare with: just where it goes. */
  | "info";

export type KioskEntry = {
  id: number;
  at: string;
  direction: SightingDirection | null;
  deviceName: string | null;
  code: string | null;
  outcome: KioskOutcome;
  itemId: string;
  itemName: string;
  unitId: string | null;
  line: LineView | null;
  otherJobs: { id: string; code: string; name: string; destination: Place | null; floor: string | null; floorColor: string }[];
  handlingNotes: string[];
};

export type KioskPage = {
  cursor: number;
  /** What "this way" is measured against: the picked zone, or the device's. */
  zone: Place | null;
  entries: KioskEntry[];
  /** Reads in this page of tags that resolve to nothing. */
  unknown: number;
};

/** The zone a device covers: its own, or for a portal, the side it lets in to. */
function deviceZone(device: Awaited<ReturnType<typeof getDeviceRow>>): string | null {
  const settings = readSettings(device.settings);
  return settings.portal?.inLocationId ?? device.locationId ?? null;
}

export function kioskOutcome(line: LineView | null, zoneId: string | null, tree: Tree): KioskOutcome {
  if (!line) return "not_on_job";
  if (line.stage === "placed") return "placed";
  if (!line.destinationLocationId) return "no_destination";
  if (!zoneId) return "info";
  return relation(zoneId, line.destinationLocationId, tree) === "apart" ? "elsewhere" : "this_way";
}

/**
 * Reads since `since` (the latest few without it), each matched to the job.
 * `locationId` overrides the zone the device covers.
 */
export async function kioskFeed(
  jobId: string,
  opts: { deviceId?: string; locationId?: string; since?: number },
): Promise<KioskPage> {
  const job = await loadJob(jobId);
  const tree = await loadTree();
  const { floorColors } = jobSettings(job);
  const device = opts.deviceId ? await getDeviceRow(opts.deviceId) : null;
  const zoneId = opts.locationId ?? (device ? deviceZone(device) : null);

  const page = await getFeed({
    since: opts.since,
    deviceId: opts.deviceId,
    limit: opts.since === undefined ? 25 : 500,
  });
  const seen = page.sightings.filter((s) => s.itemId);
  const itemIds = [...new Set(seen.map((s) => s.itemId!))];
  const [lines, elsewhere] = await Promise.all([
    jobLines(jobId, tree, floorColors, { itemIds }),
    otherOpenJobs(itemIds, jobId, tree),
  ]);
  const refs: ScanRef[] = seen.map((s) => ({ itemId: s.itemId!, unitId: s.unitId }));
  const notes = await handlingNotesFor(refs);

  const entries: KioskEntry[] = seen.map((s) => {
    const ref = { itemId: s.itemId!, unitId: s.unitId };
    // The tag's own line when it has one; a portal cannot tell units apart
    // otherwise, so the first line not yet placed stands in.
    const candidates = candidatesFor(ref, lines) as LineView[];
    const line = candidates.find((l) => l.stage !== "placed") ?? candidates[0] ?? null;
    const others = line ? [] : (elsewhere.get(ref.itemId) ?? []);
    return {
      id: s.id,
      at: s.observedAt,
      direction: s.direction,
      deviceName: s.deviceName,
      code: s.code,
      outcome: kioskOutcome(line, zoneId, tree),
      itemId: ref.itemId,
      itemName: s.itemName ?? "",
      unitId: ref.unitId,
      line,
      otherJobs: [...new Map(others.map((o) => [o.id, { ...o, floorColor: floorColor(o.floor) }])).values()],
      handlingNotes: notes.get(handlingKey(ref)) ?? [],
    };
  });
  return {
    cursor: page.cursor,
    zone: place(zoneId, tree),
    entries,
    unknown: page.sightings.length - seen.length,
  };
}

/**
 * A label scanned at the kiosk tablet, answered the way a portal read is.
 * Only looks: nothing is flagged or noted. Null for a code that names nothing.
 */
export async function kioskScan(
  jobId: string,
  code: string,
  opts: { deviceId?: string; locationId?: string; who: Who },
): Promise<KioskEntry | null> {
  const card = await lookup(jobId, code, { record: false, who: opts.who });
  if (!card.item) return null;
  const tree = await loadTree();
  const device = opts.deviceId ? await getDeviceRow(opts.deviceId) : null;
  const zoneId = opts.locationId ?? (device ? deviceZone(device) : null);
  return {
    id: 0,
    at: new Date().toISOString(),
    direction: null,
    deviceName: null,
    code: card.code,
    outcome: card.outcome === "not_on_job" ? "not_on_job" : kioskOutcome(card.line, zoneId, tree),
    itemId: card.item.id,
    itemName: card.item.name,
    unitId: card.item.unitId,
    line: card.line,
    otherJobs: card.otherJobs,
    handlingNotes: card.handlingNotes,
  };
}
