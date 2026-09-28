import type { SpeedUnit, TrackerStatus } from "./types";

export const STATUS_LABELS: Record<TrackerStatus, string> = {
  available: "Available",
  assigned: "On a shipment or vehicle",
  awaiting_return: "Waiting to be returned",
  disposed: "Disposed of",
};

export const SPEED_UNIT_LABELS: Record<SpeedUnit, string> = {
  kn: "Knots (Traccar Client, OsmAnd protocol)",
  mps: "Metres per second",
  kmh: "Kilometres per hour",
  mph: "Miles per hour",
};

/** "850 m", "12.4 km". */
export function distance(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return "Unknown";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 100_000 ? 1 : 0)} km`;
}

/** "43 km/h". */
export function speed(mps: number | null | undefined): string {
  if (mps === null || mps === undefined || !Number.isFinite(mps)) return "Unknown";
  return `${Math.round(mps * 3.6)} km/h`;
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "Not yet";
}

export function time(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString() : "";
}

/** For <input type="datetime-local">, in the viewer's zone. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
