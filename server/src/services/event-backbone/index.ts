import { logger } from "../../lib/logger";
import { describeError } from "../../lib/errors";
import { createCheckpoint } from "./auditLog";
import { pruneDeliveries, startDeliveryWorker } from "./delivery";

/**
 * Entry point for other features. Publish events with:
 *
 *   import { publish, actorFromOid } from "../event-backbone";
 *
 * and describe new event types for the webhook picker with
 * registerEventTypes(). docs/event-backbone.md has the full contract.
 */
export { publish, actorFromOid, actorFromUser, SYSTEM_ACTOR, publishItemEventsLater, type ItemEventRow } from "./bus";
export { registerEventTypes, type EventTypeInfo } from "./catalog";
export type { AuditEntry, EventActor, EventSubject, PublishOptions, EventEnvelope } from "./types";

const HOUR = 60 * 60_000;

async function maintenance(): Promise<void> {
  try {
    await createCheckpoint(false);
  } catch (err) {
    logger.warn("audit.checkpoint.failed", { err: describeError(err) });
  }
  try {
    const pruned = await pruneDeliveries();
    if (pruned) logger.info("webhooks.deliveries.pruned", { count: pruned });
  } catch (err) {
    logger.warn("webhooks.prune.failed", { err: describeError(err) });
  }
}

/**
 * Background work: the webhook delivery worker, and an hourly check that
 * writes the daily audit checkpoint when one is due and prunes old delivery
 * records. Safe to run in every replica.
 */
export function startEventBackbone(): void {
  startDeliveryWorker();
  // The first check waits for the server to settle after boot.
  setTimeout(() => void maintenance(), 2 * 60_000).unref();
  setInterval(() => void maintenance(), HOUR).unref();
  logger.info("events.backbone.started", {});
}
