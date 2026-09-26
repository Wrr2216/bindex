import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { itemUnits, items, jobItems, jobs, portalNotes } from "../../db/schema";

/** What a grant's crew wrote, newest first, for the administrators' view of the link. */
export function grantNotes(grantId: string) {
  return db
    .select({
      id: portalNotes.id,
      author: portalNotes.author,
      condition: portalNotes.condition,
      body: portalNotes.body,
      createdAt: portalNotes.createdAt,
      jobId: portalNotes.jobId,
      jobCode: jobs.code,
      jobItemId: portalNotes.jobItemId,
      itemId: portalNotes.itemId,
      itemName: items.name,
      assetCode: items.assetCode,
      unitCode: itemUnits.assetCode,
      stage: jobItems.stage,
    })
    .from(portalNotes)
    .innerJoin(items, eq(portalNotes.itemId, items.id))
    .innerJoin(jobs, eq(portalNotes.jobId, jobs.id))
    .innerJoin(jobItems, eq(portalNotes.jobItemId, jobItems.id))
    .leftJoin(itemUnits, eq(portalNotes.unitId, itemUnits.id))
    .where(eq(portalNotes.grantId, grantId))
    .orderBy(desc(portalNotes.createdAt))
    .limit(500);
}
