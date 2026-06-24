import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parse, param } from "../lib/http";
import { currentUser } from "../auth/middleware";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/apiKeys";

export const apiKeysRouter = Router();

apiKeysRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ keys: await listApiKeys() });
  }),
);

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["read", "read_write"]),
});

apiKeysRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, scope } = parse(createSchema, req.body);
    // Response includes the plaintext key: the only time it is ever returned.
    res.status(201).json(await createApiKey(name, scope, currentUser(req).oid));
  }),
);

apiKeysRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const revoked = await revokeApiKey(param(req, "id"));
    if (!revoked) {
      res.status(404).json({ error: "API key not found", code: "not_found" });
      return;
    }
    res.status(204).end();
  }),
);
