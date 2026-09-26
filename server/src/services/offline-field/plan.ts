/**
 * Which queued offline changes can be sent now, in what order, and which need
 * a person to decide.
 *
 * A device queues changes while it has no connection, each recording what the
 * device believed the record looked like at the time (its "base"). When the
 * device reconnects it sends the whole queue here first, and this decides, one
 * change at a time and oldest first, against the server's current state:
 *
 * - send      nothing has changed underneath it; replay the request.
 * - skip      the server is already in the state the change wanted, and
 *             sending it would duplicate history or fail. Reported, not sent.
 * - conflict  the record moved, changed hands or was deleted since the device
 *             cached it. A person chooses keep-mine or keep-server.
 * - blocked   an earlier change to the same item or unit is waiting on a
 *             person, and this one must not overtake it.
 * - held      the device already has this one waiting on a person.
 *
 * Changes to the same item or unit are kept in the order they were made.
 * Bulk results (a location verification, a building audit) are observations
 * of what was on the shelf; they never wait on, or hold up, anything else.
 *
 * Pure: the caller loads the current state (world.ts) and applies nothing.
 */

export type PlanActionType =
  | "move"
  | "checkout"
  | "checkin"
  | "spot_check"
  | "verify_apply"
  | "audit_apply"
  | "note"
  | "photo";

/** What the device believed when it queued the change. Null: it did not know. */
export type ActionBase = {
  locationId?: string | null;
  parentItemId?: string | null;
  /** Open check-out: holder id, "unknown" for a deleted holder, null for none. */
  holderId?: string | null;
};

export type PlanAction = {
  /** The device's id for the queued change. */
  id: string;
  /** Creation order on the device. Oldest is planned first. */
  seq: number;
  type: PlanActionType;
  itemId?: string | null;
  unitId?: string | null;
  /** The location a verification was of. */
  locationId?: string | null;
  /** Who a check-out is to. */
  entityId?: string | null;
  /** Where a move goes. Only the fields being changed are present. */
  to?: { locationId?: string | null; parentItemId?: string | null };
  base?: ActionBase | null;
  /** Every item a verification or audit writes to. */
  itemIds?: string[];
  /** The person chose keep-mine: skip the changed-since checks. */
  force?: boolean;
  /** Already waiting on a person on the device. */
  held?: boolean;
};

export type ConflictCode =
  | "deleted"
  | "destination_deleted"
  | "holder_deleted"
  | "items_deleted"
  | "moved"
  | "holder_changed";

export type PlanResult =
  | { id: string; verdict: "send" }
  | { id: string; verdict: "skip"; reason: string }
  | {
      id: string;
      verdict: "conflict";
      code: ConflictCode;
      reason: string;
      /** False when the change cannot be applied at all, such as to a deleted record. */
      canKeepMine: boolean;
      /** For items_deleted: the ids to leave out if the person keeps theirs. */
      missingItemIds?: string[];
    }
  | { id: string; verdict: "blocked"; reason: string; blockedBy: string }
  | { id: string; verdict: "held" };

export type WorldItem = {
  name: string;
  locationId: string | null;
  parentItemId: string | null;
  /** The container's name, for messages. */
  parentName?: string | null;
  holderId: string | null;
  holderName: string | null;
};

export type WorldUnit = {
  itemId: string;
  name: string;
  locationId: string | null;
  holderId: string | null;
  holderName: string | null;
};

/** The server's current state for everything the queue refers to. */
export type World = {
  items: Map<string, WorldItem>;
  units: Map<string, WorldUnit>;
  locations: Map<string, { name: string }>;
  entities: Map<string, { name: string }>;
};

/** Words for the records, from the instance vocabulary, in lower case. */
export type PlanTerms = { item: string; items: string; location: string; holder: string };

const DEFAULT_TERMS: PlanTerms = { item: "item", items: "items", location: "location", holder: "assignee" };

