import { haversineM } from "./geo";
import { RULES, type OpsSettings, type RuleId, type Severity } from "./model";
import type { PlaceIndex } from "./places";
import { formatDistance, formatDuration, identityKey, labelOf, nameKey } from "./text";

/**
 * The anomaly rules. Each is a pure function from facts (gathered by
 * gather.ts with plain SQL) to findings, so every rule can be tested with a
 * fixture and no database. docs/ops-intel.md states each rule in words; keep
 * the two in step.
 *
 * Titles avoid the words for the configurable concepts ("item", "location"),
 * because an instance may call them something else; they use names and codes.
 */

export type Finding = {
  rule: RuleId;
  /** Identifies the problem within the rule: the same key on the next run is the same problem. */
  key: string;
  severity: Severity;
  subjectType: "job_item" | "item" | "location";
  subjectId: string;
  itemId: string | null;
  unitId: string | null;
  jobId: string | null;
  shipmentId: string | null;
  locationId: string | null;
  title: string;
  detail: Record<string, unknown>;
  /** App path of the screen where it gets fixed. */
  link: string | null;
  sticky: boolean;
  /** For sticky findings: when the event happened. */
  occurredAt: Date | null;
};

export type RuleContext = { now: Date; places: PlaceIndex; settings: OpsSettings };

// --- Facts -------------------------------------------------------------------

/** A manifest line at packed, loaded or delivered, with its job and shipment. */
export type StageLineFact = {
  jobItemId: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  /** Whether the job places things: it has a place task, or a line already placed. */
  jobUsesPlacement: boolean;
  jobShipmentCount: number;
  /** Shipments on the job that are in transit, delivered or closed. */
  jobShipmentsLeft: number;
  shipmentId: string | null;
  shipmentCode: string | null;
  shipmentStatus: string | null;
  shipmentArrivedAt: Date | null;
  stage: string;
  stageAt: Date;
  itemId: string;
  unitId: string | null;
  name: string;
  code: string | null;
};

/** A line on an open shipment of an open job. */
export type ShipmentLineFact = {
  jobItemId: string;
  jobId: string;
  jobCode: string;
  shipmentId: string;
  shipmentCode: string;
  shipmentStatus: string;
  itemId: string;
  unitId: string | null;
  name: string;
  code: string | null;
};

/** An identifier that names one physical thing: serial, asset tag, MAC, RFID, or a unit's serial. */
export type IdentityFact = {
  itemId: string;
  unitId: string | null;
  type: string;
  value: string;
  name: string;
  code: string | null;
};

export type RecordFact = {
  itemId: string;
  name: string;
  brand: string | null;
  model: string | null;
  locationId: string;
  code: string | null;
  /** Serials on the record and its units, as written. */
  serials: string[];
};

export type SightingEnd = {
  sightingId: number;
  at: Date;
  locationId: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
};

/** Two consecutive reads of one asset. */
export type TransitionFact = {
  itemId: string;
  unitId: string | null;
  name: string;
  code: string | null;
  from: SightingEnd;
  to: SightingEnd;
};

/** An asset's latest position, with where its record says it is. */
export type PositionFact = {
  itemId: string;
  unitId: string | null;
  name: string;
  code: string | null;
  zoneId: string | null;
  enteredAt: Date | null;
  observedAt: Date;
  recordedLocationId: string | null;
  /** When the record (the item, or the unit for a unit's position) last changed. */
  recordChangedAt: Date | null;
  /** The item, and the unit when there is one, are both active. */
  active: boolean;
  /** Checked out to someone, so not expected in front of a reader. */
  checkedOut: boolean;
};

// --- Helpers -----------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const base = (rule: RuleId) => ({ rule, sticky: RULES[rule].sticky, occurredAt: null as Date | null });

