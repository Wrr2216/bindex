import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../db/client";
import { env } from "../env";
import { logger } from "../lib/logger";
import type { UserRole } from "../db/schema";

export type SessionUser = {
  /** Stable account id: `local:<uuid>` or `<issuer-host>:<sub>`. */
  oid: string;
  email: string;
  name: string;
  role: UserRole;
};

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
    oauth?: {
      state: string;
      nonce: string;
      codeVerifier: string;
      returnTo: string;
    };
    ninjaOauth?: { state: string };
  }
}

const PgStore = connectPgSimple(session);

export const sessionMiddleware = session({
  store: new PgStore({
    pool,
    tableName: "session",
    createTableIfMissing: true,
    // The default sweep runs every 60s. Expired sessions are not urgent and
    // each sweep costs a connection from a pool shared with every request.
    pruneSessionInterval: 15 * 60,
    // Route store failures through the logger instead of dumping a raw stack.
    errorLog: (...args: unknown[]) =>
      logger.warn("session.store.error", { err: args.map(String).join(" ") }),
  }),
  name: "bindex.sid",
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
});
