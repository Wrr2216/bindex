import type {
  AuditLocationGroup,
  AuditResult,
  Company,
  Entity,
  Item,
  ItemDetail,
  ItemEvent,
  ItemUnit,
  Location,
  LocationDetail,
  VerifyResult,
} from "../../types";
import type { ActionBase, CachedItem, CodeRow, FieldAction, QueuedAction } from "./types";

/**
 * The offline copy answering the way the server would. Pure functions over
 * plain data: the caller reads from IndexedDB and hands the rows in. Each one
 * mirrors a server function, named alongside it, and says where it differs.
 */

// ---- Codes -----------------------------------------------------------------

export const codeKey = (code: string, itemId: string, unitId: string | null) =>
  `${code}\u0000${itemId}\u0000${unitId ?? ""}`;

/**
 * Every code that should resolve to this item, ranked in the order the server
 * tries them (services/items.ts getByIdentifier): identifiers, then the item's
 * printed code, then a unit's printed code, then a unit's serial. The server's
 * last resort, an unambiguous model number, is not kept offline.
 */
export function codesFor(item: CachedItem): CodeRow[] {
  const rows: CodeRow[] = [];
  const add = (raw: string | null | undefined, unitId: string | null, rank: number) => {
    const code = raw?.trim();
    if (!code) return;
    rows.push({ key: codeKey(code, item.id, unitId), code, itemId: item.id, unitId, rank, updatedAt: item.updatedAt });
  };
  for (const id of item.identifiers) add(id.value, null, 0);
  add(item.assetCode, null, 1);
  for (const u of item.units) add(u.assetCode, u.id, 2);
  for (const u of item.units) add(u.serial, u.id, 3);
  return rows;
}

/** One match for a scanned code: best rank, then the most recently changed item. */
export function pickMatch(rows: CodeRow[]): { itemId: string; unitId: string | null } | null {
  if (!rows.length) return null;
  const best = [...rows].sort((a, b) => a.rank - b.rank || b.updatedAt.localeCompare(a.updatedAt))[0]!;
  return { itemId: best.itemId, unitId: best.unitId };
}

// ---- What a change was made against ----------------------------------------

/** An open check-out's holder, encoded the way the planner compares them. */
export function holderOf(open: { entityId: string | null } | null | undefined): string | null {
  if (!open) return null;
  return open.entityId ?? "unknown";
}

const openAssignment = (item: CachedItem) => item.assignments.find((a) => a.checkedInAt === null) ?? null;

/** What the device believes now, recorded with a queued change. */
export function baseFor(action: FieldAction, item: CachedItem | undefined): ActionBase | null {
  if (!item) return null;
  const unit = action.unitId ? item.units.find((u) => u.id === action.unitId) : undefined;
  if (action.unitId && !unit) return null;
  switch (action.type) {
    case "move":
      return unit
        ? { locationId: unit.locationId }
        : { locationId: item.locationId, parentItemId: item.parentItemId };
    case "checkout":
    case "checkin":
      return { holderId: unit ? holderOf(unit.assignment) : holderOf(openAssignment(item)) };
    default:
      return null;
  }
}

// ---- Applying a change to the local copy -----------------------------------

type ApplyContext = { now: string; userName: string };

/**
 * The item as it will be once the change reaches the server, so the screens
 * show what the person just did. Returns a new object.
 */
