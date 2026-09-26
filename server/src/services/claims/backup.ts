import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { db } from "../../db/client";
import * as schema from "../../db/schema";
import { claimActivity, claimLines, claims } from "../../db/schema";

/**
 * Claims in the instance backup. services/backup.ts lists the tables and calls
 * these, so the knowledge of the tables stays here.
 */

type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

/** Parent-before-child order, which is also the insert order. */
export const CLAIMS_TABLES = ["claims", "claim_lines", "claim_activity"] as const;
export type ClaimsTable = (typeof CLAIMS_TABLES)[number];

export const CLAIMS_DATE_FIELDS: Record<ClaimsTable, string[]> = {
  claims: [
    "occurredAt",
    "assignedAt",
    "submittedAt",
    "decidedAt",
    "paidAt",
    "closedAt",
    "slaDueAt",
    "slaBreachedAt",
    "evidenceFrozenAt",
    "createdAt",
    "updatedAt",
  ],
  claim_lines: ["createdAt", "updatedAt"],
  claim_activity: ["createdAt"],
};

const TABLE = { claims, claim_lines: claimLines, claim_activity: claimActivity } as const;

export async function exportClaimsTables(): Promise<Record<ClaimsTable, Record<string, unknown>[]>> {
  const [c, l, a] = await Promise.all([db.select().from(claims), db.select().from(claimLines), db.select().from(claimActivity)]);
  return { claims: c, claim_lines: l, claim_activity: a };
}

/**
 * Cleared before the items, jobs and locations they point at, and restored
 * after them. Like jobs, a file written before claims existed restores with
 * none: a restore puts the instance back as the file describes it.
 */
export async function clearClaimsTables(tx: Executor): Promise<void> {
  for (const t of [...CLAIMS_TABLES].reverse()) await tx.delete(TABLE[t]);
}

export async function restoreClaimsTables(
  tx: Executor,
  data: Record<ClaimsTable, Record<string, unknown>[]>,
): Promise<void> {
  for (const t of CLAIMS_TABLES) {
    const rows = data[t];
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(TABLE[t]).values(rows.slice(i, i + 500) as never);
    }
  }
}