const lineFinding = (
  rule: RuleId,
  l: StageLineFact,
  severity: Severity,
  title: string,
  detail: Record<string, unknown>,
): Finding => ({
  ...base(rule),
  key: l.jobItemId,
  severity,
  subjectType: "job_item",
  subjectId: l.jobItemId,
  itemId: l.itemId,
  unitId: l.unitId,
  jobId: l.jobId,
  shipmentId: l.shipmentId,
  locationId: null,
  title,
  detail: {
    jobCode: l.jobCode,
    jobName: l.jobName,
    shipmentCode: l.shipmentCode,
    shipmentStatus: l.shipmentStatus,
    stage: l.stage,
    stageAt: l.stageAt.toISOString(),
    name: l.name,
    code: l.code,
    ...detail,
  },
  link: `/jobs/${l.jobId}`,
});

const assetKey = (itemId: string, unitId: string | null) => `${itemId}:${unitId ?? "-"}`;

// --- Rules -------------------------------------------------------------------

/** Loaded means the doors are shut on it; in transit and later means it left. */
const SHIPMENT_LOADED = new Set(["loaded", "in_transit", "delivered", "closed"]);
const SHIPMENT_LEFT = new Set(["in_transit", "delivered", "closed"]);

export function packedNotLoaded(lines: StageLineFact[]): Finding[] {
  const out: Finding[] = [];
  for (const l of lines) {
    if (l.stage !== "packed") continue;
    const label = labelOf(l.name, l.code);
    if (l.shipmentId) {
      if (!l.shipmentStatus || !SHIPMENT_LOADED.has(l.shipmentStatus)) continue;
      const left = SHIPMENT_LEFT.has(l.shipmentStatus);
      out.push(
        lineFinding(
          "packed_not_loaded",
          l,
          left ? "high" : "medium",
          left
            ? `${label} is packed but ${l.shipmentCode} left without it`
            : `${label} is packed but ${l.shipmentCode} is already loaded`,
          { reason: left ? "shipment_left" : "shipment_loaded" },
        ),
      );
    } else if (l.jobShipmentCount > 0 && l.jobShipmentsLeft >= l.jobShipmentCount) {
      out.push(
        lineFinding(
          "packed_not_loaded",
          l,
          "high",
          `${label} is packed but every shipment on ${l.jobCode} has left`,
          { reason: "all_shipments_left", shipments: l.jobShipmentCount },
        ),
      );
    }
  }
  return out;
}

export function loadedNotDelivered(lines: StageLineFact[], ctx: RuleContext): Finding[] {
  const { graceMinutes } = ctx.settings.rules.loaded_not_delivered;
  const out: Finding[] = [];
  for (const l of lines) {
    if (l.stage !== "loaded" || !l.shipmentId) continue;
    if (l.shipmentStatus !== "delivered" && l.shipmentStatus !== "closed") continue;
    const arrived = l.shipmentArrivedAt ?? l.stageAt;
    const waited = ctx.now.getTime() - arrived.getTime();
    if (waited < graceMinutes * 60_000) continue;
    out.push(
      lineFinding(
        "loaded_not_delivered",
        l,
        "high",
        `${labelOf(l.name, l.code)} is still loaded on ${l.shipmentCode}, delivered ${formatDuration(waited)} ago`,
        { arrivedAt: arrived.toISOString(), threshold: { graceMinutes } },
      ),
    );
  }
  return out;
}

export function deliveredNotPlaced(lines: StageLineFact[], ctx: RuleContext): Finding[] {
  const { hours } = ctx.settings.rules.delivered_not_placed;
  const out: Finding[] = [];
  for (const l of lines) {
    if (l.stage !== "delivered" || !l.jobUsesPlacement) continue;
    const waited = ctx.now.getTime() - l.stageAt.getTime();
    if (waited < hours * HOUR) continue;
    out.push(
      lineFinding(
        "delivered_not_placed",
        l,
        "medium",
        `${labelOf(l.name, l.code)} was delivered ${formatDuration(waited)} ago on ${l.jobCode} and is not placed`,
        { threshold: { hours } },
      ),
    );
  }
  return out;
}

const OPEN_IN_VEHICLE = new Set(["loaded", "in_transit"]);

