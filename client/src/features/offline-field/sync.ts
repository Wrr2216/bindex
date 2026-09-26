import type { ItemDetail } from "../../types";
import { getMeta, setMeta } from "./db";
import { isNetworkError, nativeFetch, newId } from "./net";
import * as store from "./store";
import { countQueue, getState, setState } from "./status";
import type { LastSync, PlanResult, QueuedAction } from "./types";

/**
 * Sending the queue.
 *
 * The server plans first (POST /api/offline/plan): given every waiting change
 * and what the device believed when it made each one, it says which to send,
 * in what order, and which need a person. The planner owns the ordering and
 * conflict rules (server/src/services/offline-field/plan.ts). This loop then
 * replays each "send" through the ordinary route with the change's own
 * Idempotency-Key, oldest first, and records the outcome. Nothing leaves the
 * queue except by reaching the server, being found already done there, or a
 * person discarding it.
 *
 * It runs when the connection comes back, when the app regains focus, every
 * half minute while changes are waiting, and when the service worker passes on
 * a Background Sync wake-up.
 */

export const SYNC_TAG = "bindex-offline-sync";
// A server error this many times in a row stops being retried by itself and
// goes to "Needs attention" instead, where a person can retry it.
const MAX_ATTEMPTS = 5;
const POLL_MS = 30_000;

export type SyncOutcome = {
  sent: number;
  skipped: number;
  needAttention: number;
  /** The network went away part-way; the rest waits for the next run. */
  offline: boolean;
  error?: string;
};

const idle: SyncOutcome = { sent: 0, skipped: 0, needAttention: 0, offline: false };

let running: Promise<SyncOutcome> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Recount the queue and the copy for the badge and the offline screen. */
export async function refreshQueueStatus(): Promise<void> {
  try {
    const [queue, me, scopes, lastSync] = await Promise.all([
      store.listQueue(),
      store.cachedUser(),
      store.scopes(),
      getMeta("lastSync"),
    ]);
    const oldest = scopes.map((s) => s.fetchedAt).sort()[0] ?? null;
    setState({
      ...countQueue(queue, me?.oid ?? null),
      cacheAt: oldest,
      itemCount: scopes.reduce((n, s) => n + s.itemCount, 0),
      lastSync: lastSync ?? null,
    });
  } catch {
    // Counting is cosmetic; the next change will try again.
  }
}

/** Ask for a sync soon. Several asks close together make one run. */
export function requestSync(delayMs = 250): void {
  registerBackgroundSync();
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void syncNow();
  }, delayMs);
}

export function syncNow(): Promise<SyncOutcome> {
  if (!running) {
    running = run().finally(() => {
      running = null;
    });
  }
  return running;
}

type SyncRegistration = ServiceWorkerRegistration & {
  sync?: { register: (tag: string) => Promise<void> };
};

/**
 * Where the browser supports it, ask to be woken when the connection is back,
 * even with the app in the background. The worker passes the wake-up to an
 * open app, which runs this same loop.
 */
function registerBackgroundSync(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready
    .then((reg) => (reg as SyncRegistration).sync?.register(SYNC_TAG))
    .catch(() => undefined);
}

function toPlanInput(q: QueuedAction) {
  const a = q.action;
  const itemIds =
    a.type === "verify_apply" || a.type === "audit_apply"
      ? [...new Set([...(a.seenIds ?? []), ...(a.missingIds ?? [])])]
      : undefined;
  return {
    id: q.id,
    seq: q.seq ?? 0,
    type: a.type,
    itemId: a.itemId ?? null,
    unitId: a.unitId ?? null,
    locationId: a.locationId ?? null,
    entityId: a.entityId ?? null,
    to: a.to,
    base: q.base,
    itemIds,
    force: q.force ?? false,
    held: q.status !== "pending",
  };
}

async function replay(q: QueuedAction): Promise<Response> {
  const headers: Record<string, string> = { "Idempotency-Key": q.idempotencyKey };
  let body: BodyInit | undefined = q.request.body;
  if (q.request.contentType) headers["Content-Type"] = q.request.contentType;
  if (q.request.blobId) {
    const row = await store.getBlob(q.request.blobId);
    if (!row) throw new Error("The photo for this change is no longer on this device.");
    body = row.blob;
    headers["Content-Type"] = row.mime;
  }
  return nativeFetch(q.request.path, {
    method: q.request.method,
    headers,
    body,
    credentials: "include",
  });
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON; fall back to the status.
  }
  return `The server answered ${res.status} ${res.statusText}`.trim();
}

/** Keep the server's answer to a change on the copy, where it is an item. */
async function keepAnswer(res: Response): Promise<void> {
  if (!res.headers.get("Content-Type")?.includes("json")) return;
  const body = (await res.json().catch(() => null)) as Partial<ItemDetail> | null;
  if (body && typeof body === "object" && body.id && Array.isArray(body.identifiers)) {
    await store.putServerItem(body as ItemDetail);
  }
}

