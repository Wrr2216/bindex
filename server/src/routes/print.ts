import { Router } from "express";
import { asyncHandler, param } from "../lib/http";
import { badRequest } from "../lib/errors";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { items } from "../db/schema";
import { env } from "../env";
import { getContainerManifest, getItemDetail, type ItemDetail } from "../services/items";
import { getUnitLabelInfo, unitSubLine, type UnitLabelInfo } from "../services/units";
import {
  getLocationDetail,
  getLocationManifest,
  type LocationDetail,
} from "../services/locations";
import { assetCodePrefix, locationCode } from "../lib/codes";
import { getConfig } from "../services/config";
import {
  compactLabelPdf,
  compactPreviewPng,
  labelPdf,
  manifestPdf,
  previewPng,
  samplePdf,
  samplePng,
  type CompactLabelData,
  type LabelData,
} from "../services/printing";
import { generateLabelSheet, type LabelSheetRow } from "../services/printing/xlsx";

export const printRouter = Router();

const itemUrl = (id: string) => `${env.APP_BASE_URL.replace(/\/+$/, "")}/items/${id}`;

function labelData(item: ItemDetail): LabelData {
  return {
    name: item.name,
    code: item.assetCode,
    sub: item.ninjaoneOrg ?? item.locationName ?? undefined,
    url: itemUrl(item.id),
  };
}

/** Label tuned for a container: the sub line calls out the contents count. */
function containerLabelData(item: ItemDetail): LabelData {
  const n = item.children.length;
  return {
    name: item.name,
    code: item.assetCode,
    sub: `Container · ${n} item${n === 1 ? "" : "s"}`,
    url: itemUrl(item.id),
  };
}

/** Compact label: just the QR with the asset code beneath it. */
function compactLabelData(item: ItemDetail): CompactLabelData {
  return { code: item.assetCode, url: itemUrl(item.id) };
}

/** Deep link that opens the item with this unit highlighted. */
const unitUrl = (u: UnitLabelInfo) => `${itemUrl(u.itemId)}?unit=${u.id}`;

/** Label for one physical unit: item name, the unit's own code, its label/serial. */
function unitLabelData(u: UnitLabelInfo): LabelData {
  return { name: u.itemName, code: u.assetCode, sub: unitSubLine(u), url: unitUrl(u) };
}

function compactUnitLabelData(u: UnitLabelInfo): CompactLabelData {
  return { code: u.assetCode, url: unitUrl(u) };
}

async function rejectIfDomain(itemId: string): Promise<void> {
  const [row] = await db
    .select({ category: items.category })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (row?.category === "Domain") throw badRequest("Domain items cannot be printed.");
}

const locationUrl = (id: string) => `${env.APP_BASE_URL.replace(/\/+$/, "")}/locations/${id}`;

/** Label for a location/tote: name + QR that opens its contents page. */
function locationLabelData(loc: LocationDetail): LabelData {
  const n = loc.itemCount;
  const itemsText = `${n} item${n === 1 ? "" : "s"}`;
  const sub = loc.children.length
    ? `Rack · ${loc.children.length} container${loc.children.length === 1 ? "" : "s"}`
    : loc.parentName
      ? `${loc.parentName} · ${itemsText}`
      : `Container · ${itemsText}`;
  return {
    name: loc.name,
    code: locationCode(loc.id),
    sub,
    url: locationUrl(loc.id),
  };
}

function compactLocationLabelData(loc: LocationDetail): CompactLabelData {
  return { code: locationCode(loc.id), url: locationUrl(loc.id) };
}

function sendPdf(res: import("express").Response, pdf: Buffer): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=labels.pdf");
  res.setHeader("Cache-Control", "no-store");
  res.send(pdf);
}

// On-screen PNG preview for a single item.
printRouter.get(
  "/label/:id/preview.png",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await rejectIfDomain(id);
    const item = await getItemDetail(id);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(await previewPng(labelData(item)));
  }),
);

// Print-ready PDF: single item.
printRouter.get(
  "/label/:id/print.pdf",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await rejectIfDomain(id);
    const item = await getItemDetail(id);
    sendPdf(res, await labelPdf([labelData(item)]));
  }),
);

// Compact label: on-screen PNG preview (QR + code only).
printRouter.get(
  "/label/:id/compact-preview.png",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await rejectIfDomain(id);
    const item = await getItemDetail(id);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(await compactPreviewPng(compactLabelData(item)));
  }),
);