/** Every id the planner will need to look up. Drives world.ts. */
export function referencedIds(actions: PlanAction[]) {
  const items = new Set<string>();
  const units = new Set<string>();
  const locations = new Set<string>();
  const entities = new Set<string>();
  for (const a of actions) {
    if (a.itemId) items.add(a.itemId);
    if (a.unitId) units.add(a.unitId);
    if (a.locationId) locations.add(a.locationId);
    if (a.entityId) entities.add(a.entityId);
    if (a.to?.locationId) locations.add(a.to.locationId);
    if (a.to?.parentItemId) items.add(a.to.parentItemId);
    for (const id of a.itemIds ?? []) items.add(id);
  }
  return { items: [...items], units: [...units], locations: [...locations], entities: [...entities] };
}

/** The record a change is ordered against: its unit when it has one, else its item. */
function subjectOf(a: PlanAction): string | null {
  if (a.type === "verify_apply" || a.type === "audit_apply") return null;
  if (a.unitId) return `unit:${a.unitId}`;
  if (a.itemId) return `item:${a.itemId}`;
  return null;
}

/** Oldest first; the order the device sent them breaks ties. */
export function orderForSync(actions: PlanAction[]): PlanAction[] {
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.seq - y.a.seq || x.i - y.i)
    .map(({ a }) => a);
}


function cloneWorld(world: World): World {
  return {
    items: new Map([...world.items].map(([k, v]) => [k, { ...v }])),
    units: new Map([...world.units].map(([k, v]) => [k, { ...v }])),
    locations: world.locations,
    entities: world.entities,
  };
}

type Evaluated =
  | { verdict: "send" }
  | { verdict: "skip"; reason: string }
  | Omit<Extract<PlanResult, { verdict: "conflict" }>, "id">;

function evaluate(a: PlanAction, world: World, terms: PlanTerms): Evaluated {
  const deleted = (what: string): Evaluated => ({
    verdict: "conflict",
    code: "deleted",
    reason: `This ${what} was deleted on the server.`,
    canKeepMine: false,
  });

  // The record the change is about, as the server has it now (and as earlier
  // changes in this same plan will leave it).
  const unit = a.unitId ? world.units.get(a.unitId) : undefined;
  const item = a.itemId ? world.items.get(a.itemId) : undefined;
  const needsItem = a.type !== "verify_apply" && a.type !== "audit_apply";
  if (needsItem) {
    if (a.unitId && !unit) return deleted("unit");
    if (!a.unitId && !item) return deleted(terms.item);
  }
  const subject = unit ?? item;

  switch (a.type) {
    case "move": {
      if (!subject) return deleted(terms.item);
      const to = a.to ?? {};
      if (to.locationId && !world.locations.has(to.locationId)) {
        return {
          verdict: "conflict",
          code: "destination_deleted",
          reason: `The ${terms.location} it was being moved to was deleted on the server.`,
          canKeepMine: false,
        };
      }
      if (to.parentItemId && !world.items.has(to.parentItemId)) {
        return {
          verdict: "conflict",
          code: "destination_deleted",
          reason: "The container it was being moved into was deleted on the server.",
          canKeepMine: false,
        };
      }
      if (!a.force && a.base) {
        const movedLocation =
          "locationId" in to &&
          a.base.locationId !== undefined &&
          subject.locationId !== a.base.locationId &&
          subject.locationId !== to.locationId;
        const movedParent =
          "parentItemId" in to &&
          !unit &&
          item &&
          a.base.parentItemId !== undefined &&
          item.parentItemId !== a.base.parentItemId &&
          item.parentItemId !== to.parentItemId;
        if (movedLocation || movedParent) {
          let what: string;
          if (movedLocation) {
            what = subject.locationId
              ? `Moved to ${world.locations.get(subject.locationId)?.name ?? `another ${terms.location}`}`
              : `Taken out of its ${terms.location}`;
          } else {
            what = item?.parentItemId
              ? `Put inside ${item.parentName ?? world.items.get(item.parentItemId)?.name ?? "another container"}`
              : "Taken out of its container";
          }
          return {
            verdict: "conflict",
            code: "moved",
            reason: `${what} on the server after this device saved its change.`,
            canKeepMine: true,
          };
        }
      }
      return { verdict: "send" };
    }

    case "checkout": {
      if (!subject) return deleted(terms.item);
      if (!a.entityId || !world.entities.has(a.entityId)) {
        return {
          verdict: "conflict",
          code: "holder_deleted",
          reason: `The ${terms.holder} it was being checked out to was deleted on the server.`,
          canKeepMine: false,
        };
      }
      if (subject.holderId === a.entityId) {
        return {
          verdict: "skip",
          reason: `Already checked out to ${world.entities.get(a.entityId)!.name} on the server.`,
        };
      }
      if (!a.force && a.base && a.base.holderId !== undefined && subject.holderId !== a.base.holderId) {
        return {
          verdict: "conflict",
          code: "holder_changed",
          reason: subject.holderId
            ? `Checked out to ${subject.holderName ?? "someone else"} on the server after this device saved its change.`
            : "Checked in on the server after this device saved its change.",
          canKeepMine: true,
        };
      }
      return { verdict: "send" };
    }

    case "checkin": {
      if (!subject) return deleted(terms.item);
      if (subject.holderId === null) {
        return { verdict: "skip", reason: "Already checked in on the server." };
      }
      if (!a.force && a.base && a.base.holderId !== undefined && subject.holderId !== a.base.holderId) {
        return {
          verdict: "conflict",
          code: "holder_changed",
          reason: `Checked out to ${subject.holderName ?? "someone else"} on the server after this device saved its change.`,
          canKeepMine: true,
        };
      }
      return { verdict: "send" };
    }

    case "spot_check":
    case "note":
    case "photo":
      return { verdict: "send" };

    case "verify_apply":
    case "audit_apply": {
      if (a.type === "verify_apply" && (!a.locationId || !world.locations.has(a.locationId))) {
        return deleted(terms.location);
      }
      const missingItemIds = (a.itemIds ?? []).filter((id) => !world.items.has(id));
      if (missingItemIds.length) {
        return {
          verdict: "conflict",
          code: "items_deleted",
          reason: `${missingItemIds.length} of the ${terms.items} in this check ${
            missingItemIds.length === 1 ? "was" : "were"
          } deleted on the server. Keep yours to send it without them.`,
          canKeepMine: true,
          missingItemIds,
        };
      }
      return { verdict: "send" };
    }
  }
}

