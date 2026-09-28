import type { TrackingDevice } from "../../db/schema";
import { registerEventTypes, type EventActor } from "../event-backbone";

/**
 * The events GPS tracking publishes. Each goes into the audit log and out to
 * webhooks; the stakeholder portal listens for the shipment milestones and
 * geofence crossings. docs/gps.md lists their data.
 */

const GROUP = "GPS";

registerEventTypes([
  { type: "geofence.entered", group: GROUP, subject: "geofence", description: "A tracker entered a geofence" },
  { type: "geofence.exited", group: GROUP, subject: "geofence", description: "A tracker left a geofence" },
  { type: "geofence.created", group: GROUP, subject: "geofence", description: "A geofence was drawn" },
  { type: "geofence.updated", group: GROUP, subject: "geofence", description: "A geofence was changed" },
  { type: "geofence.deleted", group: GROUP, subject: "geofence", description: "A geofence was removed" },
  {
    type: "shipment.departed",
    group: GROUP,
    subject: "shipment",
    description: "A shipment's tracker left its origin geofence",
  },
  {
    type: "shipment.arrived",
    group: GROUP,
    subject: "shipment",
    description: "A shipment's tracker entered its destination geofence; delivery is waiting to be confirmed",
  },
  {
    type: "shipment.waypoint_reached",
    group: GROUP,
    subject: "shipment",
    description: "A shipment in transit entered a geofence on its way (a depot, a border, a customer site)",
  },
  { type: "tracker.assigned", group: GROUP, subject: "tracker", description: "A GPS tracker was put on a shipment or vehicle" },
  {
    type: "tracker.unassigned",
    group: GROUP,
    subject: "tracker",
    description: "A GPS tracker was taken off a shipment or vehicle, by hand or on delivery",
  },
  {
    type: "tracker.status_changed",
    group: GROUP,
    subject: "tracker",
    description: "A GPS tracker was returned, disposed of, or put back in service",
  },
  { type: "tracker.battery_low", group: GROUP, subject: "tracker", description: "A GPS tracker's battery is low" },
]);

/** Hardware is the actor for what a tracker reports. */
export const deviceActor = (d: Pick<TrackingDevice, "id" | "name">): EventActor => ({
  kind: "device",
  id: d.id,
  name: d.name,
});

export const trackerSubject = (id: string) => ({ type: "tracker", id });
export const geofenceSubject = (id: string) => ({ type: "geofence", id });
export const shipmentSubject = (id: string) => ({ type: "shipment", id });