// Compact label: print-ready PDF (one square page).
printRouter.get(
  "/label/:id/compact.pdf",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await rejectIfDomain(id);
    const item = await getItemDetail(id);
    sendPdf(res, await compactLabelPdf([compactLabelData(item)]));
  }),
);

// Print-ready PDF: batch (?ids=a,b,c), one page per label. ?style=compact
// switches every page to the QR-only compact layout.
printRouter.get(
  "/labels.pdf",
  asyncHandler(async (req, res) => {
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) throw badRequest("No item ids provided");
    const rows = await Promise.all(ids.map((id) => getItemDetail(id)));
    if (rows.some((i) => i.category === "Domain")) throw badRequest("Domain items cannot be printed.");
    const pdf =
      req.query.style === "compact"
        ? await compactLabelPdf(rows.map(compactLabelData))
        : await labelPdf(rows.map(labelData));
    sendPdf(res, pdf);
  }),
);

// Per-unit label: on-screen PNG preview.
printRouter.get(
  "/unit/:unitId/preview.png",
  asyncHandler(async (req, res) => {
    const unit = await getUnitLabelInfo(param(req, "unitId"));
    await rejectIfDomain(unit.itemId);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(await previewPng(unitLabelData(unit)));
  }),
);

// Per-unit label: print-ready PDF (one exact-size page).
printRouter.get(
  "/unit/:unitId/print.pdf",
  asyncHandler(async (req, res) => {
    const unit = await getUnitLabelInfo(param(req, "unitId"));
    await rejectIfDomain(unit.itemId);
    sendPdf(res, await labelPdf([unitLabelData(unit)]));
  }),
);

// Per-unit compact label: on-screen PNG preview (QR + code only).
printRouter.get(
  "/unit/:unitId/compact-preview.png",
  asyncHandler(async (req, res) => {
    const unit = await getUnitLabelInfo(param(req, "unitId"));
    await rejectIfDomain(unit.itemId);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(await compactPreviewPng(compactUnitLabelData(unit)));
  }),
);

// Per-unit compact label: print-ready PDF (one square page).
printRouter.get(
  "/unit/:unitId/compact.pdf",
  asyncHandler(async (req, res) => {
    const unit = await getUnitLabelInfo(param(req, "unitId"));
    await rejectIfDomain(unit.itemId);
    sendPdf(res, await compactLabelPdf([compactUnitLabelData(unit)]));
  }),
);

// Per-unit labels: batch (?ids=a,b,c), one page per unit. ?style=compact
// switches every page to the QR-only layout.
printRouter.get(
  "/unit-labels.pdf",
  asyncHandler(async (req, res) => {
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) throw badRequest("No unit ids provided");
    const units = await Promise.all(ids.map((id) => getUnitLabelInfo(id)));
    for (const itemId of new Set(units.map((u) => u.itemId))) await rejectIfDomain(itemId);
    const pdf =
      req.query.style === "compact"
        ? await compactLabelPdf(units.map(compactUnitLabelData))
        : await labelPdf(units.map(unitLabelData));
    sendPdf(res, pdf);
  }),
);

// Container label: on-screen PNG preview.
printRouter.get(
  "/container/:id/preview.png",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await rejectIfDomain(id);
    const item = await getItemDetail(id);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(await previewPng(containerLabelData(item)));
  }),
);

// Container label: print-ready PDF (one exact-size page).
printRouter.get(
  "/container/:id/label.pdf",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await rejectIfDomain(id);
    const item = await getItemDetail(id);
    sendPdf(res, await labelPdf([containerLabelData(item)]));
  }),
);

// Container contents sheet: full-page (Letter) packing slip with serials and a
// print timestamp. `tz` is the viewer's IANA time zone (defaults to UTC).
printRouter.get(
  "/manifest/:id/contents.pdf",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await rejectIfDomain(id);
    const tz = typeof req.query.tz === "string" && req.query.tz ? req.query.tz : "UTC";
    const manifest = await getContainerManifest(id);
    const pdf = await manifestPdf(manifest, new Date(), tz, (await getConfig()).appName, itemUrl(id));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=container-contents.pdf");
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  }),
);

// Location/tote label: on-screen PNG preview.
printRouter.get(
  "/location/:id/preview.png",
  asyncHandler(async (req, res) => {
    const loc = await getLocationDetail(param(req, "id"));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(await previewPng(locationLabelData(loc)));
  }),
);

