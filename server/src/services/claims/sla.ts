import { and, inArray, isNull, lt } from "drizzle-orm";
import { db } from "../../db/client";
import { claimActivity, claims } from "../../db/schema";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { announce } from "./events";

/**
 * Announces each claim that passes its decision deadline undecided, once.
 * The UPDATE claims the breach atomically, so several replicas running this
 * never announce the same claim twice.
 */
export async function checkSlaBreaches(now = new Date()): Promise<number> {
  const breached = await db
    .update(claims)
    .set({ slaBreachedAt: now })
    .where(
      and(isNull(claims.slaBreachedAt), inArray(claims.status, ["submitted", "under_review"]), lt(claims.slaDueAt, now)),
    )
    .returning();
  for (const claim of breached) {
    const [activity] = await db
      .insert(claimActivity)
      .values({ claimId: claim.id, kind: "sla", body: "Decision deadline passed", detail: { dueAt: claim.slaDueAt } })
      .returning();
    await announce("claim.sla_breached", claim, { dueAt: claim.slaDueAt }, { userOid: null, name: null }, activity?.id);
  }
  if (breached.length) logger.info("claims.sla.breached", { count: breached.length });
  return breached.length;
}

const EVERY_MS = 10 * 60_000;

export function startClaimsSlaWatch(): void {
  const run = async () => {
    try {
      if (!(await getConfig()).features.claims) return;
      await checkSlaBreaches();
    } catch (err) {
      logger.warn("claims.sla.check_failed", { err: describeError(err) });
    }
  };
  setTimeout(() => void run(), 60_000).unref();
  setInterval(() => void run(), EVERY_MS).unref();
}
