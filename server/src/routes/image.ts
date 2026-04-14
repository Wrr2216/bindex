import { Router } from "express";
import { asyncHandler } from "../lib/http";
import { validateImageUrl, fetchImageBytes } from "../services/images";

/**
 * Image proxy. Product image URLs (from enrichment) frequently break when loaded
 * directly: hotlink protection, expiry, or http:// mixed-content on our https
 * page. Fetching them server-side and re-serving from our own origin sidesteps
 * all three. Auth is inherited from the /api mount. URL vetting + the actual
 * fetch live in services/images so the photo importer can reuse them.
 */
export const imageRouter = Router();

imageRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.url === "string" ? req.query.url : "";
    const target = validateImageUrl(raw);
    const img = await fetchImageBytes(target);
    if (!img) {
      res.status(502).json({ error: "Image could not be loaded.", code: "image_unavailable" });
      return;
    }
    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    res.send(img.bytes);
  }),
);
