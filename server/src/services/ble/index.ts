import { env } from "../../env";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { registerEventTypes } from "../event-backbone";
import { checkBatteries, checkMissing, safely, sendDigest } from "./alerts";
import { engine } from "./ingest";
import { startBleMqtt } from "./mqtt";
import { phoneEngine } from "./phones";
import { pruneAlerts, prunePhoneRooms } from "./state";

/**
 * Bluetooth beacons, gateways and room-level presence (T09). Built on the
 * tracking core: gateways, tags, room beacons and phones are tracking
 * devices, and every zone change goes through recordSightings.
 * docs/ble.md describes the model, the formats and the limits.
 */
export { processGatewayReport, type BleIngestResult } from "./ingest";
export { processPhoneReport, roomForUser, type MyRoom } from "./phones";
export { PresenceEngine, DEFAULT_PRESENCE, type PresenceConfig, type ZoneChange } from "./presence";
export { canonicalIdentity, parseAdvertisement } from "./advert";

registerEventTypes([
  {
    type: "ble.tag_zone_changed",
    group: "Bluetooth",
    subject: "item",
    description:
      "A Bluetooth tag's room changed, decided from its signal at several gateways. Subject is the tagged item, or the tag (tracking_device) when it is attached to nothing.",
  },
  {
    type: "ble.tag_moved_after_hours",
    group: "Bluetooth",
    subject: "item",
    description: "A Bluetooth tag left its room outside the working hours in BLE_WORK_HOURS.",
  },
  {
    type: "ble.tag_missing",
    group: "Bluetooth",
    subject: "item",
    description: "A Bluetooth tag has not been heard by any gateway for its missing timeout.",
  },
  {
    type: "ble.tag_found",
    group: "Bluetooth",
    subject: "item",
    description: "A Bluetooth tag that was missing has been heard again.",
  },
  {
    type: "ble.battery_low",
    group: "Bluetooth",
    subject: "tracking_device",
    description: "A Bluetooth tag, room beacon or gateway reported a battery at or below BLE_BATTERY_LOW_PCT.",
  },
]);

const MINUTE = 60_000;
/** Tags not heard for this long leave the in-memory engine; the database keeps their room. */
const ENGINE_IDLE_MS = 60 * MINUTE;

let started = false;

/**
 * Background work: the missing and battery checks every half minute, alert
 * digests, pruning, and the MQTT subscription when configured. Every check
 * is a no-op while the feature is off. Safe to run in every replica.
 */
export function startBle(): void {
  if (started) return;
  started = true;

  const on = async () => (await getConfig()).features.ble;
  const tick = async () => {
    if (!(await on())) return;
    await safely("missing", () => checkMissing());
    await safely("battery", () => checkBatteries());
    const now = Date.now();
    engine.forgetIdle(now, ENGINE_IDLE_MS);
    phoneEngine.forgetIdle(now, ENGINE_IDLE_MS);
  };
  setInterval(() => void safely("tick", tick), 30_000).unref();

  if (env.BLE_ALERT_DIGEST_MINUTES > 0) {
    setInterval(
      () => void safely("digest", async () => (await on()) && sendDigest()),
      env.BLE_ALERT_DIGEST_MINUTES * MINUTE,
    ).unref();
  }
  setInterval(
    () =>
      void safely("prune", async () => {
        await pruneAlerts();
        await prunePhoneRooms();
      }),
    24 * 60 * MINUTE,
  ).unref();

  void startBleMqtt().catch((err) => logger.warn("ble.mqtt.start_failed", { err: String(err) }));
}
