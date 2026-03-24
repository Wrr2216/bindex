import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parse, param } from "../lib/http";
import * as svc from "../services/entities";

const entitySchema = z.object({
  name: z.string().min(1),
  kind: z.string().nullish(),
  notes: z.string().nullish(),
});

export const entitiesRouter = Router();

entitiesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await svc.listEntities());
  }),
);

entitiesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createEntity(parse(entitySchema, req.body)));
  }),
);

entitiesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await svc.updateEntity(param(req, "id"), parse(entitySchema.partial(), req.body)));
  }),
);

entitiesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await svc.deleteEntity(param(req, "id"));
    res.status(204).end();
  }),
);
