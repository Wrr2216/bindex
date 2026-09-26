import type { Inspection } from "../../db/schema";
import { actorFromOid, publish, registerEventTypes } from "../event-backbone";

/**
 * Inspection events for the audit log and webhooks. Published after the
 * change commits; publish() never throws, so a failure to audit never fails
 * the inspection.
 */

registerEventTypes([
  { type: "inspection.created", group: "Inspections", subject: "inspection", description: "A site inspection was started" },
  {
    type: "inspection.finding_added",
    group: "Inspections",
    subject: "inspection",
    description: "Damage was recorded on an inspection",
  },
  {
    type: "inspection.finding_updated",
    group: "Inspections",
    subject: "inspection",
    description: "A finding on an inspection was changed, or paired with a pre-inspection finding",
  },
  {
    type: "inspection.finding_removed",
    group: "Inspections",
    subject: "inspection",
    description: "A finding was removed from an inspection",
  },
  {
    type: "inspection.completed",
    group: "Inspections",
    subject: "inspection",
    description: "An inspection was completed; carries the comparison counts for a post-inspection",
  },
  { type: "inspection.reopened", group: "Inspections", subject: "inspection", description: "An inspection was reopened for changes" },
  {
    type: "inspection.signoff_added",
    group: "Inspections",
    subject: "inspection",
    description: "The facility contact or the crew lead signed an inspection",
  },
  { type: "inspection.signed", group: "Inspections", subject: "inspection", description: "Both sign-offs are in" },
  { type: "inspection.deleted", group: "Inspections", subject: "inspection", description: "An inspection was deleted" },
  {
    type: "inspection.share_created",
    group: "Inspections",
    subject: "inspection",
    description: "A read-only link to an inspection report was created",
  },
  {
    type: "inspection.share_revoked",
    group: "Inspections",
    subject: "inspection",
    description: "A read-only link to an inspection report was revoked",
  },
]);

export async function publishInspection(
  type: string,
  inspection: Pick<Inspection, "id" | "code" | "kind" | "status" | "jobId" | "siteName">,
  userOid: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await publish(
    type,
    {
      code: inspection.code,
      kind: inspection.kind,
      status: inspection.status,
      site: inspection.siteName,
      jobId: inspection.jobId,
      ...data,
    },
    { actor: actorFromOid(userOid), subject: { type: "inspection", id: inspection.id } },
  );
}
