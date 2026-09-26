import type { RecentFix } from "../../db/tables/gps";
import { pathLengthM } from "./geo";

/**
 * Travel figures for a shipment: how far it has come, how far it has to go in
 * a straight line, and a simple ETA from its recent average speed. Pure.
 */

/** How far back the average speed looks. */
export const SPEED_WINDOW_MS = 30 * 60_000;
/** Fixes kept for it. Plenty for a tracker reporting every 30 seconds. */
export const MAX_RECENT = 120;
/** Below this the vehicle is stopped, and an ETA would be meaningless. */
export const MIN_MOVING_MPS = 0.5;
/** An average over less than this is too noisy to predict from. */
const MIN_WINDOW_MS = 60_000;
/** ETAs further out than this are not shown. */
const MAX_ETA_MS = 14 * 24 * 60 * 60_000;

/** Add accepted fixes to the window and drop the ones that have aged out. */
export function pushRecent(recent: readonly RecentFix[], fixes: readonly RecentFix[]): RecentFix[] {
  const all = [...recent, ...fixes].sort((a, b) => a.at - b.at);
  const newest = all[all.length - 1]?.at ?? 0;
  return all.filter((f) => f.at >= newest - SPEED_WINDOW_MS).slice(-MAX_RECENT);
}

/** Distance over time across the window, or null when it is too short to say. */
export function averageSpeedMps(recent: readonly RecentFix[]): number | null {
  if (recent.length < 2) return null;
  const span = recent[recent.length - 1]!.at - recent[0]!.at;
  if (span < MIN_WINDOW_MS) return null;
  return pathLengthM(recent) / (span / 1000);
}

/**
 * When the shipment should arrive, from the remaining straight-line distance
 * and the recent average speed. Null when stopped, when there is no
 * destination, or when the answer is too far out to be useful. Straight-line
 * distance under-reads road distance, so this is an optimistic floor.
 */
export function estimateArrival(remainingM: number | null, speedMps: number | null, now: number): number | null {
  if (remainingM === null) return null;
  if (remainingM <= 0) return now;
  if (speedMps === null || speedMps < MIN_MOVING_MPS) return null;
  const ms = (remainingM / speedMps) * 1000;
  return ms > MAX_ETA_MS ? null : now + ms;
}
