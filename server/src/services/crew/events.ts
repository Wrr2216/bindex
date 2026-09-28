import { actorFromOid, publish, registerEventTypes } from "../event-backbone";
import type { CrewActor } from "./shared";

/**
 * Crew events on the event backbone: every check-in, refusal, override and
 * credential change lands in the tamper-evident audit log and can be sent to
 * a webhook (a safety manager's alert on every override, a payroll system
 * following check-outs). Phone numbers and notes are left out: the feed is
 * readable by every signed-in user and API key.
 */

const GROUP = "Crew";

registerEventTypes([
  { type: "crew.checked_in", group: GROUP, subject: "job", description: "A worker was checked in on a job, with their compliance at the time." },
  {
    type: "crew.check_in_refused",
    group: GROUP,
    subject: "job",
    description: "A check-in was refused because a required credential was missing or not valid.",
  },
  {
    type: "crew.check_in_overridden",
    group: GROUP,
    subject: "job",
    description: "A worker was let in despite a blocking credential problem; carries who overrode it and why.",
  },
  { type: "crew.checked_out", group: GROUP, subject: "job", description: "A worker was checked out of a job, with the minutes worked." },
  { type: "crew.checkin_updated", group: GROUP, subject: "job", description: "A check-in's times, break or notes were corrected." },
  { type: "crew.checkin_deleted", group: GROUP, subject: "job", description: "A check-in was deleted." },
  { type: "crew.worker_created", group: GROUP, subject: "crew_worker", description: "A worker was added." },
  { type: "crew.worker_updated", group: GROUP, subject: "crew_worker", description: "A worker's details changed, or their badge was reissued." },
  { type: "crew.worker_deleted", group: GROUP, subject: "crew_worker", description: "A worker was deleted." },
  {
    type: "crew.credential_changed",
    group: GROUP,
    subject: "crew_worker",
    description: "A credential was added, changed or removed, by a person or by the external verifier.",
  },
  {
    type: "crew.credentials_expiring",
    group: GROUP,
    description: "The daily digest of credentials that have expired or expire soon.",
  },
  { type: "crew.policy_changed", group: GROUP, subject: "job_type", description: "A job type's required credentials or check-in policy changed." },
]);

export function crewEvent(
  type: string,
  data: Record<string, unknown>,
  actor: CrewActor | null,
  subject: { type: string; id: string } | null,
): Promise<unknown> {
  return publish(type, data, { actor: actorFromOid(actor?.userOid ?? null, actor?.name ?? null), subject });
}
