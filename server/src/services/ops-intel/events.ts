import { publish, registerEventTypes, type EventActor } from "../event-backbone";

/**
 * Anomalies as events, so they reach the audit log, webhooks and the polling
 * feed. docs/ops-intel.md lists the shapes.
 */

let registered = false;

export function registerOpsEventTypes(): void {
  if (registered) return;
  registered = true;
  registerEventTypes([
    {
      type: "ops.anomaly_detected",
      group: "Operations insights",
      subject: "ops_anomaly",
      description: "A rule found a new problem: a carton left behind, a duplicate record, a tag in two places at once…",
    },
    {
      type: "ops.anomaly_resolved",
      group: "Operations insights",
      subject: "ops_anomaly",
      description: "An anomaly was resolved by a person (fixed or dismissed) or cleared because a run no longer found it.",
    },
    {
      type: "ops.run_completed",
      group: "Operations insights",
      subject: "ops_run",
      description: "A run of the anomaly rules opened or cleared something; carries the counts per rule.",
    },
  ]);
}

export type AnomalyEventRow = {
  id: string;
  rule: string;
  key: string;
  severity: string;
  title: string;
  subjectType: string;
  subjectId: string;
  itemId: string | null;
  jobId: string | null;
  shipmentId: string | null;
  locationId: string | null;
  link: string | null;
};

const subject = (id: string) => ({ type: "ops_anomaly", id });

const summary = (a: AnomalyEventRow) => ({
  rule: a.rule,
  key: a.key,
  severity: a.severity,
  title: a.title,
  subjectType: a.subjectType,
  subjectId: a.subjectId,
  itemId: a.itemId,
  jobId: a.jobId,
  shipmentId: a.shipmentId,
  locationId: a.locationId,
  link: a.link,
});

export function publishDetected(a: AnomalyEventRow & { reopenedFrom: string | null }) {
  return publish("ops.anomaly_detected", { ...summary(a), reopenedFrom: a.reopenedFrom }, { subject: subject(a.id) });
}

export function publishResolved(
  a: AnomalyEventRow,
  resolution: "fixed" | "dismissed" | "cleared",
  note: string | null,
  actor: EventActor | null,
) {
  return publish("ops.anomaly_resolved", { ...summary(a), resolution, note }, { actor, subject: subject(a.id) });
}

export function publishRun(runId: string, data: Record<string, unknown>) {
  return publish("ops.run_completed", data, { subject: { type: "ops_run", id: runId } });
}
