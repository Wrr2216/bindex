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
import { eventBackboneRouter } from "./event-backbone";
import { trackingRouter } from "./tracking-core";
import { mediaAiCoreRouter } from "./media-ai-core";
import { jobsCoreRouter } from "./jobs-core";
import { registerReconcileRouter } from "./register-reconcile";
import { consumablesRouter } from "./consumables";
import { tagCommissioningRouter } from "./tag-commissioning";
import { idempotency, offlineFieldRouter } from "./offline-field";
import { bulkCaptureRouter } from "./bulk-capture";
import { aiConditionRouter } from "./ai-condition";
import { inspectionsRouter } from "./inspections";
import { valuationRouter } from "./valuation";
import { crewRouter } from "./crew";
import { custodyRouter } from "./custody";
import { teardownRouter } from "./teardown";
import { gpsRouter } from "./gps";
import { documentsRouter } from "./documents";

export const apiRouter = Router();

// Everything below needs a signed-in session or a valid API key.
apiRouter.use(attachApiKeyUser);
apiRouter.use(requireApiAuth);
// A retried request carrying an Idempotency-Key is answered, not re-applied.
apiRouter.use(idempotency);

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
apiRouter.use(eventBackboneRouter);
apiRouter.use("/tracking", trackingRouter);
apiRouter.use(mediaAiCoreRouter);
apiRouter.use(jobsCoreRouter);
apiRouter.use("/register-reconcile", registerReconcileRouter);
apiRouter.use("/consumables", consumablesRouter);
apiRouter.use("/tag-commissioning", tagCommissioningRouter);
apiRouter.use("/offline", offlineFieldRouter);
apiRouter.use("/bulk-capture", bulkCaptureRouter);
apiRouter.use("/condition", aiConditionRouter);
apiRouter.use("/inspections", inspectionsRouter);
apiRouter.use("/valuation", valuationRouter);
apiRouter.use("/crew", crewRouter);
apiRouter.use(custodyRouter);
apiRouter.use("/teardown", teardownRouter);
apiRouter.use("/gps", gpsRouter);
apiRouter.use(documentsRouter);

apiRouter.delete(
  "/identifiers/:id",
  asyncHandler(async (req, res) => {
    await removeIdentifier(param(req, "id"));
    res.status(204).end();
  }),
);
