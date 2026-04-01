import { Router } from "express";
import { asyncHandler } from "../lib/http";
import { getStats, itemsCsv } from "../services/stats";

export const statsRouter = Router();

statsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await getStats());
  }),
);

export const reportsRouter = Router();

reportsRouter.get(
  "/items.csv",
  asyncHandler(async (_req, res) => {
    const csv = await itemsCsv();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="inventory.csv"');
    res.send(csv);
  }),
);
