import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { isWorkingTime, parseWorkHours, validTimeZone, type WorkSchedule } from "./hours";
import type { PresenceConfig } from "./presence";

/**
 * BLE configuration: instance-wide tuning from the environment, and the
 * per-device options kept in tracking_devices.settings.
 */

export function presenceConfig(): PresenceConfig {
  return {
    windowMs: env.BLE_WINDOW_SECONDS * 1000,
    smoothing: env.BLE_SMOOTHING,
    ewmaAlpha: 0.3,
    hysteresisDb: env.BLE_HYSTERESIS_DB,
    dwellMs: env.BLE_DWELL_SECONDS * 1000,
    minSamples: env.BLE_MIN_SAMPLES,
  };
}

/**
 * Phones report when an app gets round to it, often tens of seconds apart, so
 * waiting for a dwell would leave a person in the last room for minutes. The
 * hysteresis margin alone keeps a phone between two rooms from flapping.
 */
export function phonePresenceConfig(): PresenceConfig {
  return { ...presenceConfig(), dwellMs: 0, windowMs: Math.max(60_000, env.BLE_WINDOW_SECONDS * 1000) };
}

/** Readings older than this when they arrive are a backlog, not presence. */
export const LIVE_MS = 5 * 60_000;

let schedule: { text: string; parsed: WorkSchedule | null; error: string | null } | null = null;

/** The configured working hours, or null when unset or unreadable (logged once). */
export function workSchedule(): { parsed: WorkSchedule | null; error: string | null; timeZone: string | undefined } {
  const text = env.BLE_WORK_HOURS.trim();
  if (!schedule || schedule.text !== text) {
    schedule = { text, parsed: null, error: null };
    if (text) {
      try {
        schedule.parsed = parseWorkHours(text);
      } catch (err) {
        schedule.error = describeError(err);
        logger.warn("ble.work_hours.invalid", { value: text, err: schedule.error });
      }
    }
  }
  const tz = env.BLE_TIMEZONE.trim();
  if (tz && !validTimeZone(tz)) {
    return { parsed: null, error: `Unknown time zone "${tz}" in BLE_TIMEZONE.`, timeZone: undefined };
  }
  return { parsed: schedule.parsed, error: schedule.error, timeZone: tz || undefined };
}

/** Whether `date` is outside working hours. False when no hours are set. */
export function isOutOfHours(date: Date): boolean {
  const { parsed, timeZone } = workSchedule();
  return parsed ? !isWorkingTime(date, parsed, timeZone) : false;
}

/**
 * The BLE keys in a device's settings. The column is shared with the tracking
 * core and other features, so each key is read defensively and the rest of
 * the object is left alone.
 */
export type BleDeviceSettings = {
  /** Gateways and room beacons: dB added to every reading, from calibration. */
  rssiOffset: number;
  /** Tags and beacons: advertised signal at 1 m, dBm. Informational. */
  txPower: number | null;
  /** Tags: the address its telemetry (TLM) frames come from, when its id is not a MAC. */
  bleMac: string | null;
  /** Tags: minutes unheard before it is missing. 0 never marks it missing. */
  missingMinutes: number | null;
  /** Tags: raise an alert when it changes room out of hours. On unless false. */
  afterHoursAlert: boolean;
  /** Tags: cell voltage at 100 % and at 0 %, for batteries reported in millivolts. */
  batteryFullMv: number | null;
  batteryEmptyMv: number | null;
  /** Phones: the person whose room this phone reports. */
  userOid: string | null;
  userName: string | null;
};

/** The keys above, for merging a partial update into stored settings. */
export const BLE_SETTING_KEYS = [
  "rssiOffset",
  "txPower",
  "bleMac",
  "missingMinutes",
  "afterHoursAlert",
  "batteryFullMv",
  "batteryEmptyMv",
  "userOid",
  "userName",
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function bleSettings(raw: unknown): BleDeviceSettings {
  const s = isRecord(raw) ? raw : {};
  return {
    rssiOffset: num(s.rssiOffset) ?? 0,
    txPower: num(s.txPower),
    bleMac: str(s.bleMac),
    missingMinutes: num(s.missingMinutes),
    afterHoursAlert: s.afterHoursAlert !== false,
    batteryFullMv: num(s.batteryFullMv),
    batteryEmptyMv: num(s.batteryEmptyMv),
    userOid: str(s.userOid),
    userName: str(s.userName),
  };
}