export function multiShipment(lines: ShipmentLineFact[]): Finding[] {
  const byItem = new Map<string, ShipmentLineFact[]>();
  for (const l of lines) {
    const list = byItem.get(l.itemId) ?? [];
    list.push(l);
    byItem.set(l.itemId, list);
  }
  const out: Finding[] = [];
  for (const [itemId, list] of byItem) {
    // A whole-item line clashes with any line for the item; two unit lines
    // clash only when they are for the same unit.
    const clashing = new Set<ShipmentLineFact>();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.shipmentId === b.shipmentId) continue;
        if (a.unitId === null || b.unitId === null || a.unitId === b.unitId) {
          clashing.add(a);
          clashing.add(b);
        }
      }
    }
    if (!clashing.size) continue;
    const involved = [...clashing].sort((a, b) => a.shipmentCode.localeCompare(b.shipmentCode));
    const shipments = [...new Map(involved.map((l) => [l.shipmentId, l])).values()];
    const inVehicles = shipments.filter((l) => OPEN_IN_VEHICLE.has(l.shipmentStatus)).length;
    const first = involved[0]!;
    const units = new Set(involved.map((l) => l.unitId));
    const unitId = units.size === 1 ? first.unitId : null;
    out.push({
      ...base("multi_shipment"),
      key: itemId,
      severity: inVehicles >= 2 ? "high" : "medium",
      subjectType: "item",
      subjectId: itemId,
      itemId,
      unitId,
      jobId: first.jobId,
      shipmentId: first.shipmentId,
      locationId: null,
      title: `${labelOf(first.name, first.code)} is on ${shipments.length} open shipments: ${shipments
        .map((l) => `${l.shipmentCode} (${l.jobCode})`)
        .join(", ")}`,
      detail: {
        name: first.name,
        code: first.code,
        lines: involved.map((l) => ({
          jobItemId: l.jobItemId,
          jobId: l.jobId,
          jobCode: l.jobCode,
          shipmentId: l.shipmentId,
          shipmentCode: l.shipmentCode,
          shipmentStatus: l.shipmentStatus,
          unitId: l.unitId,
        })),
      },
      link: `/jobs/${first.jobId}`,
    });
  }
  return out;
}

/**
 * Values people type when there is no serial, and the BIOS placeholder a
 * device-management sync brings in. A thousand records "sharing" N/A is not a
 * duplicate.
 */
export const PLACEHOLDER_IDENTITIES = [
  "NA",
  "NONE",
  "NULL",
  "NIL",
  "UNK",
  "UNKNOWN",
  "TBD",
  "TBA",
  "NOSERIAL",
  "NOTAVAILABLE",
  "NOTAPPLICABLE",
  "DEFAULT",
  "DEFAULTSTRING",
  "TOBEFILLEDBYOEM",
  "SYSTEMSERIALNUMBER",
  "CHASSISSERIALNUMBER",
  "123456789",
];
const PLACEHOLDERS = new Set(PLACEHOLDER_IDENTITIES);

export const isPlaceholderIdentity = (key: string): boolean =>
  key.length < 3 || PLACEHOLDERS.has(key) || /^(.)\1*$/.test(key);

/** Unit serials and serial identifiers are the same kind of thing. */
const identityClass = (type: string) => (type === "unit_serial" ? "serial" : type);

const MAX_LISTED = 20;

