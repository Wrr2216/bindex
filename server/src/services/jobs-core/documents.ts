import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { itemUnits, items, jobItems, locations, shipments } from "../../db/schema";
import { env } from "../../env";
import { getConfig } from "../config";
import { getJob } from "./jobs";
import { loadPlaceIndex, selectLines, type ManifestLine } from "./manifest";
import { manifestNotesFor } from "./manifestNotes";
import { isExceptionStage, stageLabel } from "./model";
import { pathOf, type PlaceIndex } from "./places";
import {
  renderLoadSheetPdf,
  renderManifestPdf,
  type LoadSheetLine,
  type ManifestDocGroup,
  type ManifestDocLine,
  type StepChecks,
} from "./pdf";
import { hasReached, statusLabel } from "./rules";
import { getShipment } from "./shipments";
import { renderManifestXlsx, type ManifestSheetRow } from "./xlsx";

/**
 * Manifest documents: gathers a job's lines with every name a person needs on
 * paper, groups them, and hands them to the PDF and spreadsheet renderers.
 */

/**
 * floor and department group by the move plan (where lines are going);
 * origin groups by the room each line was added from, which is the packing
 * list a crew works through before anything has a destination.
 */
export type GroupBy = "floor" | "department" | "shipment" | "origin" | "none";

export type DocumentFilters = {
  groupBy?: GroupBy;
  shipmentId?: string;
  floor?: string;
  department?: string;
  stage?: string;
};

const baseUrl = () => env.APP_BASE_URL.replace(/\/+$/, "");

const checks = (stage: string): StepChecks => ({
  packed: hasReached(stage, "packed"),
  loaded: hasReached(stage, "loaded"),
  delivered: hasReached(stage, "delivered"),
  placed: hasReached(stage, "placed"),
});

function describeLine(l: ManifestLine, index: PlaceIndex) {
  const path = (id: string | null) => (id ? pathOf(id, index.byId).join(" / ") || null : null);
  const to = [path(l.destinationLocationId), l.destinationLabel].filter(Boolean).join("  ·  ") || null;
  const unit = l.unitLabel ?? (l.unitCode ? `Unit ${l.unitCode}` : null);
  const sub = [[l.itemBrand, l.itemModel].filter(Boolean).join(" "), unit, l.unitSerial ? `S/N ${l.unitSerial}` : null]
    .filter(Boolean)
    .join("  ·  ");
  return {
    code: l.unitCode ?? l.assetCode,
    from: path(l.originLocationId),
    to,
    sub: sub || null,
    exception: isExceptionStage(l.stage) ? stageLabel(l.stage).toUpperCase() : null,
  };
}

function groupKey(l: ManifestLine, by: GroupBy, index: PlaceIndex): string | null {
  switch (by) {
    case "origin":
      return l.originLocationId ? pathOf(l.originLocationId, index.byId).join(" / ") : "Origin not recorded";
    case "floor":
      // A plan that says "5" reads better as "Floor 5"; one that already says
      // "Level 5" or "Floor 5" is left alone.
      if (!l.floor) return "No floor";
      return /^(floor|level|lvl|fl)\b/i.test(l.floor) ? l.floor : `Floor ${l.floor}`;
    case "department":
      return l.department ?? "No department";
    case "shipment":
      return l.shipmentCode ? `${l.shipmentCode}  ${l.shipmentName ?? ""}`.trim() : "Not on a shipment";
    default:
      return null;
  }
}

async function jobLines(jobId: string, f: DocumentFilters): Promise<ManifestLine[]> {
  const where: SQL | undefined = and(
    eq(jobItems.jobId, jobId),
    f.shipmentId === "none" ? isNull(jobItems.shipmentId) : f.shipmentId ? eq(jobItems.shipmentId, f.shipmentId) : undefined,
    f.floor ? eq(jobItems.floor, f.floor) : undefined,
    f.department ? eq(jobItems.department, f.department) : undefined,
    f.stage ? eq(jobItems.stage, f.stage) : undefined,
  );
  const by = f.groupBy ?? "floor";
  const primary =
    by === "department"
      ? [asc(jobItems.department), asc(jobItems.floor)]
      : by === "shipment"
        ? [asc(shipments.code), asc(jobItems.floor)]
        : [asc(jobItems.floor), asc(jobItems.department)];
  return selectLines(where).orderBy(
    ...primary,
    asc(jobItems.destinationLabel),
    asc(jobItems.crateNo),
    asc(items.name),
    asc(itemUnits.assetCode),
  );
}