// Location/tote label: print-ready PDF (one exact-size page).
printRouter.get(
  "/location/:id/label.pdf",
  asyncHandler(async (req, res) => {
    const loc = await getLocationDetail(param(req, "id"));
    sendPdf(res, await labelPdf([locationLabelData(loc)]));
  }),
);

// Location compact label: on-screen PNG preview.
printRouter.get(
  "/location/:id/compact-preview.png",
  asyncHandler(async (req, res) => {
    const loc = await getLocationDetail(param(req, "id"));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(await compactPreviewPng(compactLocationLabelData(loc)));
  }),
);

// Location compact label: print-ready PDF (one square page).
printRouter.get(
  "/location/:id/compact.pdf",
  asyncHandler(async (req, res) => {
    const loc = await getLocationDetail(param(req, "id"));
    sendPdf(res, await compactLabelPdf([compactLocationLabelData(loc)]));
  }),
);

// Location contents sheet: full-page packing slip of everything in the location.
printRouter.get(
  "/manifest/location/:id/contents.pdf",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const tz = typeof req.query.tz === "string" && req.query.tz ? req.query.tz : "UTC";
    const manifest = await getLocationManifest(id);
    const pdf = await manifestPdf(manifest, new Date(), tz, (await getConfig()).appName, locationUrl(id));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=location-contents.pdf");
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  }),
);

// Sample label (print test).
printRouter.get(
  "/sample.png",
  asyncHandler(async (_req, res) => {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(await samplePng());
  }),
);

printRouter.get(
  "/sample.pdf",
  asyncHandler(async (_req, res) => {
    sendPdf(res, await samplePdf());
  }),
);

// The same labels as a spreadsheet, one row each, for label software that
// imports a data file and fills a template from it. Useful on phones and with
// printers this app cannot drive directly.
printRouter.get(
  "/labels.xlsx",
  asyncHandler(async (req, res) => {
    const rows: LabelSheetRow[] = [];

    const pushItem = (item: ItemDetail): void => {
      rows.push({
        assetCode: item.assetCode,
        itemName: item.name,
        subLine: item.ninjaoneOrg ?? item.description ?? "",
        serials: item.identifiers
          .filter((i) => i.type === "serial")
          .map((i) => i.value)
          .join(", "),
        location: item.locationName ?? "",
        url: itemUrl(item.id),
      });
    };

    const pushUnit = (u: UnitLabelInfo): void => {
      rows.push({
        assetCode: u.assetCode,
        itemName: u.itemName,
        subLine: unitSubLine(u),
        serials: u.serial ?? "",
        location: u.locationName ?? "",
        url: unitUrl(u),
      });
    };

    if (req.query.test) {
      rows.push({
        assetCode: `${assetCodePrefix()}-TEST01`,
        itemName: "Test label",
        subLine: "print test",
        serials: "",
        location: "",
        url: itemUrl("test"),
      });
    } else if (req.query.container) {
      const item = await getItemDetail(String(req.query.container));
      pushItem(item);
    } else if (req.query.location) {
      const loc = await getLocationDetail(String(req.query.location));
      const n = loc.itemCount;
      const itemsText = `${n} item${n === 1 ? "" : "s"}`;
      const sub = loc.parentName
        ? `${loc.parentName} · ${itemsText}`
        : `Container · ${itemsText}`;
      rows.push({
        assetCode: locationCode(loc.id),
        itemName: loc.name,
        subLine: sub,
        serials: "",
        location: "",
        url: locationUrl(loc.id),
      });
    } else if (req.query.units) {
      const unitIds = String(req.query.units)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (unitIds.length === 0) throw badRequest("No unit ids provided");
      const units = await Promise.all(unitIds.map((id) => getUnitLabelInfo(id)));
      for (const u of units) pushUnit(u);
    } else if (req.query.ids) {
      const ids = String(req.query.ids)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) throw badRequest("No item ids provided");
      const itemsList = await Promise.all(ids.map((id) => getItemDetail(id)));
      if (itemsList.some((i) => i.category === "Domain"))
        throw badRequest("Domain items cannot be printed.");
      for (const item of itemsList) pushItem(item);
    } else {
      throw badRequest(
        "No items specified. Use ?ids=a,b or ?units=a,b or ?container=id or ?location=id",
      );
    }

    const xlsx = await generateLabelSheet(rows);
    const filename = `labels-${rows.length}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(xlsx);
  }),
);