export function applyToItem(item: CachedItem, action: FieldAction, ctx: ApplyContext, localId: string): CachedItem {
  const next: CachedItem = {
    ...item,
    units: item.units.map((u) => ({ ...u })),
    assignments: item.assignments.map((a) => ({ ...a })),
  };
  const unit = action.unitId ? next.units.find((u) => u.id === action.unitId) : undefined;
  const seenNow = () => {
    next.lastSpotCheckedAt = ctx.now;
    next.lastSpotCheckedBy = ctx.userName;
    next.flaggedMissing = false;
  };

  switch (action.type) {
    case "move":
      if (unit) {
        if (action.to && "locationId" in action.to) unit.locationId = action.to.locationId ?? null;
      } else {
        if (action.to && "locationId" in action.to) next.locationId = action.to.locationId ?? null;
        if (action.to && "parentItemId" in action.to) next.parentItemId = action.to.parentItemId ?? null;
      }
      break;
    case "checkout":
      if (unit) {
        unit.utilizedByEntityId = action.entityId ?? null;
        unit.assignment = {
          id: localId,
          entityId: action.entityId ?? null,
          entityName: action.entityName ?? "",
          checkedOutAt: ctx.now,
          note: null,
        };
      } else {
        for (const a of next.assignments) if (a.checkedInAt === null) a.checkedInAt = ctx.now;
        next.assignments.unshift({
          id: localId,
          entityId: action.entityId ?? null,
          entityName: action.entityName ?? "",
          checkedOutAt: ctx.now,
          checkedInAt: null,
          note: null,
        });
        next.utilizedByEntityId = action.entityId ?? null;
      }
      break;
    case "checkin":
      if (unit) {
        unit.utilizedByEntityId = null;
        unit.assignment = null;
      } else {
        for (const a of next.assignments) if (a.checkedInAt === null) a.checkedInAt = ctx.now;
        next.utilizedByEntityId = null;
      }
      break;
    case "spot_check":
      if (action.seen) seenNow();
      else next.flaggedMissing = true;
      break;
    case "verify_apply":
    case "audit_apply":
      if (action.seenIds?.includes(item.id)) seenNow();
      if (action.missingIds?.includes(item.id)) next.flaggedMissing = true;
      break;
    default:
      break;
  }
  if (action.type !== "note" && action.type !== "photo") next.updatedAt = ctx.now;
  return next;
}

/** The items a change writes to, for applying it locally. */
export function itemsTouched(action: FieldAction): string[] {
  if (action.type === "verify_apply" || action.type === "audit_apply") {
    return [...new Set([...(action.seenIds ?? []), ...(action.missingIds ?? [])])];
  }
  return action.itemId ? [action.itemId] : [];
}

// ---- Building server-shaped answers ----------------------------------------

export type Lookups = {
  locations: Map<string, Location>;
  entities: Map<string, Entity>;
  companies: Map<string, Company>;
};

const nameOf = <T extends { name: string }>(map: Map<string, T>, id: string | null | undefined) =>
  id ? (map.get(id)?.name ?? null) : null;

/** A cached item as a list row, with the names the server joins in. */
export function toItemRow(item: CachedItem, lk: Lookups): Item {
  const { identifiers: _i, units: _u, assignments: _a, images: _m, cachedAt: _c, ...row } = item;
  return {
    ...row,
    locationName: nameOf(lk.locations, item.locationId),
    companyName: nameOf(lk.companies, item.companyId),
    utilizedByEntityName: nameOf(lk.entities, item.utilizedByEntityId),
  };
}

const ACTION_WORDS: Record<FieldAction["type"], string> = {
  move: "moved",
  checkout: "checked out",
  checkin: "checked in",
  spot_check: "spot-checked",
  verify_apply: "verified",
  audit_apply: "audited",
  note: "note",
  photo: "photo",
};

/**
 * services/items.ts assemble(). History is not kept offline; changes still
 * waiting to sync stand in for it, so the person can see what is queued.
 */
export function toItemDetail(
  item: CachedItem,
  lk: Lookups,
  children: CachedItem[],
  queued: QueuedAction[],
  matchedUnitId: string | null = null,
): ItemDetail {
  const units: ItemUnit[] = item.units.map((u) => ({
    ...u,
    locationName: nameOf(lk.locations, u.locationId),
    utilizedByEntityName: nameOf(lk.entities, u.utilizedByEntityId),
  }));
  const events: ItemEvent[] = queued
    .filter((q) => itemsTouched(q.action).includes(item.id))
    .map((q) => ({
      id: q.id,
      action: `${ACTION_WORDS[q.action.type]}, waiting to sync`,
      detail: { offline: true, label: q.action.label },
      createdAt: q.createdAt,
      userOid: q.userOid,
    }))
    .reverse();
  return {
    ...toItemRow(item, lk),
    identifiers: item.identifiers,
    images: item.images,
    children: children.map((c) => toItemRow(c, lk)),
    events,
    assignments: item.assignments,
    units,
    matchedUnitId,
  };
}

/** Serials for a packing list: units' serials and serial-type identifiers. */
function serialsOf(item: CachedItem): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    const v = s?.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  for (const u of item.units) add(u.serial);
  for (const id of item.identifiers) if (id.type === "serial") add(id.value);
  return out;
}

