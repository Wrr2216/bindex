import { db } from "../../db/client";
import { custodyControls, custodyTransferItems, custodyTransfers } from "../../db/schema";

/**
 * Custody in the instance backup. services/backup.ts lists these tables and
 * calls the functions below. The signatures and receipts these rows point to
 * are attachments, which the JSON backup leaves out (see
 * docs/media-ai-core.md); they are not deleted by a restore, and ids are kept,
 * so a restore onto the same database verifies as before.
 */

/** Parent-before-child order, which is also the insert order. */
export const CUSTODY_TABLES = ["custody_controls", "custody_transfers", "custody_transfer_items"] as const;
export type CustodyTable = (typeof CUSTODY_TABLES)[number];

const TABLE = {
  custody_controls: custodyControls,
  custody_transfers: custodyTransfers,
  custody_transfer_items: custodyTransferItems,
} as const;

type Executor = Pick<typeof db, "delete" | "insert">;

export async function exportCustodyTables(): Promise<Record<CustodyTable, Record<string, unknown>[]>> {
  const [controls, transfers, lines] = await Promise.all([
    db.select().from(custodyControls),
    // A signing link's hash is a live credential; a restored transfer needs a new link.
    db.select().from(custodyTransfers).then((rows) => rows.map((r) => ({ ...r, linkTokenHash: null }))),
    db.select().from(custodyTransferItems),
  ]);
  return { custody_controls: controls, custody_transfers: transfers, custody_transfer_items: lines };
}

/** Clear before items and jobs are deleted, so nothing cascades half-way. */
export async function clearCustodyTables(tx: Executor): Promise<void> {
  for (const t of [...CUSTODY_TABLES].reverse()) await tx.delete(TABLE[t]);
}

/** Insert after items, locations, holders and jobs are back. */
export async function restoreCustodyTables(tx: Executor, data: Record<CustodyTable, Record<string, unknown>[]>): Promise<void> {
  for (const t of CUSTODY_TABLES) {
    const rows = data[t];
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(TABLE[t]).values(rows.slice(i, i + 500) as never);
    }
  }
}
