import { Router } from "express";
import { asyncHandler } from "../lib/http";
import { getConfig } from "../services/config";

export const manifestRouter = Router();

/**
 * The web app manifest, built from the instance configuration rather than
 * shipped as a static file, so an installed home-screen icon carries the name
 * and colour the deployment chose.
 */
manifestRouter.get(
  "/manifest.webmanifest",
  asyncHandler(async (_req, res) => {
    const config = await getConfig();
    res.type("application/manifest+json");
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      name: config.orgName ? `${config.appName} · ${config.orgName}` : config.appName,
      short_name: config.appName,
      description: config.tagline,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0f172a",
      theme_color: config.accentColor,
      icons: [
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
      ],
    });
  }),
);
