import { Router } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { badRequest } from "../lib/errors";
import { currentUser, requireAdmin } from "../auth/middleware";
import { rateLimit } from "../lib/rateLimit";
import {
  changeOwnPassword,
  createUser,
  deleteUser,
  listUsers,
  updateUser,
} from "../services/users";

export const usersRouter = Router();

const passwordChange = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(512),
});

// The current password is checked here too, so guessing it is limited per account.
const passwordChangeLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => `oid:${currentUser(req).oid}`,
});

/** Anyone may change their own password; everything below is administrator-only. */
usersRouter.post(
  "/me/password",
  passwordChangeLimit,
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { currentPassword, newPassword } = parse(passwordChange, req.body);
    await changeOwnPassword(me.oid, currentPassword, newPassword);
    res.json({ ok: true });
  }),
);

usersRouter.use(requireAdmin);

usersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await listUsers());
  }),
);

const newUser = z.object({
  email: z.string().min(3).max(320),
  name: z.string().max(200).default(""),
  role: z.enum(["admin", "member"]).default("member"),
  // Omitted for an account that will only ever arrive through single sign-on.
  password: z.string().min(1).max(512).optional(),
});

usersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createUser(parse(newUser, req.body)));
  }),
);

const userPatch = z.object({
  name: z.string().max(200).optional(),
  role: z.enum(["admin", "member"]).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(1).max(512).optional(),
});

usersRouter.patch(
  "/:oid",
  asyncHandler(async (req, res) => {
    const oid = param(req, "oid");
    const patch = parse(userPatch, req.body);
    if (oid === currentUser(req).oid && (patch.role === "member" || patch.disabled)) {
      throw badRequest("You cannot remove your own access.");
    }
    res.json(await updateUser(oid, patch));
  }),
);

usersRouter.delete(
  "/:oid",
  asyncHandler(async (req, res) => {
    const oid = param(req, "oid");
    if (oid === currentUser(req).oid) throw badRequest("You cannot delete your own account.");
    await deleteUser(oid);
    res.status(204).end();
  }),
);