export function duplicateIdentifier(facts: IdentityFact[]): Finding[] {
  const groups = new Map<string, IdentityFact[]>();
  for (const f of facts) {
    const key = identityKey(f.value);
    if (isPlaceholderIdentity(key)) continue;
    const g = `${identityClass(f.type)}:${key}`;
    const list = groups.get(g) ?? [];
    list.push(f);
    groups.set(g, list);
  }
  const out: Finding[] = [];
  for (const [groupKey, list] of groups) {
    const items = new Set(list.map((f) => f.itemId));
    const units = new Set(list.filter((f) => f.unitId).map((f) => f.unitId));
    // An item and one of its own units carrying the same serial is one thing
    // written down twice, not two things.
    if (items.size < 2 && units.size < 2) continue;
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name) || a.itemId.localeCompare(b.itemId));
    const values = [...new Set(sorted.map((f) => f.value.trim()))];
    const exact = values.length === 1;
    const first = sorted[0]!;
    const type = identityClass(first.type).replace(/_/g, " ");
    const names = sorted.slice(0, 3).map((f) => labelOf(f.name, f.code));
    const more = sorted.length > 3 ? ` and ${sorted.length - 3} more` : "";
    out.push({
      ...base("duplicate_identifier"),
      key: groupKey,
      severity: exact ? "high" : "medium",
      subjectType: "item",
      subjectId: first.itemId,
      itemId: first.itemId,
      unitId: first.unitId,
      jobId: null,
      shipmentId: null,
      locationId: null,
      title: exact
        ? `The ${type} ${values[0]} is on ${sorted.length} records: ${names.join(", ")}${more}`
        : `The ${type} ${values.slice(0, 3).join(" / ")} differs only by formatting across ${names.join(", ")}${more}`,
      detail: {
        type: identityClass(first.type),
        normalized: groupKey.slice(groupKey.indexOf(":") + 1),
        exact,
        values,
        count: sorted.length,
        records: sorted.slice(0, MAX_LISTED).map((f) => ({
          itemId: f.itemId,
          unitId: f.unitId,
          name: f.name,
          code: f.code,
          type: f.type,
          value: f.value,
        })),
      },
      link: `/items/${first.itemId}`,
    });
  }
  return out;
}

export function duplicateRecord(facts: RecordFact[], ctx: RuleContext): Finding[] {
  const { maxGroup } = ctx.settings.rules.duplicate_record;
  const groups = new Map<string, RecordFact[]>();
  for (const f of facts) {
    const model = nameKey(f.model);
    const name = nameKey(f.name);
    if (!model || !name) continue;
    const g = `${f.locationId}:${name}:${nameKey(f.brand)}:${model}`;
    const list = groups.get(g) ?? [];
    list.push(f);
    groups.set(g, list);
  }
  const out: Finding[] = [];
  for (const [key, list] of groups) {
    // A bigger group is a set of identical things (a room of the same chairs),
    // not something typed in twice.
    if (list.length < 2 || list.length > maxGroup) continue;
    const serials = new Set(list.flatMap((f) => f.serials.map(identityKey).filter((s) => !isPlaceholderIdentity(s))));
    // Different serials: different physical things that happen to match.
    if (serials.size >= 2) continue;
    const sorted = [...list].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "") || a.itemId.localeCompare(b.itemId));
    const first = sorted[0]!;
    const place = ctx.places.path(first.locationId) ?? "the same place";
    const what = [first.brand, first.model].filter(Boolean).join(" ");
    out.push({
      ...base("duplicate_record"),
      key,
      severity: "low",
      subjectType: "location",
      subjectId: first.locationId,
      itemId: first.itemId,
      unitId: null,
      jobId: null,
      shipmentId: null,
      locationId: first.locationId,
      title: `${sorted.length} records for ${first.name} (${what}) in ${place}: ${sorted.map((f) => f.code ?? f.itemId).join(", ")}`,
      detail: {
        name: first.name,
        brand: first.brand,
        model: first.model,
        locationPath: place,
        records: sorted.map((f) => ({ itemId: f.itemId, code: f.code, name: f.name })),
        threshold: { maxGroup },
      },
      link: `/locations/${first.locationId}`,
    });
  }
  return out;
}

type Point = { lat: number; lng: number; fromDevice: boolean };

function pointOf(end: SightingEnd, places: PlaceIndex): Point | null {
  if (end.lat != null && end.lng != null) return { lat: end.lat, lng: end.lng, fromDevice: true };
  const c = places.coordsOf(end.locationId);
  return c ? { ...c, fromDevice: false } : null;
}

function whereLabel(end: SightingEnd, places: PlaceIndex): string {
  return (
    places.path(end.locationId) ??
    (end.lat != null && end.lng != null ? `${end.lat.toFixed(4)}, ${end.lng.toFixed(4)}` : "an unknown place")
  );
}

