import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parse } from "../lib/http";
import { requireAdmin } from "../auth/middleware";
import { getConfig, updateConfig } from "../services/config";
import { apiKeysRouter } from "./apiKeys";
import { usersRouter } from "./users";

export const settingsRouter = Router();

// Account management is nested here but has its own guard: everyone may change
// their own password, only administrators may manage other people.
settingsRouter.use("/users", usersRouter);

settingsRouter.use(requireAdmin);
settingsRouter.use("/api-keys", apiKeysRouter);

settingsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await getConfig());
  }),
);

const term = z.object({
  singular: z.string().min(1).max(40).optional(),
  plural: z.string().min(1).max(40).optional(),
});

const configPatch = z.object({
  appName: z.string().min(1).max(60).optional(),
  orgName: z.string().max(120).optional(),
  tagline: z.string().max(200).optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #0284c7")
    .optional(),
  assetCodePrefix: z.string().max(8).optional(),
  locationCodePrefix: z.string().max(8).optional(),
  currency: z.string().length(3).optional(),
  locale: z.string().max(20).optional(),
  terms: z
    .object({
      item: term.optional(),
      location: term.optional(),
      group: term.optional(),
      holder: term.optional(),
    })
    .optional(),
  features: z
    .object({
      groups: z.boolean().optional(),
      holders: z.boolean().optional(),
      domains: z.boolean().optional(),
      units: z.boolean().optional(),
      assignments: z.boolean().optional(),
      audit: z.boolean().optional(),
      printing: z.boolean().optional(),
      vehicleFields: z.boolean().optional(),
      lookup: z.boolean().optional(),
      askSearch: z.boolean().optional(),
      spotCheck: z.boolean().optional(),
      tracking: z.boolean().optional(),
      aiCapture: z.boolean().optional(),
      jobs: z.boolean().optional(),
      registerReconcile: z.boolean().optional(),
      consumables: z.boolean().optional(),
      legacyTags: z.boolean().optional(),
      offline: z.boolean().optional(),
      bulkCapture: z.boolean().optional(),
      aiCondition: z.boolean().optional(),
      placement: z.boolean().optional(),
    })
    .optional(),
});

settingsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await updateConfig(parse(configPatch, req.body)));
  }),
);
