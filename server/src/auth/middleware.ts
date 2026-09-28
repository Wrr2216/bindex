import type { Request, RequestHandler } from "express";
import { env } from "../env";
import { forbidden } from "../lib/errors";
import type { SessionUser } from "./session";

/**
 * The identity used when AUTH_MODE=trusted. Every request is this person, which
 * is only safe where something in front of the app already decided who may
 * reach it: a home network, a VPN, or an authenticating reverse proxy.
 */
const TRUSTED_USER: SessionUser = {
  oid: "trusted:owner",
  email: env.TRUSTED_USER_EMAIL,
  name: env.TRUSTED_USER_NAME,
  role: "admin",
};

export const attachTrustedUser: RequestHandler = (req, _res, next) => {
  // API-key requests are skipped: the header is authoritative, and writing a
  // user to the session would persist a session row for every key request.
  if (env.trustedAuth && !req.session.user && !req.get("x-api-key")) {
    req.session.user = TRUSTED_USER;
  }
  next();
};

/** Guards /api routes; answers with JSON rather than a redirect. */
export const requireApiAuth: RequestHandler = (req, res, next) => {
  if (req.session.user || req.apiKeyUser) return next();
  res.status(401).json({ error: "Not authenticated", code: "unauthorized" });
};

/**
 * Guards endpoints that change how the instance behaves for everyone: the
 * configuration, accounts, integrations and backups. API keys never qualify;
 * these actions are deliberately browser-only.
 */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  // The key is authoritative when present, even alongside an admin's cookie.
  if (req.apiKeyUser) return next(forbidden("This action requires an administrator."));
  const user = req.session.user;
  if (!user) return next(forbidden("This action requires an administrator."));
  if (user.role !== "admin") return next(forbidden("This action requires an administrator."));
  next();
};

export function currentUser(req: Request): SessionUser {
  // The API-key user wins: the header is authoritative, and under trusted auth
  // a session user exists on every request.
  const user = req.apiKeyUser ?? req.session.user;
  if (!user) throw new Error("currentUser called without a session user");
  return user;
}