function placeKey(end: SightingEnd): string {
  if (end.locationId) return end.locationId;
  return `${end.lat?.toFixed(3)},${end.lng?.toFixed(3)}`;
}

export function impossibleTravel(facts: TransitionFact[], ctx: RuleContext): Finding[] {
  const { maxSpeedKmh, minDistanceM } = ctx.settings.rules.impossible_travel;
  const found = new Map<string, { finding: Finding; count: number }>();
  for (const t of facts) {
    // A zone inside another is not a journey (a shelf reader inside a room reader).
    if (t.from.locationId && t.to.locationId && ctx.places.related(t.from.locationId, t.to.locationId)) continue;
    const a = pointOf(t.from, ctx.places);
    const b = pointOf(t.to, ctx.places);
    if (!a || !b) continue;
    const distance = haversineM(a.lat, a.lng, b.lat, b.lng);
    // A GPS fix is only as good as its accuracy radius; give the asset the
    // benefit of both.
    const slack = (a.fromDevice ? (t.from.accuracyM ?? 0) : 0) + (b.fromDevice ? (t.to.accuracyM ?? 0) : 0);
    const effective = distance - slack;
    if (effective < minDistanceM) continue;
    const elapsedMs = Math.max(1000, t.to.at.getTime() - t.from.at.getTime());
    const speedKmh = (effective / (elapsedMs / 1000)) * 3.6;
    if (speedKmh <= maxSpeedKmh) continue;

    const pair = [placeKey(t.from), placeKey(t.to)].sort().join("|");
    const key = `${assetKey(t.itemId, t.unitId)}:${pair}`;
    const prev = found.get(key);
    if (prev && prev.finding.occurredAt! >= t.to.at) {
      prev.count += 1;
      continue;
    }
    const fromLabel = whereLabel(t.from, ctx.places);
    const toLabel = whereLabel(t.to, ctx.places);
    found.set(key, {
      count: (prev?.count ?? 0) + 1,
      finding: {
        ...base("impossible_travel"),
        key,
        severity: "high",
        subjectType: "item",
        subjectId: t.itemId,
        itemId: t.itemId,
        unitId: t.unitId,
        jobId: null,
        shipmentId: null,
        locationId: t.to.locationId,
        title: `${labelOf(t.name, t.code)} was read ${formatDistance(distance)} apart within ${formatDuration(elapsedMs)}: ${fromLabel}, then ${toLabel}`,
        detail: {
          name: t.name,
          code: t.code,
          from: { ...t.from, at: t.from.at.toISOString(), label: fromLabel },
          to: { ...t.to, at: t.to.at.toISOString(), label: toLabel },
          distanceM: Math.round(distance),
          effectiveDistanceM: Math.round(effective),
          elapsedSeconds: Math.round(elapsedMs / 1000),
          speedKmh: Math.round(speedKmh),
          threshold: { maxSpeedKmh, minDistanceM },
        },
        link: `/items/${t.itemId}`,
        occurredAt: t.to.at,
      },
    });
  }
  return [...found.values()].map(({ finding, count }) => ({
    ...finding,
    detail: { ...finding.detail, readsInWindow: count },
  }));
}