async function run(): Promise<SyncOutcome> {
  const [queue, me] = await Promise.all([store.listQueue(), store.cachedUser()]);
  // Only the person signed in can send their own changes; anyone else's wait
  // until they sign in on this device again.
  const mine = me ? queue.filter((q) => q.userOid === me.oid) : [];
  if (!mine.some((q) => q.status === "pending")) {
    await refreshQueueStatus();
    return idle;
  }

  setState({ syncing: true });
  const outcome: SyncOutcome = { ...idle };
  try {
    let plan: PlanResult[];
    try {
      const res = await nativeFetch("/api/offline/plan", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actions: mine.map(toPlanInput) }),
      });
      if (!res.ok) {
        outcome.error =
          res.status === 401 ? "Sign in again to send the changes waiting on this device." : await errorText(res);
        return outcome;
      }
      plan = ((await res.json()) as { results: PlanResult[] }).results;
      setState({ online: true });
    } catch (err) {
      if (isNetworkError(err)) {
        setState({ online: false });
        outcome.offline = true;
        return outcome;
      }
      throw err;
    }

    const byId = new Map(mine.map((q) => [q.id, q]));
    // A change that failed here holds back later ones to the same record.
    const stalled = new Set<string>();

    for (const verdict of plan) {
      const q = byId.get(verdict.id);
      if (!q) continue;

      if (verdict.verdict === "held" || verdict.verdict === "blocked") continue;
      // The plan assumed the earlier change went through; it did not, so this
      // one waits for the next run to be planned again.
      if (store.subjectsOf(q).some((s) => stalled.has(s))) continue;
      if (verdict.verdict === "conflict") {
        await store.updateQueued(q, {
          status: "conflict",
          conflict: {
            code: verdict.code,
            reason: verdict.reason,
            canKeepMine: verdict.canKeepMine,
            missingItemIds: verdict.missingItemIds,
          },
        });
        outcome.needAttention += 1;
        continue;
      }
      if (verdict.verdict === "skip") {
        await store.finishQueued(q, "skipped", verdict.reason);
        outcome.skipped += 1;
        continue;
      }

      let res: Response;
      try {
        res = await replay(q);
      } catch (err) {
        if (isNetworkError(err)) {
          setState({ online: false });
          outcome.offline = true;
          break;
        }
        await store.updateQueued(q, { status: "rejected", lastError: String((err as Error).message ?? err) });
        outcome.needAttention += 1;
        for (const s of store.subjectsOf(q)) stalled.add(s);
        continue;
      }

      if (res.ok) {
        await keepAnswer(res).catch(() => undefined);
        await store.finishQueued(
          q,
          "sent",
          res.headers.get("Idempotent-Replayed") ? "The server already had this change." : null,
        );
        outcome.sent += 1;
        continue;
      }
      if (res.status === 401) {
        outcome.error = "Sign in again to send the changes waiting on this device.";
        break;
      }
      for (const s of store.subjectsOf(q)) stalled.add(s);
      const message = await errorText(res);
      const transient = res.status >= 500 || res.status === 409 || res.status === 429;
      const attempts = q.attempts + 1;
      if (transient && attempts < MAX_ATTEMPTS) {
        await store.updateQueued(q, { attempts, lastError: message });
        continue;
      }
      await store.updateQueued(q, { status: "rejected", attempts, lastError: message });
      outcome.needAttention += 1;
    }
    return outcome;
  } finally {
    const last: LastSync = {
      at: new Date().toISOString(),
      sent: outcome.sent,
      skipped: outcome.skipped,
      needAttention: outcome.needAttention,
      error: outcome.error ?? (outcome.offline ? "The connection dropped before everything was sent." : null),
    };
    await setMeta("lastSync", last).catch(() => undefined);
    setState({ syncing: false });
    await refreshQueueStatus();
  }
}

// ---- A person's decisions ------------------------------------------------------

/**
 * Keep mine: send the change even though the server moved on. A check that
 * named deleted records goes without them, which makes it a different request
 * and so a new key.
 */
export async function keepMine(q: QueuedAction): Promise<void> {
  const patch: Partial<QueuedAction> = {
    status: "pending",
    force: true,
    conflict: null,
    lastError: null,
    attempts: 0,
  };
  const missing = new Set(q.conflict?.missingItemIds ?? []);
  if (missing.size && q.request.body) {
    const keep = (ids?: string[]) => (ids ?? []).filter((id) => !missing.has(id));
    const action = { ...q.action, seenIds: keep(q.action.seenIds), missingIds: keep(q.action.missingIds) };
    const body = JSON.parse(q.request.body) as Record<string, string[]>;
    for (const field of ["presentIds", "seenIds", "missingIds"]) {
      if (Array.isArray(body[field])) body[field] = keep(body[field]);
    }
    patch.action = action;
    patch.request = { ...q.request, body: JSON.stringify(body) };
    patch.idempotencyKey = newId();
  }
  await store.updateQueued(q, patch);
  await refreshQueueStatus();
  requestSync(0);
}

/**
 * Keep the server's: discard the change, and fetch the server's version of
 * the record so the copy stops showing it.
 */
export async function keepServer(q: QueuedAction): Promise<void> {
  await store.finishQueued(q, "discarded", "Discarded; the server's version was kept.");
  const itemId = q.action.itemId;
  if (itemId) {
    try {
      const res = await nativeFetch(`/api/items/${itemId}`, { credentials: "include" });
      if (res.ok) await store.putServerItem((await res.json()) as ItemDetail);
    } catch {
      // Offline: the copy catches up the next time the record is fetched.
    }
  }
  await refreshQueueStatus();
}

let triggersStarted = false;

/** Start the loop's triggers. Idempotent. */
export function startSyncTriggers(): void {
  if (triggersStarted || typeof window === "undefined") return;
  triggersStarted = true;
  window.addEventListener("online", () => {
    setState({ online: true });
    requestSync(0);
  });
  window.addEventListener("offline", () => setState({ online: false }));
  window.addEventListener("focus", () => requestSync(0));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestSync(0);
  });
  setInterval(() => {
    if (getState().pending > 0 && navigator.onLine !== false) requestSync(0);
  }, POLL_MS);
  requestSync(1000);
}
