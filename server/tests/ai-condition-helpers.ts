import { Client } from "pg";

/**
 * A database of this feature's own next to TEST_DATABASE_URL (same server,
 * name + "_ai_condition"), created when missing; the role needs CREATEDB.
 *
 * The condition suites restore a backup, which replaces every item, and they
 * publish events, which the webhook suite counts. Sharing one database with
 * suites running at the same time would upset both, so they stay apart.
 */
export async function ownDatabase(base: string): Promise<string> {
  const target = new URL(base);
  const name = `${target.pathname.slice(1) || "bindex"}_ai_condition`.replace(/[^a-z0-9_]/gi, "_");
  target.pathname = `/${name}`;
  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!rowCount) {
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
      } catch (err) {
        // Both suites may create it at once; the loser finds it made.
        if ((err as { code?: string }).code !== "42P04") throw err;
      }
    }
  } finally {
    await admin.end();
  }
  return target.toString();
}

/**
 * Run `fn` (the migrations) while holding an advisory lock in that database,
 * so two suites starting together do not both try to apply the same files.
 */
export async function whileLocked<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const lock = new Client({ connectionString: url });
  await lock.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(7331012)");
    return await fn();
  } finally {
    await lock.end();
  }
}
