import { Router, json } from "express";
import { asyncHandler } from "../lib/http";
import { badRequest } from "../lib/errors";
import { logger } from "../lib/logger";
import { currentUser } from "../auth/middleware";
import { buildBackup, restoreBackup } from "../services/backup";

export const backupRouter = Router();

// Download a full JSON snapshot as a file attachment.
backupRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    const backup = await buildBackup();
    const stamp = backup.exportedAt.slice(0, 19).replace(/[:T]/g, "");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="bindex-backup-${stamp}.json"`);
    res.send(JSON.stringify(backup, null, 2));
    logger.info("backup.export", { by: currentUser(req).oid, counts: backup.counts });
  }),
);

// Restore from a snapshot. DESTRUCTIVE: replaces all inventory data. The larger
// body limit overrides the app's 1mb default (see index.ts json exclusion).
backupRouter.post(
  "/import",
  json({ limit: "64mb" }),
  asyncHandler(async (req, res) => {
    if (req.body?.confirm !== true) {
      throw badRequest("Restore replaces all current inventory data. Set confirm:true to proceed.");
    }
    const result = await restoreBackup(req.body);
    logger.warn("backup.import.replaced", { by: currentUser(req).oid, restored: result.restored });
    res.json({ ok: true, ...result });
  }),
);
