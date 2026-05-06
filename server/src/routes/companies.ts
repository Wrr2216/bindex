import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parse, param } from "../lib/http";
import * as svc from "../services/companies";

const companySchema = z.object({
  name: z.string().min(1),
  notes: z.string().nullish(),
});

export const companiesRouter = Router();

companiesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await svc.listCompanies());
  }),
);

companiesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parse(companySchema, req.body);
    res.status(201).json(await svc.createCompany(input));
  }),
);

companiesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const patch = parse(companySchema.partial(), req.body);
    res.json(await svc.updateCompany(param(req, "id"), patch));
  }),
);

companiesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await svc.deleteCompany(param(req, "id"));
    res.status(204).end();
  }),
);
