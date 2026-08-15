import { Router } from "express";
import { env } from "../env";
import { asyncHandler } from "../lib/http";
import { getConfig } from "../services/config";

export const configRouter = Router();

/**
 * Instance configuration for the browser. Deliberately unauthenticated: the
 * sign-in screen needs the name and colours before anyone has signed in. It
 * carries nothing sensitive, only which features are switched on and what
 * things are called.
 */
configRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const config = await getConfig();
    res.json({
      ...config,
      label: {
        widthMm: env.LABEL_WIDTH_MM,
        heightMm: env.LABEL_HEIGHT_MM,
      },
      integrations: {
        ninjaone: env.ninjaoneConfigured,
        registrars: env.registrarsConfigured,
        lookup: Boolean(env.UPC_API_KEY) || env.UPC_API_PROVIDER === "upcitemdb",
        webSearch: env.webSearchConfigured,
        languageModel: env.llmConfigured,
      },
    });
  }),
);
