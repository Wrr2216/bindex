import {
  onJobChanged,
  onShipmentStatusChanged,
  onStageChanged,
  onTaskStatusChanged,
  type ChangeContext,
} from "../jobs-core";
import { actorFromOid, publish, registerEventTypes, type EventActor } from "../event-backbone";

/**
 * Jobs and the event backbone were built side by side, so neither knows about
 * the other. This joins them: every job, task, stage and shipment change is
 * published, which puts it in the audit log and in front of webhooks, and
 * gives later features (stakeholder notifications, geofence milestones) one
 * stream to listen to.
 */

// A stage batch from a bulk RFID read can hold thousands of lines. The event
// keeps the counts in full and the line detail up to this many.
const MAX_LINES = 500;

function changeActor(ctx: Pick<ChangeContext, "userOid" | "deviceId" | "actor" | "via">): EventActor {
  if (ctx.userOid) return actorFromOid(ctx.userOid, ctx.actor);
  if (ctx.deviceId) return { kind: "device", id: ctx.deviceId, name: ctx.actor };
  return { kind: "system", id: null, name: ctx.actor };
}

let wired = false;

export function wireJobEvents(): void {
  if (wired) return;
  wired = true;

  registerEventTypes([
    { type: "job.created", description: "A job was created", subject: "job", group: "Jobs" },
    { type: "job.updated", description: "A job's details or status changed", subject: "job", group: "Jobs" },
    {
      type: "job.stage_changed",
      description: "Lines on a job moved to a new stage (packed, loaded, delivered, placed…)",
      subject: "job",
      group: "Jobs",
    },
    { type: "job.task_status_changed", description: "A job task changed status", subject: "job", group: "Jobs" },
    {
      type: "shipment.status_changed",
      description: "A shipment moved between planned, staged, loaded, in transit, delivered and closed",
      subject: "shipment",
      group: "Jobs",
    },
  ]);

  onJobChanged(({ job, previous, userOid }) =>
    publish(
      previous ? "job.updated" : "job.created",
      {
        code: job.code,
        name: job.name,
        status: job.status,
        previousStatus: previous?.status ?? null,
      },
      { actor: actorFromOid(userOid), subject: { type: "job", id: job.id } },
    ),
  );

  onStageChanged((changes, ctx) => {
    const byStage: Record<string, number> = {};
    for (const c of changes) byStage[c.to] = (byStage[c.to] ?? 0) + 1;
    return publish(
      "job.stage_changed",
      {
        via: ctx.via,
        deviceId: ctx.deviceId,
        note: ctx.note,
        count: changes.length,
        byStage,
        truncated: changes.length > MAX_LINES,
        lines: changes.slice(0, MAX_LINES).map((c) => ({
          jobItemId: c.jobItemId,
          itemId: c.itemId,
          unitId: c.unitId,
          shipmentId: c.shipmentId,
          from: c.from,
          to: c.to,
        })),
      },
      { actor: changeActor(ctx), subject: { type: "job", id: ctx.jobId } },
    );
  });

  onTaskStatusChanged(({ task, previousStatus, userOid }) =>
    publish(
      "job.task_status_changed",
      { jobId: task.jobId, taskId: task.id, kind: task.kind, title: task.title, from: previousStatus, to: task.status },
      { actor: actorFromOid(userOid), subject: { type: "job", id: task.jobId } },
    ),
  );

  onShipmentStatusChanged(({ shipment, from, to, forced, reason, userOid, actor }) =>
    publish(
      "shipment.status_changed",
      { code: shipment.code, jobId: shipment.jobId, name: shipment.name, from, to, forced, reason },
      { actor: actorFromOid(userOid, actor), subject: { type: "shipment", id: shipment.id } },
    ),
  );
}
