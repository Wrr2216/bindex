import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { claimActivity, type Claim } from "../../db/schema";
import { actorFromOid, publish, registerEventTypes, type EventActor } from "../event-backbone";
import type { ClaimActor } from "./shared";

/**
 * Claims in the audit log and on webhooks. Every change a claim goes through
 * is published once its transaction has committed, and the activity row that
 * records it is then pointed at the audit-log entry, so the claim's own
 * history links to the tamper-evident one.
 */

registerEventTypes([
  { type: "claim.created", group: "Claims", subject: "claim", description: "A claim or incident report was opened." },
  { type: "claim.updated", group: "Claims", subject: "claim", description: "A claim's details changed." },
  {
    type: "claim.status_changed",
    group: "Claims",
    subject: "claim",
    description: "A claim was submitted, reviewed, approved, denied, paid, closed or reopened.",
  },
  { type: "claim.assigned", group: "Claims", subject: "claim", description: "A claim was given to a reviewer." },
  { type: "claim.commented", group: "Claims", subject: "claim", description: "Someone commented on a claim." },
  { type: "claim.lines_changed", group: "Claims", subject: "claim", description: "Lines were added to, changed on or removed from a claim." },
  { type: "claim.exported", group: "Claims", subject: "claim", description: "A claim's PDF or spreadsheet was downloaded." },
  {
    type: "claim.sla_breached",
    group: "Claims",
    subject: "claim",
    description: "A submitted claim passed its decision deadline without a decision.",
  },
]);

/**
 * Someone acting through a portal grant has no account. The audit log's
 * actor kinds are fixed, so the grant is recorded as a system actor whose id
 * names it and whose name says who holds it.
 */
export function eventActor(actor: ClaimActor): EventActor {
  if (actor.grantId) return { kind: "system", id: `portal-grant:${actor.grantId}`, name: `${actor.name ?? "Portal"} (portal)` };
  return actorFromOid(actor.userOid, actor.name);
}

/** The facts every claim event carries, so a receiver can act without asking back. */
export function claimFacts(claim: Claim) {
  return {
    code: claim.code,
    type: claim.type,
    status: claim.status,
    title: claim.title,
    jobId: claim.jobId,
    shipmentId: claim.shipmentId,
    currency: claim.currency,
    estimatedTotalCents: claim.estimatedTotalCents,
    approvedTotalCents: claim.approvedTotalCents,
    paidTotalCents: claim.paidTotalCents,
    assignee: claim.assigneeUserOid ? { id: claim.assigneeUserOid, name: claim.assigneeName } : null,
  };
}

/**
 * Publish, then link the activity row to the entry. Never throws: publish()
 * does not, and a failed link only leaves the row without its pointer.
 */
export async function announce(
  type: string,
  claim: Claim,
  data: Record<string, unknown>,
  actor: ClaimActor,
  activityId?: string | null,
): Promise<number | null> {
  const entry = await publish(type, { ...claimFacts(claim), ...data }, {
    actor: eventActor(actor),
    subject: { type: "claim", id: claim.id },
  });
  if (entry && activityId) {
    await db
      .update(claimActivity)
      .set({ auditLogId: entry.id })
      .where(eq(claimActivity.id, activityId))
      .catch(() => undefined);
  }
  return entry?.id ?? null;
}
