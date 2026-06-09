import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler, parse } from "../lib/http";
import { env } from "../env";
import { pushCodes } from "../services/livefeed";

const scanSchema = z.object({
  epcs: z.array(z.string()),
  reader: z.string().max(64).optional(),
});

/**
 * A reader bridge runs outside any browser session, so it presents a static
 * token instead of a cookie. Tokens come from INGEST_TOKEN; with none set the
 * endpoint stays closed.
 */
const requireDeviceToken: RequestHandler = (req, res, next) => {
  if (env.ingestTokens.length === 0) {
    res.status(503).json({ error: "Device ingest not configured", code: "ingest_disabled" });
    return;
  }
  const header = req.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const token = bearer || req.get("x-device-token") || "";
  if (!token || !env.ingestTokens.includes(token)) {
    res.status(401).json({ error: "Invalid device token", code: "unauthorized" });
    return;
  }
  next();
};

export const deviceRouter = Router();
deviceRouter.use(requireDeviceToken);

// A batch of tag reads from one reader, pushed into that reader's channel.
deviceRouter.post(
  "/scan",
  asyncHandler(async (req, res) => {
    const { epcs, reader } = parse(scanSchema, req.body);
    const accepted = pushCodes(reader || "default", epcs);
    res.json({ ok: true, accepted });
  }),
);
