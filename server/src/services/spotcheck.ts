import { eq } from "drizzle-orm";
import { db, pool } from "../db/client";
import { items } from "../db/schema";
import { recordEvent } from "./items";

/**
 * Pick a random spot-check candidate for a container being moved: one of its
 * child items OR an item sharing its current location (excluding itself).
 * Returns null when there's nothing to spot-check.
 */
export async function getCandidate(containerId: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM items
      WHERE id <> $1
        AND (
          parent_item_id = $1
          OR (location_id IS NOT NULL
              AND location_id = (SELECT location_id FROM items WHERE id = $1))
        )
      ORDER BY random()
      LIMIT 1`,
    [containerId],
  );
  return rows[0] ?? null;
}

/** Record a spot-check result on a candidate item. */
export async function recordSpotCheck(
  candidateId: string,
  seen: boolean,
  userOid: string | null,
  userName: string,
): Promise<void> {
  if (seen) {
    await db
      .update(items)
      .set({
        lastSpotCheckedAt: new Date(),
        lastSpotCheckedBy: userName,
        flaggedMissing: false,
        updatedAt: new Date(),
      })
      .where(eq(items.id, candidateId));
    await recordEvent(candidateId, userOid, "updated", { spotCheck: "seen", by: userName });
  } else {
    await db
      .update(items)
      .set({ flaggedMissing: true, updatedAt: new Date() })
      .where(eq(items.id, candidateId));
    await recordEvent(candidateId, userOid, "updated", { spotCheck: "missing", by: userName });
  }
}
