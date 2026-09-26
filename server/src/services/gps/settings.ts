import { env } from "../../env";
import { SPEED_UNITS, type SpeedUnit } from "./protocols";

/**
 * A GPS tracker's own options, kept under `gps` in tracking_devices.settings
 * next to the tracking core's keys. Read defensively: the column is shared.
 */
export type TrackerSettings = {
  /** Faster than this from the last fix is a jump. Defaults to GPS_MAX_SPEED_MPS. */
  maxSpeedMps: number | null;
  /** A disposable tracker: after delivery it waits to be returned or disposed of. */
  singleUse: boolean;
  /** Overrides the unit the protocol sends speed in, for apps that differ. */
  speedUnit: SpeedUnit | null;
  /** Forwards positions for other trackers (a Traccar server). */
  relay: boolean;
  /** Warn at or below this battery level. Defaults to GPS_BATTERY_LOW_PCT. */
  batteryLowPct: number | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export function readTrackerSettings(settings: unknown): TrackerSettings {
  const gps = isRecord(settings) && isRecord(settings.gps) ? settings.gps : {};
  const unit = typeof gps.speedUnit === "string" && (SPEED_UNITS as readonly string[]).includes(gps.speedUnit);
  const low = typeof gps.batteryLowPct === "number" && gps.batteryLowPct >= 0 && gps.batteryLowPct <= 100;
  return {
    maxSpeedMps: positive(gps.maxSpeedMps),
    singleUse: gps.singleUse === true,
    speedUnit: unit ? (gps.speedUnit as SpeedUnit) : null,
    relay: gps.relay === true,
    batteryLowPct: low ? (gps.batteryLowPct as number) : null,
  };
}

export const maxSpeedFor = (s: TrackerSettings) => s.maxSpeedMps ?? env.GPS_MAX_SPEED_MPS;
export const batteryLowFor = (s: TrackerSettings) => s.batteryLowPct ?? env.GPS_BATTERY_LOW_PCT;
