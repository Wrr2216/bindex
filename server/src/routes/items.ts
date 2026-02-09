import { Router, raw } from "express";
import { z } from "zod";
import { asyncHandler, parse, param } from "../lib/http";
import { badRequest } from "../lib/errors";
import { env } from "../env";
import { currentUser } from "../auth/middleware";
import * as svc from "../services/items";
import { checkIn, checkInUnit, checkOut, checkOutUnit } from "../services/assignments";
import { savePhoto, savePhotoFromUrl } from "../services/photos";
import { lookupPricing, lookupItemFields } from "../services/enrichment";
import { addUnit, updateUnit, deleteUnit } from "../services/units";
import { getCandidate, recordSpotCheck } from "../services/spotcheck";

const spotCheckSchema = z.object({ seen: z.boolean() });

const checkoutSchema = z.object({ entityId: z.string().uuid(), note: z.string().nullish() });
const checkinSchema = z.object({ note: z.string().nullish() });
const unitSchema = z.object({
  label: z.string().max(120).nullish(),
  serial: z.string().nullish(),
  status: z.string().optional(),
  valueCents: z.number().int().nonnegative().nullish(),
  locationId: z.string().uuid().nullish(),
  utilizedByEntityId: z.string().uuid().nullish(),
  notes: z.string().nullish(),
});

const identifierSchema = z.object({
  type: z.enum(["upc", "serial", "asset_tag", "mac", "sku", "other", "rfid", "domain"]),
  value: z.string().min(1),
});

const urlSchema = z.string().url();
const localPhotoPathRe = /^\/api\/photos\/[^/]+$/;

const imageUrlField = z
  .string()
  .refine(
    (s) => urlSchema.safeParse(s).success || localPhotoPathRe.test(s),
    { message: "Must be a valid URL or a local photo path (/api/photos/:id)" },
  );

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  brand: z.string().nullish(),
  model: z.string().nullish(),
  category: z.string().nullish(),
  primaryImageUrl: imageUrlField.nullish(),
  parentItemId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  utilizedByEntityId: z.string().uuid().nullish(),
  companyId: z.string().uuid().nullish(),
  valueCents: z.number().int().nonnegative().nullish(),
  expiresAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date")
    .nullish(),
  quantity: z.number().int().positive().optional(),
  enrichmentSource: z.string().nullish(),
  metadata: z.record(z.unknown()).optional(),
  identifiers: z.array(identifierSchema).optional(),
  images: z.array(imageUrlField).optional(),
});

const updateSchema = createSchema.partial();

export const itemsRouter = Router();

const ITEM_KINDS = ["physical", "digital", "all"] as const;

itemsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const locationId = typeof req.query.locationId === "string" ? req.query.locationId : undefined;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const rawKind = typeof req.query.kind === "string" ? req.query.kind : "physical";
    const kind = ITEM_KINDS.includes(rawKind as (typeof ITEM_KINDS)[number]) ? (rawKind as svc.ItemKind) : "physical";
    res.json(await svc.listOrSearch({ q, locationId, companyId, kind, limit, offset }));
  }),
);

itemsRouter.get(
  "/domains",
  asyncHandler(async (_req, res) => {
    const rows = await svc.listDomains();
    res.json(rows);
  }),
);

itemsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parse(createSchema, req.body);
    res.status(201).json(await svc.createItem(input, currentUser(req).oid));
  }),
);

const bulkSetSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  set: z.object({
    locationId: z.string().uuid().nullish(),
    utilizedByEntityId: z.string().uuid().nullish(),
    companyId: z.string().uuid().nullish(),
    status: z.string().optional(),
  }),
});
const bulkDeleteSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });

itemsRouter.post(
  "/bulk",
  asyncHandler(async (req, res) => {
    const { ids, set } = parse(bulkSetSchema, req.body);
    res.json(await svc.bulkUpdate(ids, set, currentUser(req).oid));
  }),
);

itemsRouter.post(
  "/bulk-delete",
  asyncHandler(async (req, res) => {
    const { ids } = parse(bulkDeleteSchema, req.body);
    res.json(await svc.bulkDelete(ids, currentUser(req).oid));
  }),
);

itemsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await svc.getItemDetail(param(req, "id")));
  }),
);

itemsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const patch = parse(updateSchema, req.body);
    res.json(await svc.updateItem(param(req, "id"), patch, currentUser(req).oid));
  }),
);

itemsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await svc.deleteItem(param(req, "id"), currentUser(req).oid);
    res.status(204).end();
  }),
);

itemsRouter.get(
  "/:id/children",
  asyncHandler(async (req, res) => {
    res.json(await svc.getChildren(param(req, "id")));
  }),
);

itemsRouter.post(
  "/:id/identifiers",
  asyncHandler(async (req, res) => {
    const input = parse(identifierSchema, req.body);
    res.status(201).json(await svc.addIdentifier(param(req, "id"), input));
  }),
);

itemsRouter.post(
  "/:id/checkout",
  asyncHandler(async (req, res) => {
    const { entityId, note } = parse(checkoutSchema, req.body);
    await checkOut(param(req, "id"), entityId, currentUser(req).oid, note);
    res.json(await svc.getItemDetail(param(req, "id")));
  }),
);

