import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { env } from "../env";
import { logger } from "../lib/logger";
import { describeError } from "../lib/errors";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  // pg's default (10s), stated explicitly: idle connections go back to Postgres
  // instead of being parked for the life of the process.
  idleTimeoutMillis: 10_000,
  // Fail a request in ~10s rather than hanging forever when the pool is full or
  // the server is refusing connections.
  connectionTimeoutMillis: 10_000,
});

// A pool with no "error" listener rethrows idle-client errors as an uncaught
// exception, which takes the whole server down when Postgres drops a backend.
pool.on("error", (err) => logger.error("db.pool.error", { err: describeError(err) }));

export const db = drizzle(pool, { schema });

export type Database = typeof db;
