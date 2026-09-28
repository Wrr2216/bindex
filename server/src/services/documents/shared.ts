import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";

/** The database or an open transaction: both run the same queries. */
export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

/** Who is acting: the signed-in account (null for the system) and a display name. */
export type Actor = { userOid: string | null; name?: string | null };