function filterSummary(f: DocumentFilters): string | null {
  const parts = [
    f.floor ? `floor ${f.floor}` : null,
    f.department ? `department ${f.department}` : null,
    f.stage ? `stage ${stageLabel(f.stage).toLowerCase()}` : null,
    f.shipmentId === "none" ? "not on a shipment" : null,
  ].filter(Boolean);
  return parts.length ? `Only ${parts.join(", ")}` : null;
}

async function manifestContext(jobId: string, f: DocumentFilters) {
  const [job, rows, index] = await Promise.all([getJob(jobId), jobLines(jobId, f), loadPlaceIndex()]);
  // SQL cannot order by a location's full path, so origin grouping sorts here;
  // the sort is stable, so the SQL order holds within each room.
  const lines =
    f.groupBy === "origin"
      ? [...rows].sort((a, b) =>
          (groupKey(a, "origin", index) ?? "").localeCompare(groupKey(b, "origin", index) ?? "", undefined, {
            numeric: true,
          }),
        )
      : rows;
  const shipment = f.shipmentId && f.shipmentId !== "none" ? job.shipments.find((s) => s.id === f.shipmentId) : null;
  const details = [
    [job.jobTypeName, job.projectCode ? `${job.projectCode} ${job.projectName}` : null, job.phaseName]
      .filter(Boolean)
      .join("  ·  "),
    job.originName || job.destinationName
      ? `${job.originName ?? "Unspecified"}  to  ${job.destinationName ?? "Unspecified"}`
      : "",
    shipment ? `Shipment ${shipment.code}  ${shipment.name}` : "",
    filterSummary(f) ?? "",
  ].filter(Boolean);
  const notes = await manifestNotesFor(lines.map((l) => ({ itemId: l.itemId, unitId: l.unitId })));
  return { job, lines, index, details, notes };
}

/** The line's own sub-line with any note other features print under it. */
const withNote = (sub: string | null, note: string | null | undefined) =>
  note ? (sub ? `${sub}  ·  ${note}` : note) : sub;

export async function jobManifestPdf(jobId: string, f: DocumentFilters, tz: string): Promise<Buffer> {
  const { job, lines, index, details, notes } = await manifestContext(jobId, f);
  const by = f.groupBy ?? "floor";
  const groups: ManifestDocGroup[] = [];
  let n = 0;
  for (const l of lines) {
    const label = groupKey(l, by, index) ?? "";
    let g = groups[groups.length - 1];
    if (!g || g.label !== label) {
      g = { label, summary: "", lines: [] };
      groups.push(g);
    }
    const d = describeLine(l, index);
    const line: ManifestDocLine = {
      index: ++n,
      itemName: l.itemName,
      sub: withNote(d.sub, notes[n - 1]),
      code: d.code,
      crate: l.crateNo,
      from: d.from,
      to: d.to,
      exception: d.exception,
      checks: checks(l.stage),
    };
    g.lines.push(line);
  }
  for (const g of groups) {
    const placed = g.lines.filter((l) => l.checks.placed).length;
    g.summary = `${g.lines.length} line${g.lines.length === 1 ? "" : "s"}  ·  ${placed} placed`;
  }
  const crates = new Set(lines.flatMap((l) => (l.crateNo ? [l.crateNo] : []))).size;
  const byLabel = by === "none" ? "" : `  ·  by ${by}`;
  const config = await getConfig();
  return renderManifestPdf(
    {
      kicker: "RELOCATION MANIFEST",
      title: job.name,
      code: job.code,
      details,
      groups,
      summary: `${lines.length} line${lines.length === 1 ? "" : "s"}${crates ? `  ·  ${crates} crate${crates === 1 ? "" : "s"}` : ""}${byLabel}`,
      signatures: ["Released at origin", "Received at destination"],
      url: `${baseUrl()}/jobs/${job.id}`,
    },
    new Date(),
    tz,
    config.appName,
  );
}