export function zoneMismatch(facts: PositionFact[], ctx: RuleContext): Finding[] {
  const { hours } = ctx.settings.rules.zone_mismatch;
  const out: Finding[] = [];
  for (const p of facts) {
    if (!p.zoneId) continue;
    // A reader zone and a shelf inside it (or the other way round) agree.
    if (p.recordedLocationId && ctx.places.related(p.zoneId, p.recordedLocationId)) continue;
    // Someone changed the record after the last read: the record is the newer news.
    if (p.recordChangedAt && p.recordChangedAt.getTime() > p.observedAt.getTime()) continue;
    const since = Math.max((p.enteredAt ?? p.observedAt).getTime(), p.recordChangedAt?.getTime() ?? 0);
    const lasted = ctx.now.getTime() - since;
    if (lasted < hours * HOUR) continue;
    const zone = ctx.places.path(p.zoneId) ?? "a zone";
    const recorded = ctx.places.path(p.recordedLocationId);
    out.push({
      ...base("zone_mismatch"),
      key: assetKey(p.itemId, p.unitId),
      severity: recorded ? "medium" : "low",
      subjectType: "item",
      subjectId: p.itemId,
      itemId: p.itemId,
      unitId: p.unitId,
      jobId: null,
      shipmentId: null,
      locationId: p.zoneId,
      title: recorded
        ? `${labelOf(p.name, p.code)} has been read in ${zone} for ${formatDuration(lasted)} but is on file in ${recorded}`
        : `${labelOf(p.name, p.code)} has been read in ${zone} for ${formatDuration(lasted)} and has no place on file`,
      detail: {
        name: p.name,
        code: p.code,
        zoneId: p.zoneId,
        zonePath: zone,
        recordedLocationId: p.recordedLocationId,
        recordedPath: recorded,
        since: new Date(since).toISOString(),
        lastSeenAt: p.observedAt.toISOString(),
        threshold: { hours },
      },
      link: `/items/${p.itemId}`,
    });
  }
  return out;
}

export function notSeen(facts: PositionFact[], ctx: RuleContext): Finding[] {
  const { days } = ctx.settings.rules.not_seen;
  const out: Finding[] = [];
  for (const p of facts) {
    if (!p.active || p.checkedOut) continue;
    const quiet = ctx.now.getTime() - p.observedAt.getTime();
    if (quiet < days * DAY) continue;
    const where = ctx.places.path(p.zoneId);
    out.push({
      ...base("not_seen"),
      key: assetKey(p.itemId, p.unitId),
      severity: "medium",
      subjectType: "item",
      subjectId: p.itemId,
      itemId: p.itemId,
      unitId: p.unitId,
      jobId: null,
      shipmentId: null,
      locationId: p.zoneId,
      title: `${labelOf(p.name, p.code)} has not been read for ${formatDuration(quiet)}${where ? `; last in ${where}` : ""}`,
      detail: {
        name: p.name,
        code: p.code,
        lastSeenAt: p.observedAt.toISOString(),
        lastZoneId: p.zoneId,
        lastZonePath: where,
        threshold: { days },
      },
      link: `/items/${p.itemId}`,
    });
  }
  return out;
}

// --- Evaluation ----------------------------------------------------------------

/** Everything the rules read. Each list may be empty when its rule is off. */
export type Facts = {
  stageLines: StageLineFact[];
  shipmentLines: ShipmentLineFact[];
  identities: IdentityFact[];
  records: RecordFact[];
  transitions: TransitionFact[];
  positions: PositionFact[];
};

/** Which facts each rule reads, so a run gathers only what its enabled rules need. */
export const RULE_FACTS: Record<RuleId, keyof Facts> = {
  packed_not_loaded: "stageLines",
  loaded_not_delivered: "stageLines",
  delivered_not_placed: "stageLines",
  duplicate_identifier: "identities",
  duplicate_record: "records",
  impossible_travel: "transitions",
  zone_mismatch: "positions",
  not_seen: "positions",
  multi_shipment: "shipmentLines",
};

export function runRule(rule: RuleId, facts: Partial<Facts>, ctx: RuleContext): Finding[] {
  switch (rule) {
    case "packed_not_loaded":
      return packedNotLoaded(facts.stageLines ?? []);
    case "loaded_not_delivered":
      return loadedNotDelivered(facts.stageLines ?? [], ctx);
    case "delivered_not_placed":
      return deliveredNotPlaced(facts.stageLines ?? [], ctx);
    case "duplicate_identifier":
      return duplicateIdentifier(facts.identities ?? []);
    case "duplicate_record":
      return duplicateRecord(facts.records ?? [], ctx);
    case "impossible_travel":
      return impossibleTravel(facts.transitions ?? [], ctx);
    case "zone_mismatch":
      return zoneMismatch(facts.positions ?? [], ctx);
    case "not_seen":
      return notSeen(facts.positions ?? [], ctx);
    case "multi_shipment":
      return multiShipment(facts.shipmentLines ?? []);
  }
}