/** services/locations.ts getLocationDetail(), over the items this device holds. */
export function toLocationDetail(
  loc: Location,
  lk: Lookups,
  allLocations: Location[],
  items: CachedItem[],
): LocationDetail {
  const here = items
    .filter((i) => i.locationId === loc.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const i of items) if (i.locationId) counts.set(i.locationId, (counts.get(i.locationId) ?? 0) + 1);
  const contents = here.map((i) => ({
    id: i.id,
    name: i.name,
    brand: i.brand,
    model: i.model,
    assetCode: i.assetCode,
    quantity: i.quantity,
    flaggedMissing: i.flaggedMissing,
    serials: serialsOf(i),
  }));
  return {
    ...loc,
    companyName: nameOf(lk.companies, loc.companyId),
    parentName: nameOf(lk.locations, loc.parentId),
    contents,
    itemCount: contents.length,
    totalUnits: contents.reduce((n, c) => n + c.quantity, 0),
    children: allLocations
      .filter((l) => l.parentId === loc.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({ id: l.id, name: l.name, itemCount: counts.get(l.id) ?? 0 })),
  };
}

type Resolve = (code: string) => { itemId: string } | null;

const uniqueCodes = (raw: string[]) => [...new Set(raw.map((c) => c.trim()).filter(Boolean))];

/** services/verify.ts verifyLocation(), against the items this device holds. */
export function verifyLocal(
  locationId: string,
  rawCodes: string[],
  items: CachedItem[],
  lk: Lookups,
  resolve: Resolve,
): VerifyResult {
  const codes = uniqueCodes(rawCodes);
  const expected = items
    .filter((i) => i.locationId === locationId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((i) => ({ id: i.id, name: i.name, assetCode: i.assetCode }));
  const expectedIds = new Set(expected.map((e) => e.id));
  const matched = new Set<string>();
  const unresolved: string[] = [];
  for (const c of codes) {
    const hit = resolve(c);
    if (hit) matched.add(hit.itemId);
    else unresolved.push(c);
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    present: expected.filter((e) => matched.has(e.id)),
    missing: expected.filter((e) => !matched.has(e.id)),
    unexpected: [...matched]
      .filter((id) => !expectedIds.has(id))
      .map((id) => byId.get(id))
      .filter((i): i is CachedItem => Boolean(i))
      .map((i) => ({
        id: i.id,
        name: i.name,
        assetCode: i.assetCode,
        locationName: nameOf(lk.locations, i.locationId),
      })),
    unresolved,
  };
}

/**
 * services/verify.ts auditReconcile(). Offline, "everything" means everything
 * this device holds: an item that was never taken offline is neither seen nor
 * missing, and its code shows up as unknown.
 */
export function auditLocal(
  rawCodes: string[],
  items: CachedItem[],
  lk: Lookups,
  resolve: Resolve,
  companyId?: string,
): AuditResult {
  const codes = uniqueCodes(rawCodes);
  const matched = new Set<string>();
  const unknownCodes: string[] = [];
  for (const c of codes) {
    const hit = resolve(c);
    if (hit) matched.add(hit.itemId);
    else unknownCodes.push(c);
  }
  const rows = companyId
    ? items.filter((i) => i.locationId && lk.locations.get(i.locationId)?.companyId === companyId)
    : items;

  const groups = new Map<string, AuditLocationGroup>();
  const seenIds: string[] = [];
  for (const r of rows) {
    const key = r.locationId ?? "__none";
    let g = groups.get(key);
    if (!g) {
      g = {
        locationId: r.locationId,
        locationName: nameOf(lk.locations, r.locationId),
        total: 0,
        seen: 0,
        missing: [],
      };
      groups.set(key, g);
    }
    g.total += 1;
    if (matched.has(r.id)) {
      g.seen += 1;
      seenIds.push(r.id);
    } else {
      g.missing.push({ id: r.id, name: r.name, assetCode: r.assetCode });
    }
  }
  return {
    totalItems: rows.length,
    seenItems: seenIds.length,
    missingItems: rows.length - seenIds.length,
    seenIds,
    unknownCodes,
    locations: [...groups.values()].sort((a, b) =>
      (a.locationName ?? "~").localeCompare(b.locationName ?? "~"),
    ),
  };
}

/** An ItemDetail from the server, reduced to what this device keeps. */
export function fromItemDetail(detail: ItemDetail, cachedAt: string): CachedItem {
  const {
    children: _children,
    events: _events,
    matchedUnitId: _matched,
    locationName: _l,
    companyName: _c,
    utilizedByEntityName: _u,
    ...rest
  } = detail;
  return {
    ...rest,
    units: detail.units.map(({ locationName: _ln, utilizedByEntityName: _un, ...u }) => u),
    // Only open check-outs are kept, as the snapshot does.
    assignments: detail.assignments.filter((a) => a.checkedInAt === null),
    cachedAt,
  };
}
