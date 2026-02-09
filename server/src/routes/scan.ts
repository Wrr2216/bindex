import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parse, param } from "../lib/http";
import { currentUser } from "../auth/middleware";
import { getByIdentifier } from "../services/items";
import { enrich } from "../services/enrichment";

export const scanRouter = Router();

// GET /api/scan/:code
// Hit  -> { found:true, item }
// Miss -> { found:false, code }   (the client then fetches enrichment separately
//          via POST /api/enrich so the create form opens instantly instead of
//          blocking on a slow web-search lookup)
scanRouter.get(
  "/:code",
  asyncHandler(async (req, res) => {
    const code = param(req, "code");
    const match = await getByIdentifier(code, currentUser(req).oid);
    if (match) {
      res.json({ found: true, item: match });
      return;
    }
    res.json({ found: false, code });
  }),
);

const enrichSchema = z.object({ code: z.string().min(1), refresh: z.boolean().optional() });

export const enrichRouter = Router();

enrichRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { code, refresh } = parse(enrichSchema, req.body);
    res.json(await enrich(code, { refresh }));
  }),
);
