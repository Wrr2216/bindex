import { api } from "../../api/client";
import { offlineApi } from "./api";
import * as store from "./store";
import { refreshQueueStatus } from "./sync";
import { setDeviceMode } from "./transport";
import type { Snapshot } from "./types";

/**
 * Managing what this device holds. Every step that needs the server fetches
 * first and only then touches the copy, so losing the signal part-way leaves
 * the old copy in place rather than half of a new one.
 */

/** Read what the app needs to open without a connection; the transport keeps it. */
async function primeSession(): Promise<void> {
  await Promise.all([
    api.me().catch(() => undefined),
    api.config().catch(() => undefined),
    api.authMethods().catch(() => undefined),
  ]);
}

/** Take a location and everything in it offline, or the whole instance with null. */
export async function makeAvailable(locationId: string | null): Promise<Snapshot> {
  const snap = await offlineApi.snapshot(locationId);
  if (!(await store.deviceEnabled())) await setDeviceMode(true);
  await store.saveSnapshot(snap);
  await primeSession();
  await refreshQueueStatus();
  return snap;
}

async function rebuild(locationIds: (string | null)[]): Promise<void> {
  const snaps = await Promise.all(locationIds.map((id) => offlineApi.snapshot(id)));
  await store.clearItems();
  await store.setScopes([]);
  for (const snap of snaps) await store.saveSnapshot(snap);
  await primeSession();
  await refreshQueueStatus();
}

/** Fetch every scope again, dropping items that left them. */
export async function refreshAll(): Promise<void> {
  await rebuild((await store.scopes()).map((s) => s.locationId));
}

export async function removeScope(locationId: string | null): Promise<void> {
  const remaining = (await store.scopes()).filter((s) => s.locationId !== locationId);
  await rebuild(remaining.map((s) => s.locationId));
}

/** Throw the copy away. Changes waiting to be sent stay. */
export async function clearCopy(): Promise<void> {
  await store.clearCache();
  await refreshQueueStatus();
}

/** Start keeping a copy on this device: the session now, records as they are opened or taken offline. */
export async function turnOn(): Promise<void> {
  await setDeviceMode(true);
  await primeSession();
  await refreshQueueStatus();
}

/** Stop keeping a copy on this device. Changes waiting to be sent still go. */
export async function turnOff(): Promise<void> {
  await store.clearCache();
  await setDeviceMode(false);
  await refreshQueueStatus();
}
