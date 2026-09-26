import { Router } from "express";
import { requireApiAuth, requireAdmin, currentUser } from "../auth/middleware";
import { attachApiKeyUser } from "../auth/apiKey";
import { asyncHandler, param } from "../lib/http";
import { removeIdentifier } from "../services/items";
import { itemsRouter } from "./items";
import { locationsRouter } from "./locations";
import { auditRouter } from "./audit";
import { companiesRouter } from "./companies";
import { entitiesRouter } from "./entities";
import { scanRouter, enrichRouter } from "./scan";
import { printRouter } from "./print";
import { ninjaoneRouter } from "./ninjaone";
import { registrarsRouter } from "./registrars";
import { statsRouter, reportsRouter } from "./stats";
import { settingsRouter } from "./settings";
import { searchRouter } from "./search";
import { backupRouter } from "./backup";
import { imageRouter } from "./image";
import { photosRouter } from "./photos";
import { consumablesRouter } from "./consumables";

export const apiRouter = Router();

// Everything below needs a signed-in session or a valid API key.
apiRouter.use(attachApiKeyUser);
apiRouter.use(requireApiAuth);

apiRouter.get("/me", (req, res) => res.json({ user: currentUser(req) }));

apiRouter.use("/items", itemsRouter);
apiRouter.use("/locations", locationsRouter);
apiRouter.use("/audit", auditRouter);
apiRouter.use("/companies", companiesRouter);
apiRouter.use("/entities", entitiesRouter);
apiRouter.use("/scan", scanRouter);
apiRouter.use("/enrich", enrichRouter);
apiRouter.use("/print", printRouter);
apiRouter.use("/ninjaone", ninjaoneRouter);
apiRouter.use("/registrars", registrarsRouter);
apiRouter.use("/stats", statsRouter);
apiRouter.use("/reports", reportsRouter);
apiRouter.use("/settings", settingsRouter);
apiRouter.use("/search", searchRouter);
apiRouter.use("/backup", requireAdmin, backupRouter);
apiRouter.use("/image", imageRouter);
apiRouter.use("/photos", photosRouter);
apiRouter.use("/consumables", consumablesRouter);

apiRouter.delete(
  "/identifiers/:id",
  asyncHandler(async (req, res) => {
    await removeIdentifier(param(req, "id"));
    res.status(204).end();
  }),
);
