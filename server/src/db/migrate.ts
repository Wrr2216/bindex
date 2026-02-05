import fs from "node:fs";
import path from "node:path";
import { pool } from "./client";
import { env } from "../env";
import { logger } from "../lib/logger";
import { describeError } from "../lib/errors";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

/**
 * Apply every migration in /migrations that is not already recorded, in
 * filename order. Each runs in its own transaction, so a failure leaves the
 * database at the last migration that worked rather than part-way through one.
 */
export async function runMigrations(): Promise<void> {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new Error(
      `Cannot connect to Postgres (${env.DATABASE_URL.replace(/:[^:@/]*@/, ":****@")}). ` +
        `Is the database running? Start one with \`pnpm db:up\`. Details: ${describeError(err)}`,
    );
  }
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM _migrations");
    const applied = new Set(rows.map((r) => r.name));

    const files = fs.existsSync(MIGRATIONS_DIR)
      ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
      : [];

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      logger.info("db.migrate.apply", { file });
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        count += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${String(err)}`);
      }
    }
    logger.info("db.migrate.done", { newlyApplied: count, total: files.length });
  } finally {
    client.release();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("db.migrate.failed", { err: String(err) });
      process.exit(1);
    });
}
