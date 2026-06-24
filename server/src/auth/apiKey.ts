import type { RequestHandler } from "express";
import type { SessionUser } from "./session";
import { findActiveKeyByHash, hashKey, touchLastUsed } from "../services/apiKeys";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Synthetic user attached by attachApiKeyUser; never stored in the session. */
      apiKeyUser?: SessionUser;
    }
  }
}

/**
 * Routes that stay session-only even for a read-write key: instance settings and
 * accounts, whole-database backup and restore, and the browser-bound NinjaOne
 * connect flow. Matched against req.path, which is relative to the /api mount.
 */
const SESSION_ONLY_PREFIXES = [
  "/settings",
  "/backup",
  "/ninjaone/connect",
  "/ninjaone/callback",
  "/ninjaone/disconnect",
];

const isSessionOnly = (path: string): boolean =>
  SESSION_ONLY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * Authenticates requests carrying an `x-api-key` header. The header wins: an
 * unknown or revoked key is a 401 even when a valid session cookie came along
 * too. Requests without the header fall through to the session check.
 */
export const attachApiKeyUser: RequestHandler = async (req, res, next) => {
  const key = req.get("x-api-key");
  if (!key) return next();

  let row;
  try {
    row = await findActiveKeyByHash(hashKey(key));
  } catch (err) {
    next(err);
    return;
  }
  if (!row) {
    res.status(401).json({ error: "Invalid API key", code: "unauthorized" });
    return;
  }
  if (row.scope === "read" && req.method !== "GET" && req.method !== "HEAD") {
    res.status(403).json({ error: "This API key is read-only", code: "forbidden" });
    return;
  }
  if (isSessionOnly(req.path)) {
    res
      .status(403)
      .json({ error: "This endpoint requires a browser session", code: "session_required" });
    return;
  }

  // Never an administrator: the routes an administrator needs are already
  // session-only, and a key should not be able to widen its own access.
  req.apiKeyUser = {
    oid: `api-key:${row.id}`,
    email: "",
    name: `API key: ${row.name}`,
    role: "member",
  };
  touchLastUsed(row.id);
  next();
};