export async function jobManifestXlsx(jobId: string, f: DocumentFilters): Promise<Buffer> {
  const { job, lines, index, details } = await manifestContext(jobId, f);
  const by = f.groupBy ?? "floor";
  const rows: ManifestSheetRow[] = lines.map((l, i) => {
    const d = describeLine(l, index);
    const c = checks(l.stage);
    return {
      group: groupKey(l, by, index),
      index: i + 1,
      itemName: l.itemName,
      brandModel: [l.itemBrand, l.itemModel].filter(Boolean).join(" ") || null,
      assetCode: l.assetCode,
      unit: l.unitCode ? [l.unitCode, l.unitLabel].filter(Boolean).join(" ") : null,
      serial: l.unitSerial,
      crate: l.crateNo,
      origin: d.from,
      destination: l.destinationLocationId ? pathOf(l.destinationLocationId, index.byId).join(" / ") : null,
      desk: l.destinationLabel,
      floor: l.floor,
      department: l.department,
      shipment: l.shipmentCode,
      stage: stageLabel(l.stage),
      ...c,
      notes: l.notes,
    };
  });
  return renderManifestXlsx(`${job.code}  ${job.name}`, details.join("  ·  "), rows);
}

export async function shipmentLoadSheetPdf(shipmentId: string, tz: string): Promise<Buffer> {
  const shipment = await getShipment(shipmentId);
  const [job, lines, index, vehicle] = await Promise.all([
    getJob(shipment.jobId),
    jobLines(shipment.jobId, { shipmentId, groupBy: "none" }),
    loadPlaceIndex(),
    shipment.vehicleLocationId
      ? db.select({ name: locations.name }).from(locations).where(eq(locations.id, shipment.vehicleLocationId)).limit(1)
      : Promise.resolve([]),
  ]);
  const when = (d: Date | null) => (d ? formatDate(d, tz) : "");
  const facts: [string, string][] = [
    ["Status", statusLabel(shipment.status)],
    ["Carrier", shipment.carrier ?? ""],
    ["Vehicle", vehicle[0]?.name ?? ""],
    ["ETA", when(shipment.eta)],
    ["Weight", shipment.weightKg != null ? `${shipment.weightKg} kg` : ""],
    ["Volume", shipment.volumeM3 != null ? `${shipment.volumeM3} m³` : ""],
    ["Distance", shipment.distanceKm != null ? `${shipment.distanceKm} km` : ""],
    ["Departed", when(shipment.departedAt)],
    ["Arrived", when(shipment.arrivedAt)],
  ];
  const notes = await manifestNotesFor(lines.map((l) => ({ itemId: l.itemId, unitId: l.unitId })));
  const sheetLines: LoadSheetLine[] = lines.map((l, i) => {
    const d = describeLine(l, index);
    const c = checks(l.stage);
    return {
      index: i + 1,
      crate: l.crateNo,
      itemName: l.itemName,
      sub: withNote(d.sub, notes[i]),
      code: d.code,
      to: d.to,
      exception: d.exception,
      loaded: c.loaded,
      delivered: c.delivered,
    };
  });
  const crates = new Set(lines.flatMap((l) => (l.crateNo ? [l.crateNo] : []))).size;
  const config = await getConfig();
  return renderLoadSheetPdf(
    {
      title: shipment.name,
      code: shipment.code,
      details: [
        `Job ${job.code}  ${job.name}`,
        job.originName || job.destinationName
          ? `${job.originName ?? "Unspecified"}  to  ${job.destinationName ?? "Unspecified"}`
          : "",
      ].filter(Boolean),
      facts,
      seals: shipment.sealNumbers,
      lines: sheetLines,
      summary: `${lines.length} piece${lines.length === 1 ? "" : "s"}${crates ? `  ·  ${crates} crate${crates === 1 ? "" : "s"}` : ""}`,
      url: `${baseUrl()}/shipments/${shipment.id}`,
    },
    new Date(),
    tz,
    config.appName,
  );
}

function formatDate(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}
