import { isValidEventType } from "./patterns";

/**
 * The event types this instance can emit, for the webhook pattern picker and
 * the documentation. A feature that publishes new types registers them once
 * at module load:
 *
 *   registerEventTypes([{ type: "job.stage_changed", description: "…", subject: "job" }]);
 *
 * Registration is descriptive only. publish() accepts any well-formed type, so
 * a missing entry never loses an event; it just is not offered in the picker.
 */

export type EventTypeInfo = {
  type: string;
  description: string;
  /** subject.type the event carries, when it has one. */
  subject?: string;
  /** The feature that emits it, for grouping in the picker. */
  group?: string;
};

const registry = new Map<string, EventTypeInfo>();

export function registerEventTypes(types: EventTypeInfo[]): void {
  for (const t of types) {
    if (!isValidEventType(t.type)) continue;
    registry.set(t.type, t);
  }
}

export function eventCatalog(): EventTypeInfo[] {
  return [...registry.values()].sort((a, b) => a.type.localeCompare(b.type));
}

registerEventTypes([
  {
    type: "item.created",
    group: "Items",
    subject: "item",
    description: "An item was added, by hand or by a sync (NinjaOne, registrar).",
  },
  {
    type: "item.updated",
    group: "Items",
    subject: "item",
    description:
      "An item changed: edited fields, checked out or in, spot-checked, or flagged. Bulk edits and audit results carry no subject and list the ids in data.",
  },
  {
    type: "item.scanned",
    group: "Items",
    subject: "item",
    description: "A code was scanned and resolved to this item.",
  },
  {
    type: "item.moved",
    group: "Items",
    subject: "item",
    description: "An item changed location. Emitted by tracking hardware and by features that move items.",
  },
  {
    type: "item.deleted",
    group: "Items",
    subject: "item",
    description: "An item was deleted. Bulk deletes carry no subject and list the ids in data.",
  },
  {
    type: "audit.checkpoint",
    group: "Audit log",
    subject: "audit_log",
    description: "Daily signed statement of the head hash and row count of the audit log.",
  },
  {
    type: "audit.verified",
    group: "Audit log",
    subject: "audit_log",
    description: "An administrator checked the audit log chain.",
  },
  {
    type: "audit.exported",
    group: "Audit log",
    subject: "audit_log",
    description: "An administrator exported the audit log.",
  },
  {
    type: "webhook.endpoint_created",
    group: "Webhooks",
    subject: "webhook_endpoint",
    description: "A webhook endpoint was added.",
  },
  {
    type: "webhook.endpoint_updated",
    group: "Webhooks",
    subject: "webhook_endpoint",
    description: "A webhook endpoint's address, events or state changed, or its secret was rotated.",
  },
  {
    type: "webhook.endpoint_deleted",
    group: "Webhooks",
    subject: "webhook_endpoint",
    description: "A webhook endpoint was removed.",
  },
  {
    type: "webhook.endpoint_disabled",
    group: "Webhooks",
    subject: "webhook_endpoint",
    description: "A webhook endpoint was switched off automatically after repeated failures.",
  },
]);