/** What the server will look like after a change goes through. */
function simulate(a: PlanAction, world: World): void {
  const subject = a.unitId ? world.units.get(a.unitId) : a.itemId ? world.items.get(a.itemId) : undefined;
  if (!subject) return;
  switch (a.type) {
    case "move":
      if (a.to && "locationId" in a.to) subject.locationId = a.to.locationId ?? null;
      if (a.to && "parentItemId" in a.to && !a.unitId) {
        const moved = subject as WorldItem;
        moved.parentItemId = a.to.parentItemId ?? null;
        moved.parentName = (moved.parentItemId && world.items.get(moved.parentItemId)?.name) || null;
      }
      return;
    case "checkout":
      subject.holderId = a.entityId ?? null;
      subject.holderName = (a.entityId && world.entities.get(a.entityId)?.name) || null;
      return;
    case "checkin":
      subject.holderId = null;
      subject.holderName = null;
      return;
    default:
      return;
  }
}

export function planSync(
  actions: PlanAction[],
  current: World,
  terms: PlanTerms = DEFAULT_TERMS,
): PlanResult[] {
  const world = cloneWorld(current);
  // Subject -> the id of the change that is holding it up.
  const blocked = new Map<string, string>();
  const results: PlanResult[] = [];

  for (const a of orderForSync(actions)) {
    const subject = subjectOf(a);
    const blocker = subject ? blocked.get(subject) : undefined;

    if (a.held) {
      if (subject && !blocker) blocked.set(subject, a.id);
      results.push({ id: a.id, verdict: "held" });
      continue;
    }
    if (blocker) {
      results.push({
        id: a.id,
        verdict: "blocked",
        reason: "Waiting for an earlier change to the same record to be resolved.",
        blockedBy: blocker,
      });
      continue;
    }

    const outcome = evaluate(a, world, terms);
    if (outcome.verdict === "conflict") {
      if (subject) blocked.set(subject, a.id);
      results.push({ id: a.id, ...outcome });
      continue;
    }
    simulate(a, world);
    results.push({ id: a.id, ...outcome });
  }
  return results;
}
