import { Router } from "express";
import { asyncHandler } from "../lib/http";
import { currentUser, requireAdmin } from "../auth/middleware";
import { latestRegistrarStatus, runRegistrarSync } from "../services/registrars/sync";

export const registrarsRouter = Router();

registrarsRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    res.json(await latestRegistrarStatus());
  }),
);

registrarsRouter.post(
  "/sync",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await runRegistrarSync(currentUser(req).oid));
  }),
);
