import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { custodyControls, custodyTransferItems, custodyTransfers } from "../../db/schema";

/**
 * Custody in the instance backup. services/backup.ts lists these tables and
 * calls the functions below. The signatures and receipts these rows point to
 * are attachments, which the JSON backup leaves out (see
 * docs/media-ai-core.md); they are not deleted by a restore, and ids are kept,
 * so a restore onto the same database verifies as before.
 *
 * Signing links are secrets and stay out of the file, as portal links do. A
 * transfer that still exists and is still open keeps its current link; a link
 * hash in the file is never trusted.
 */

/** Parent-before-child order, which is also the insert order. */
export const CUSTODY_TABLES = ["custody_controls", "custody_transfers", "custody_transfer_items"] as const;
export type CustodyTable = (typeof CUSTODY_TABLES)[number];

const TABLE = {
  custody_controls: custodyControls,
  custody_transfers: custodyTransfers,
  custody_transfer_items: custodyTransferItems,
} as const;

type Executor = Pick<typeof db, "delete" | "insert" | "execute">;

export async function exportCustodyTables(): Promise<Record<CustodyTable, Record<string, unknown>[]>> {
  const [controls, transfers, lines] = await Promise.all([
    db.select().from(custodyControls),
    // A signing link's hash is a live credential; it stays on this server.
    db.select().from(custodyTransfers).then((rows) => rows.map((r) => ({ ...r, linkTokenHash: null }))),
    db.select().from(custodyTransferItems),
  ]);
  return { custody_controls: controls, custody_transfers: transfers, custody_transfer_items: lines };
}

/**
 * Clear before items and jobs are deleted, so nothing cascades half-way. The
 * live signing links are parked first for restoreCustodyTables.
 */
export async function clearCustodyTables(tx: Executor): Promise<void> {
  await tx.execute(sql`
    CREATE TEMP TABLE backup_kept_custody_links ON COMMIT DROP AS
    SELECT id, link_token_hash, link_party, link_expires_at, link_created_by, link_used_at
      FROM custody_transfers WHERE link_token_hash IS NOT NULL`);
  for (const t of [...CUSTODY_TABLES].reverse()) await tx.delete(TABLE[t]);
}

/** Insert after items, locations, holders and jobs are back. */
export async function restoreCustodyTables(tx: Executor, data: Record<CustodyTable, Record<string, unknown>[]>): Promise<void> {
  for (const t of CUSTODY_TABLES) {
    // A link hash in the file did not come from this server's export; never trust one.
    const rows = t === "custody_transfers" ? data[t].map((r) => ({ ...r, linkTokenHash: null })) : data[t];
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(TABLE[t]).values(rows.slice(i, i + 500) as never);
    }
  }
  // A completed or void transfer never holds a link; see signInTx and voidTransfer.
  await tx.execute(sql`
    UPDATE custody_transfers t
       SET link_token_hash = k.link_token_hash, link_party = k.link_party, link_expires_at = k.link_expires_at,
           link_created_by = k.link_created_by, link_used_at = k.link_used_at
      FROM backup_kept_custody_links k
     WHERE k.id = t.id AND t.status IN ('draft', 'locked')`);
}
