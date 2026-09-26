import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { notify } from "../../lib/notify";
import { publish, SYSTEM_ACTOR } from "../event-backbone";
import { claimDigest, sweepBattery, sweepMissing, type AlertRow } from "./state";

/**
 * Background checks: tags gone missing, batteries running low, and a digest
 * of new alerts through the configured notifications (Pushover, Wazuh).
 * Each check is safe to run in every replica at once; the database decides
 * who reports what.
 */

export async function checkMissing(now = new Date()): Promise<number> {
  const missing = await sweepMissing(now, env.BLE_MISSING_MINUTES);
  await Promise.all(
    missing.map((m) =>
      publish(
        "ble.tag_missing",
        {
          tagId: m.deviceId,
          tagName: m.deviceName,
          identity: m.identity,
          itemId: m.itemId,
          unitId: m.unitId,
          itemName: m.itemName,
          lastLocationId: m.locationId,
          lastLocationName: m.locationName,
          lastHeardAt: m.lastHeardAt.toISOString(),
          minutes: m.minutes,
        },
        {
          actor: SYSTEM_ACTOR,
          subject: m.itemId
            ? { type: "item", id: m.itemId }
            : m.deviceId
              ? { type: "tracking_device", id: m.deviceId }
              : null,
        },
      ),
    ),
  );
  if (missing.length) logger.info("ble.missing.marked", { count: missing.length });
  return missing.length;
}

export async function checkBatteries(): Promise<number> {
  const low = await sweepBattery(env.BLE_BATTERY_LOW_PCT);
  await Promise.all(
    low.map((b) =>
      publish(
        "ble.battery_low",
        {
          deviceId: b.deviceId,
          kind: b.kind,
          name: b.name,
          batteryPct: b.batteryPct,
          itemId: b.itemId,
          itemName: b.itemName,
          thresholdPct: env.BLE_BATTERY_LOW_PCT,
        },
        { actor: SYSTEM_ACTOR, subject: { type: "tracking_device", id: b.deviceId } },
      ),
    ),
  );
  return low.length;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** One line of a digest, from the names an alert captured when it was raised. */
export function describeAlert(a: Pick<AlertRow, "kind" | "detail" | "createdAt">): string {
  const d = a.detail;
  const what = str(d.itemName) ?? str(d.tagName) ?? str(d.name) ?? str(d.identity) ?? "A tag";
  switch (a.kind) {
    case "missing":
      return `${what}: not heard for ${Math.round(Number(d.minutes) || 0)} min${str(d.locationName) ? `, last in ${d.locationName}` : ""}`;
    case "after_hours_move":
      return `${what}: moved ${str(d.fromName) ? `from ${d.fromName} ` : ""}to ${str(d.toName) ?? "another room"} out of hours`;
    case "battery_low":
      return `${what}: battery at ${Number(d.batteryPct)}%`;
  }
}

/** Title for a digest: counts by kind, most urgent first. */
export function digestTitle(alerts: readonly Pick<AlertRow, "kind">[]): string {
  const count = (k: AlertRow["kind"]) => alerts.filter((a) => a.kind === k).length;
  const parts: string[] = [];
  const missing = count("missing");
  const moved = count("after_hours_move");
  const battery = count("battery_low");
  if (missing) parts.push(`${missing} missing`);
  if (moved) parts.push(`${moved} moved out of hours`);
  if (battery) parts.push(`${battery} low ${battery === 1 ? "battery" : "batteries"}`);
  return `Bluetooth tags: ${parts.join(", ")}`;
}

/** Send one digest of alerts raised since the last. */
export async function sendDigest(): Promise<number> {
  const alerts = await claimDigest();
  if (!alerts.length) return 0;
  const lines = alerts.slice(0, 30).map(describeAlert);
  if (alerts.length > 30) lines.push(`…and ${alerts.length - 30} more. See the Bluetooth page.`);
  const delivered = await notify({
    title: digestTitle(alerts),
    message: lines.join("\n"),
    ...(alerts.some((a) => a.kind !== "battery_low") ? { priority: "high" as const } : {}),
  });
  logger.info("ble.digest.sent", { count: alerts.length, delivered });
  return alerts.length;
}

/** Run a check, logging rather than throwing: a failed sweep waits for the next. */
export async function safely(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn(`ble.${name}.failed`, { err: describeError(err) });
  }
}
