import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parse } from "../lib/http";
import { askSearch } from "../services/query";

const KINDS = ["physical", "digital", "all"] as const;
type Kind = (typeof KINDS)[number];

const body = z.object({ query: z.string().min(1).max(500) });

export const searchRouter = Router();

/** Search by describing what you want rather than filling in fields. */
searchRouter.post(
  "/ask",
  asyncHandler(async (req, res) => {
    const { query } = parse(body, req.body);
    const requested = typeof req.query.kind === "string" ? req.query.kind : "physical";
    const kind: Kind = KINDS.includes(requested as Kind) ? (requested as Kind) : "physical";
    res.json(await askSearch(query, kind));
  }),
);
