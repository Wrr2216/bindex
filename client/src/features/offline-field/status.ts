import { useSyncExternalStore } from "react";
import type { LastSync, QueuedAction } from "./types";

/**
 * Connection and queue state, shared by the transport, the sync loop and the
 * screens. A plain store with subscribers so it can be updated from outside
 * React (the fetch wrapper) and read inside it.
 */

export type OfflineState = {
  /** IndexedDB opened and the device settings read. */
  ready: boolean;
  /** False when IndexedDB is unusable here; everything then passes through. */
  supported: boolean;
  online: boolean;
  /** The instance switch, as last heard from the server. */
  featureEnabled: boolean;
  /** This device opted in to keeping a copy. */
  deviceEnabled: boolean;
  /** When the oldest part of the offline copy was fetched. */
  cacheAt: string | null;
  itemCount: number;
  /** Waiting to be sent by the person signed in. */
  pending: number;
  /** Waiting on a person to choose keep-mine or keep-server. */
  attention: number;
  /** Queued by someone else signed in on this device earlier. */
  otherUsers: number;
  syncing: boolean;
  lastSync: LastSync | null;
  /** A newer build is installed and waiting. */
  updateAvailable: boolean;
};

let state: OfflineState = {
  ready: false,
  supported: true,
  online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  featureEnabled: false,
  deviceEnabled: false,
  cacheAt: null,
  itemCount: 0,
  pending: 0,
  attention: 0,
  otherUsers: 0,
  syncing: false,
  lastSync: null,
  updateAvailable: false,
};

const listeners = new Set<() => void>();

export function getState(): OfflineState {
  return state;
}

export function setState(patch: Partial<OfflineState>): void {
  const next = { ...state, ...patch };
  const changed = (Object.keys(patch) as (keyof OfflineState)[]).some((k) => next[k] !== state[k]);
  if (!changed) return;
  state = next;
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOfflineStatus(): OfflineState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** Queue counts from the queue itself, split by whose they are and where they stand. */
export function countQueue(queue: QueuedAction[], userOid: string | null) {
  let pending = 0;
  let attention = 0;
  let otherUsers = 0;
  for (const q of queue) {
    if (userOid && q.userOid !== userOid) otherUsers += 1;
    else if (q.status === "pending") pending += 1;
    else attention += 1;
  }
  return { pending, attention, otherUsers };
}

/** "3 min ago", "2 h ago", "yesterday": how old the offline copy is. */
export function ageOf(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
