import { Router } from "express";
import { asyncHandler } from "../lib/http";
import { env } from "../env";
import { currentUser, requireAdmin } from "../auth/middleware";
import { logger } from "../lib/logger";
import { generators } from "../auth/oidc";
import { latestSyncStatus, runNinjaSync } from "../services/ninjaone/sync";
import {
  buildAuthorizeUrl,
  clearConnection,
  exchangeCode,
  getConnection,
} from "../services/ninjaone/client";

export const ninjaoneRouter = Router();

ninjaoneRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const [status, connection] = await Promise.all([latestSyncStatus(), getConnection()]);
    // The base URL travels with the status so the client can build asset deep
    // links without knowing which NinjaOne region this instance talks to.
    res.json({ ...status, ...connection, baseUrl: env.NINJAONE_BASE_URL });
  }),
);

// Start the interactive authorization-code flow.
ninjaoneRouter.get(
  "/connect",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const state = generators.state();
    req.session.ninjaOauth = { state };
    res.redirect(buildAuthorizeUrl(state));
  }),
);

// Redirect target: exchange the code, then return to Settings.
ninjaoneRouter.get(
  "/callback",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const saved = req.session.ninjaOauth;
    delete req.session.ninjaOauth;
    const { code, state, error } = req.query;

    if (error || typeof code !== "string" || typeof state !== "string" || !saved || state !== saved.state) {
      logger.warn("ninjaone.connect.failed", { error: String(error ?? "invalid_state") });
      res.redirect("/settings?ninja=error");
      return;
    }

    try {
      await exchangeCode(code, currentUser(req).oid);
      logger.info("ninjaone.connect.success", { oid: currentUser(req).oid });
      res.redirect("/settings?ninja=connected");
    } catch (err) {
      logger.error("ninjaone.connect.exchange_failed", { err: String(err) });
      res.redirect("/settings?ninja=error");
    }
  }),
);

ninjaoneRouter.post(
  "/disconnect",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await clearConnection();
    res.json({ ok: true });
  }),
);

ninjaoneRouter.post(
  "/sync",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await runNinjaSync(currentUser(req).oid));
  }),
);