itemsRouter.post(
  "/:id/checkin",
  asyncHandler(async (req, res) => {
    const { note } = parse(checkinSchema, req.body);
    await checkIn(param(req, "id"), currentUser(req).oid, note);
    res.json(await svc.getItemDetail(param(req, "id")));
  }),
);

// Photo upload: raw image body (the global JSON parser ignores image/* types).
itemsRouter.post(
  "/:id/photo",
  raw({ type: ["image/*", "application/octet-stream"], limit: "12mb" }),
  asyncHandler(async (req, res) => {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw badRequest("No image data received.");
    const mime = String(req.headers["content-type"] || "image/jpeg").split(";")[0]!;
    res.json(await savePhoto(param(req, "id"), mime, bytes));
  }),
);

// Street price and product photos for an item that already exists. Read-only:
// the result comes back for the person to accept, which they do by patching
// valueCents or importing one of the photos.
itemsRouter.post(
  "/:id/pricing",
  asyncHandler(async (req, res) => {
    if (!env.webSearchConfigured || !env.llmConfigured) {
      throw badRequest("Price lookup needs BRAVE_API_KEY and LLM_API_KEY to be set.");
    }
    const item = await svc.getItemDetail(param(req, "id"));
    if (item.category === "Domain") {
      throw badRequest("MSRP lookup is not available for domain items.");
    }
    const upc =
      item.identifiers.find((i) => i.type === "upc")?.value ??
      item.identifiers.find((i) => i.type === "sku")?.value ??
      null;
    res.json(
      await lookupPricing({ name: item.name, brand: item.brand, model: item.model, upc }),
    );
  }),
);

// Description and photo suggestions for an item that already exists. Read-only,
// in the same way as the pricing route above.
itemsRouter.post(
  "/:id/lookup",
  asyncHandler(async (req, res) => {
    if (!env.llmConfigured && !env.webSearchConfigured) {
      throw badRequest("Item lookup needs BRAVE_API_KEY or LLM_API_KEY to be set.");
    }
    const item = await svc.getItemDetail(param(req, "id"));
    if (item.category === "Domain") {
      throw badRequest("Lookup is not available for domain items.");
    }
    const identifier =
      item.identifiers.find((i) => i.type === "upc")?.value ??
      item.identifiers.find((i) => i.type === "sku")?.value ??
      item.identifiers.find((i) => i.type === "serial")?.value ??
      null;
    res.json(
      await lookupItemFields({
        name: item.name,
        brand: item.brand,
        model: item.model,
        identifier,
      }),
    );
  }),
);

// Import a found/external image URL as the item's primary photo (stored locally).
const photoUrlSchema = z.object({ url: z.string().url() });
itemsRouter.post(
  "/:id/photo-from-url",
  asyncHandler(async (req, res) => {
    const { url } = parse(photoUrlSchema, req.body);
    res.json(await savePhotoFromUrl(param(req, "id"), url));
  }),
);

itemsRouter.post(
  "/:id/units",
  asyncHandler(async (req, res) => {
    await addUnit(param(req, "id"), parse(unitSchema, req.body));
    res.json(await svc.getItemDetail(param(req, "id")));
  }),
);

itemsRouter.patch(
  "/:id/units/:unitId",
  asyncHandler(async (req, res) => {
    await updateUnit(param(req, "unitId"), parse(unitSchema.partial(), req.body));
    res.json(await svc.getItemDetail(param(req, "id")));
  }),
);

itemsRouter.delete(
  "/:id/units/:unitId",
  asyncHandler(async (req, res) => {
    await deleteUnit(param(req, "unitId"));
    res.json(await svc.getItemDetail(param(req, "id")));
  }),
);

// Check one physical unit out to an entity (independent of the item-level
// check-out, so other units of the same item stay available).
itemsRouter.post(
  "/:id/units/:unitId/checkout",
  asyncHandler(async (req, res) => {
    const { entityId, note } = parse(checkoutSchema, req.body);
    await checkOutUnit(param(req, "unitId"), entityId, currentUser(req).oid, note);
    res.json(await svc.getItemDetail(param(req, "id")));
  }),
);

itemsRouter.post(
  "/:id/units/:unitId/checkin",
  asyncHandler(async (req, res) => {
    const { note } = parse(checkinSchema, req.body);
    await checkInUnit(param(req, "unitId"), currentUser(req).oid, note);
    res.json(await svc.getItemDetail(param(req, "id")));
  }),
);

// Random spot-check candidate for a container being moved (child or location-mate).
itemsRouter.get(
  "/:id/spot-check-candidate",
  asyncHandler(async (req, res) => {
    res.json({ candidate: await getCandidate(param(req, "id")) });
  }),
);

// Record a spot-check result on a candidate item (:id is the candidate).
itemsRouter.post(
  "/:id/spot-check",
  asyncHandler(async (req, res) => {
    const { seen } = parse(spotCheckSchema, req.body);
    const user = currentUser(req);
    await recordSpotCheck(param(req, "id"), seen, user.oid, user.name);
    res.json({ ok: true });
  }),
);
