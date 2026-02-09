import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parse, param } from "../lib/http";
import { currentUser } from "../auth/middleware";
import * as svc from "../services/locations";
import { bulkUpdate } from "../services/items";
import { applyVerify, verifyLocation } from "../services/verify";

const locationSchema = z.object({
  name: z.string().min(1),
  address: z.string().nullish(),
  notes: z.string().nullish(),
  companyId: z.string().uuid().nullish(),
  parentId: z.string().uuid().nullish(),
});

const assignSchema = z.object({ itemIds: z.array(z.string().uuid()).min(1) });
const verifySchema = z.object({ codes: z.array(z.string()) });
const applySchema = z.object({
  presentIds: z.array(z.string().uuid()),
  missingIds: z.array(z.string().uuid()),
});

export const locationsRouter = Router();

locationsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await svc.listLocations());
  }),
);

// A location's contents (items assigned to it): backs the location detail page.
locationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await svc.getLocationDetail(param(req, "id")));
  }),
);

// Assign existing items into this location (the "Add items" picker).
locationsRouter.post(
  "/:id/items",
  asyncHandler(async (req, res) => {
    const { itemIds } = parse(assignSchema, req.body);
    await bulkUpdate(itemIds, { locationId: param(req, "id") }, currentUser(req).oid);
    res.json(await svc.getLocationDetail(param(req, "id")));
  }),
);

// Reconcile a batch of scanned tags against the location's expected contents.
locationsRouter.post(
  "/:id/verify",
  asyncHandler(async (req, res) => {
    const { codes } = parse(verifySchema, req.body);
    res.json(await verifyLocation(param(req, "id"), codes));
  }),
);

// Apply a reconciliation: mark present items checked, flag missing ones.
locationsRouter.post(
  "/:id/verify/apply",
  asyncHandler(async (req, res) => {
    const { presentIds, missingIds } = parse(applySchema, req.body);
    const user = currentUser(req);
    await applyVerify(presentIds, missingIds, user.oid, user.name);
    res.json(await svc.getLocationDetail(param(req, "id")));
  }),
);

locationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parse(locationSchema, req.body);
    res.status(201).json(await svc.createLocation(input));
  }),
);

locationsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const patch = parse(locationSchema.partial(), req.body);
    res.json(await svc.updateLocation(param(req, "id"), patch));
  }),
);

locationsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await svc.deleteLocation(param(req, "id"));
    res.status(204).end();
  }),
);
