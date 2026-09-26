import type { AppConfig, AuthMethods, Entity, ItemDetail, Location, User } from "../../types";
import { getMeta, idbAvailable, openDb, setMeta } from "./db";
import { auditLocal, baseFor, toItemRow, toLocationDetail, verifyLocal } from "./local";
import { isNetworkError, nativeFetch, newId, TimeoutError, withTimeout } from "./net";
import * as store from "./store";
import { refreshQueueStatus, requestSync } from "./sync";
import { setState } from "./status";
import type { FieldAction, QueuedAction, ReplayRequest } from "./types";

/**
 * The offline transport: a wrapper around window.fetch that lets the existing
 * screens keep working in a dead zone without each one knowing about it.
 *
 * On a device that opted in, while the instance has the feature switched on:
 *
 * - Reads the field screens make (scan, item, location, pickers, and the
 *   session the app needs to open) go to the network first. Only when the
 *   network fails do they answer from the offline copy, marked with an
 *   X-Bindex-Offline header, and the OFFLINE badge says how old that copy is.
 *   Stale data is never served as if it were current.
 * - Field changes (move, check-out, check-in, spot check, verify and audit
 *   results, notes, photos) are sent with an Idempotency-Key. If the network
 *   fails, or a change to the same record is already waiting, the change is
 *   queued with that same key, applied to the copy, and answered as the
 *   server would, so the screen moves on. The sync loop sends it later; the
 *   key means a change that did reach the server is never applied twice.
 * - Anything else passes through untouched.
 *
 * Everywhere else, and on devices that did not opt in, every request passes
 * straight through.
 */

const READ_TIMEOUT_MS = 8_000;
// Every request waits for the device settings, so storage that never answers
// (some private modes hang rather than refuse) must not hold the app up.
const STORAGE_TIMEOUT_MS = 3_000;
// A write that has not answered by now is queued. If the first attempt did get
// through, the queued copy carries the same key and the server answers it
// from what it stored.
const WRITE_TIMEOUT_MS = 15_000;
const ID = "([0-9a-fA-F-]{36})";

let deviceOn = false;
let featureOn = false;
const active = () => deviceOn && featureOn;

const noteOnline = () => setState({ online: true });
const noteOffline = () => setState({ online: false });

const respond = (body: unknown, status: number, mode: "cached" | "queued" | "local") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Bindex-Offline": mode },
  });

const offlineError = (message: string) => respond({ error: message, code: "offline" }, 503, "local");

const NOT_ON_DEVICE =
  "You are offline, and this is not in the offline copy on this device. Make its location available offline, or try again with a connection.";

// ---- Start-up ---------------------------------------------------------------

let ready: Promise<void> = Promise.resolve();

async function load(): Promise<void> {
  if (!idbAvailable()) {
    setState({ ready: true, supported: false });
    return;
  }
  try {
    await withTimeout(openDb(), STORAGE_TIMEOUT_MS);
    const [device, config] = await Promise.all([store.deviceEnabled(), getMeta("config")]);
    deviceOn = device;
    featureOn = config?.features.offline === true;
    setState({ ready: true, deviceEnabled: deviceOn, featureEnabled: featureOn });
    await refreshQueueStatus();
  } catch {
    // Storage refused (a locked-down profile, a full disk): work online only.
    deviceOn = false;
    setState({ ready: true, supported: false });
  }
}

/** Opt this device in or out. The copy itself is fetched by the offline screen. */
export async function setDeviceMode(enabled: boolean): Promise<void> {
  await store.setDeviceEnabled(enabled);
  deviceOn = enabled;
  if (!enabled) {
    // What only mattered for opening without a connection goes with it.
    await Promise.all([setMeta("config", null), setMeta("me", null), setMeta("authMethods", null)]);
  }
  setState({ deviceEnabled: enabled });
}

// ---- Reads -------------------------------------------------------------------

type Ctx = { request: Request; url: URL; match: RegExpMatchArray };

type ReadRoute = {
  method: "GET" | "POST";
  pattern: RegExp;
  /** The answer from the copy, or null when the copy cannot answer. */
  offline: (ctx: Ctx) => Promise<Response | null>;
  /** Keep what a successful answer says, for next time. */
  observe?: (ctx: Ctx, res: Response) => Promise<void>;
  /** Also observe on devices that did not opt in (the feature switch itself). */
  alwaysObserve?: boolean;
  /**
   * Wait for the network however long it takes, falling back only when it is
   * gone. For reconciling a walk, where the copy may hold only part of the
   * building and a slow answer is still the right one.
   */
  noTimeout?: boolean;
};

const cachedJson = (body: unknown) => respond(body, 200, "cached");

async function jsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.clone().json()) as T;
  } catch {
    return null;
  }
}

const READS: ReadRoute[] = [
  {
    method: "GET",
    pattern: /^\/api\/config$/,
    alwaysObserve: true,
    offline: async () => {
      const config = await getMeta("config");
      return config ? cachedJson(config) : null;
    },
    observe: async (_ctx, res) => {
      const config = (await res.json()) as AppConfig;
      featureOn = config.features?.offline === true;
      setState({ featureEnabled: featureOn });
      if (deviceOn) await setMeta("config", config);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/me$/,
    offline: async () => {
      const me = await getMeta("me");
      return me ? cachedJson({ user: me }) : null;
    },
    observe: async (_ctx, res) => {
      const { user } = (await res.json()) as { user: User };
      await setMeta("me", user);
      void refreshQueueStatus();
    },
  },
  {
    method: "GET",
    pattern: /^\/auth\/methods$/,
    offline: async () => {
      const methods = await getMeta("authMethods");
      return methods ? cachedJson(methods) : null;
    },
    observe: async (_ctx, res) => setMeta("authMethods", (await res.json()) as AuthMethods),
  },
  {
    method: "GET",
    pattern: /^\/api\/scan\/(.+)$/,
    offline: async ({ match }) => {
      const code = decodeURIComponent(match[1]!);
      const hit = await store.resolveCode(code);
      if (!hit) return offlineError(NOT_ON_DEVICE);
      const item = await store.itemDetail(hit.itemId, hit.unitId);
      return item ? cachedJson({ found: true, item }) : offlineError(NOT_ON_DEVICE);
    },
    observe: async (_ctx, res) => {
      const body = (await res.json()) as { found: boolean; item?: ItemDetail };
      if (body.found && body.item) await store.putServerItem(body.item);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/items/${ID}$`),
    offline: async ({ match }) => {
      const item = await store.itemDetail(match[1]!);
      return item ? cachedJson(item) : null;
    },
    observe: async (_ctx, res) => store.putServerItem((await res.json()) as ItemDetail),
  },
  {
    method: "GET",
    pattern: /^\/api\/items$/,
    offline: async ({ url }) => {
      const q = url.searchParams.get("q")?.trim().toLowerCase();
      const locationId = url.searchParams.get("locationId");
      const companyId = url.searchParams.get("companyId");
      const kind = url.searchParams.get("kind") ?? "physical";
      const [items, lk] = await Promise.all([store.allItems(), store.lookups()]);
      const rows = items
        .filter((i) => !locationId || i.locationId === locationId)
        .filter((i) => !companyId || i.companyId === companyId)
        .filter((i) => (kind === "digital" ? i.category === "Domain" : kind === "all" || i.category !== "Domain"))
        .filter(
          (i) =>
            !q ||
            [i.name, i.brand, i.model, i.assetCode, ...i.identifiers.map((x) => x.value)].some((v) =>
              v?.toLowerCase().includes(q),
            ),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, Math.min(Number(url.searchParams.get("limit")) || 50, 200))
        .map((i) => toItemRow(i, lk));
      return cachedJson(rows);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/items/${ID}/spot-check-candidate$`),
    offline: async ({ match }) => {
      const id = match[1]!;
      const item = await store.getItem(id);
      if (!item) return null;
      const all = await store.allItems();
      const pool = all.filter(
        (i) => i.id !== id && (i.parentItemId === id || (item.locationId && i.locationId === item.locationId)),
      );
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return cachedJson({ candidate: pick ? { id: pick.id, name: pick.name } : null });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/locations$/,
    offline: async () => {
      const list = await store.allLocations();
      return list.length ? cachedJson(list.sort((a, b) => a.name.localeCompare(b.name))) : null;
    },
    observe: async (_ctx, res) => store.putList("locations", (await res.json()) as Location[]),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/locations/${ID}$`),
    offline: async ({ match }) => {
      const loc = await store.getLocation(match[1]!);
      if (!loc) return null;
      const [lk, all, items] = await Promise.all([store.lookups(), store.allLocations(), store.allItems()]);
      return cachedJson(toLocationDetail(loc, lk, all, items));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/entities$/,
    offline: async () => cachedJson(await store.allEntities()),
    observe: async (_ctx, res) => store.putList("entities", (await res.json()) as Entity[]),
  },
  {
    method: "GET",
    pattern: /^\/api\/companies$/,
    offline: async () => cachedJson(await store.allCompanies()),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/offline/items/${ID}/notes$`),
    offline: async ({ match }) => {
      const itemId = match[1]!;
      const queued = (await store.listQueue()).filter(
        (q) => q.action.type === "note" && q.action.itemId === itemId,
      );
      return cachedJson({
        notes: queued.reverse().map((q) => ({
          id: q.id,
          itemId,
          unitId: q.action.unitId ?? null,
          text: q.action.text ?? "",
          writtenAt: q.createdAt,
          createdAt: q.createdAt,
          userOid: q.userOid,
          queued: true,
        })),
      });
    },
  },
  // Reconciling scans is read-only on the server, so offline it is worked out
  // from the copy rather than queued.
  {
    method: "POST",
    pattern: new RegExp(`^/api/locations/${ID}/verify$`),
    noTimeout: true,
    offline: async ({ request, match }) => {
      const body = await jsonBody<{ codes: string[] }>(request);
      if (!body || !(await store.getLocation(match[1]!))) return null;
      const [items, lk, resolve] = await Promise.all([store.allItems(), store.lookups(), store.codeResolver()]);
      return cachedJson(verifyLocal(match[1]!, body.codes ?? [], items, lk, resolve));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/audit\/reconcile$/,
    noTimeout: true,
    offline: async ({ request }) => {
      const body = await jsonBody<{ codes: string[]; companyId?: string }>(request);
      if (!body) return null;
      const [items, lk, resolve] = await Promise.all([store.allItems(), store.lookups(), store.codeResolver()]);
      return cachedJson(auditLocal(body.codes ?? [], items, lk, resolve, body.companyId));
    },
  },
];

async function handleRead(route: ReadRoute, ctx: Ctx): Promise<Response> {
  const observe = (res: Response) => {
    if (!route.observe || !res.ok) return;
    if (!deviceOn && !route.alwaysObserve) return;
    route.observe(ctx, res.clone()).catch(() => undefined);
  };

  if (!active()) {
    const res = await track(nativeFetch(ctx.request));
    observe(res);
    if (res.status === 401 && ctx.url.pathname === "/api/me") void setMeta("me", null);
    return res;
  }

  if (navigator.onLine !== false) {
    const attempt = nativeFetch(ctx.request.clone());
    try {
      const res = route.noTimeout ? await attempt : await withTimeout(attempt, READ_TIMEOUT_MS);
      noteOnline();
      observe(res);
      if (res.status === 401 && ctx.url.pathname === "/api/me") void setMeta("me", null);
      return res;
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      noteOffline();
      // A slow answer may still arrive; keep it for next time when it does.
      if (err instanceof TimeoutError) attempt.then(observe).catch(() => undefined);
    }
  }
  const answer = await route.offline(ctx).catch(() => null);
  return answer ?? offlineError(NOT_ON_DEVICE);
}

/** Pass a request through, noting whether the network answered. */
async function track(p: Promise<Response>): Promise<Response> {
  try {
    const res = await p;
    noteOnline();
    return res;
  } catch (err) {
    if (isNetworkError(err)) noteOffline();
    throw err;
  }
}

// ---- Writes ------------------------------------------------------------------

type Described = {
  action: FieldAction;
  /** The answer the screen gets when the change is queued. */
  answer: () => Promise<Response>;
};

type WriteRoute = {
  method: "POST" | "PATCH";
  pattern: RegExp;
  /** Null for a variant that cannot be queued, such as editing a name. */
  describe: (ctx: Ctx, body: unknown) => Promise<Described | null>;
  raw?: boolean;
};

const itemAnswer = (itemId: string, photo?: Blob) => async () => {
  const item = await store.itemDetail(itemId);
  if (!item) return offlineError(NOT_ON_DEVICE);
  if (photo) item.primaryImageUrl = URL.createObjectURL(photo);
  return respond(item, 202, "queued");
};

async function itemName(itemId: string): Promise<string> {
  return (await store.getItem(itemId))?.name ?? "item";
}

async function placeName(locationId: string | null | undefined): Promise<string> {
  if (!locationId) return "no location";
  return (await store.getLocation(locationId))?.name ?? "another location";
}

async function holderName(entityId: string | null | undefined): Promise<string> {
  if (!entityId) return "someone";
  return (await store.allEntities()).find((e) => e.id === entityId)?.name ?? "someone";
}

const onlyKeys = (body: unknown, allowed: string[]): Record<string, unknown> | null => {
  if (!body || typeof body !== "object") return null;
  const keys = Object.keys(body);
  if (!keys.length || !keys.every((k) => allowed.includes(k))) return null;
  return body as Record<string, unknown>;
};

const WRITES: WriteRoute[] = [
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/items/${ID}$`),
    describe: async ({ match }, body) => {
      const move = onlyKeys(body, ["locationId", "parentItemId"]);
      if (!move) return null;
      const itemId = match[1]!;
      const to: FieldAction["to"] = {};
      if ("locationId" in move) to.locationId = (move.locationId as string | null) ?? null;
      if ("parentItemId" in move) to.parentItemId = (move.parentItemId as string | null) ?? null;
      const where =
        "parentItemId" in to && to.parentItemId
          ? `into ${await itemName(to.parentItemId)}`
          : `to ${await placeName(to.locationId)}`;
      return {
        action: { type: "move", itemId, to, label: `Move ${await itemName(itemId)} ${where}` },
        answer: itemAnswer(itemId),
      };
    },
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/items/${ID}/units/${ID}$`),
    describe: async ({ match }, body) => {
      const move = onlyKeys(body, ["locationId"]);
      if (!move) return null;
      const [itemId, unitId] = [match[1]!, match[2]!];
      const locationId = (move.locationId as string | null) ?? null;
      return {
        action: {
          type: "move",
          itemId,
          unitId,
          to: { locationId },
          label: `Move a unit of ${await itemName(itemId)} to ${await placeName(locationId)}`,
        },
        answer: itemAnswer(itemId),
      };
    },
  },
  ...(["", "/units/" + ID] as const).flatMap((unitPart): WriteRoute[] => [
    {
      method: "POST",
      pattern: new RegExp(`^/api/items/${ID}${unitPart}/checkout$`),
      describe: async ({ match }, body) => {
        const b = body as { entityId?: string } | null;
        if (!b?.entityId) return null;
        const itemId = match[1]!;
        const unitId = unitPart ? match[2]! : null;
        const who = await holderName(b.entityId);
        return {
          action: {
            type: "checkout",
            itemId,
            unitId,
            entityId: b.entityId,
            entityName: who,
            label: `Check out ${unitId ? "a unit of " : ""}${await itemName(itemId)} to ${who}`,
          },
          answer: itemAnswer(itemId),
        };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/api/items/${ID}${unitPart}/checkin$`),
      describe: async ({ match }) => {
        const itemId = match[1]!;
        const unitId = unitPart ? match[2]! : null;
        return {
          action: {
            type: "checkin",
            itemId,
            unitId,
            label: `Check in ${unitId ? "a unit of " : ""}${await itemName(itemId)}`,
          },
          answer: itemAnswer(itemId),
        };
      },
    },
  ]),
  {
    method: "POST",
    pattern: new RegExp(`^/api/items/${ID}/spot-check$`),
    describe: async ({ match }, body) => {
      const b = body as { seen?: boolean } | null;
      if (typeof b?.seen !== "boolean") return null;
      const itemId = match[1]!;
      return {
        action: {
          type: "spot_check",
          itemId,
          seen: b.seen,
          label: `Spot check: ${await itemName(itemId)} ${b.seen ? "seen" : "not found"}`,
        },
        answer: async () => respond({ ok: true }, 202, "queued"),
      };
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/locations/${ID}/verify/apply$`),
    describe: async ({ match }, body) => {
      const b = body as { presentIds?: string[]; missingIds?: string[] } | null;
      if (!b) return null;
      const locationId = match[1]!;
      return {
        action: {
          type: "verify_apply",
          locationId,
          seenIds: b.presentIds ?? [],
          missingIds: b.missingIds ?? [],
          label: `Verified ${await placeName(locationId)}: ${b.presentIds?.length ?? 0} present, ${
            b.missingIds?.length ?? 0
          } missing`,
        },
        answer: async () => {
          const loc = await store.getLocation(locationId);
          if (!loc) return offlineError(NOT_ON_DEVICE);
          const [lk, all, items] = await Promise.all([store.lookups(), store.allLocations(), store.allItems()]);
          return respond(toLocationDetail(loc, lk, all, items), 202, "queued");
        },
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/audit\/apply$/,
    describe: async (_ctx, body) => {
      const b = body as { seenIds?: string[]; missingIds?: string[] } | null;
      if (!b) return null;
      const seenIds = b.seenIds ?? [];
      const missingIds = b.missingIds ?? [];
      return {
        action: {
          type: "audit_apply",
          seenIds,
          missingIds,
          label: `Audit: ${seenIds.length} seen, ${missingIds.length} flagged missing`,
        },
        answer: async () =>
          respond({ ok: true, checked: seenIds.length, flaggedMissing: missingIds.length }, 202, "queued"),
      };
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/items/${ID}/photo$`),
    raw: true,
    describe: async ({ match }, body) => {
      if (!(body instanceof Blob) || body.size === 0) return null;
      const itemId = match[1]!;
      return {
        action: { type: "photo", itemId, label: `Photo of ${await itemName(itemId)}` },
        answer: itemAnswer(itemId, body),
      };
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/offline/items/${ID}/notes$`),
    describe: async ({ match }, body) => {
      const b = body as { text?: string; unitId?: string | null; writtenAt?: string } | null;
      const text = b?.text?.trim();
      if (!text) return null;
      const itemId = match[1]!;
      const writtenAt = b?.writtenAt ?? new Date().toISOString();
      return {
        action: {
          type: "note",
          itemId,
          unitId: b?.unitId ?? null,
          text,
          label: `Note on ${await itemName(itemId)}: ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`,
        },
        answer: async () =>
          respond(
            { id: newId(), itemId, unitId: b?.unitId ?? null, text, writtenAt, createdAt: writtenAt, userOid: null, queued: true },
            202,
            "queued",
          ),
      };
    },
  },
];

/** Put a change in the queue and onto the copy, or say why it cannot be kept here. */
async function queueChange(
  action: FieldAction,
  key: string,
  request: ReplayRequest,
  photo: Blob | null,
): Promise<QueuedAction | { error: string }> {
  const me = await store.cachedUser();
  if (!me) {
    return { error: "You are offline, and this device does not know who is signed in. Sign in again with a connection first." };
  }
  const item = action.itemId ? await store.getItem(action.itemId) : undefined;
  // A change to a single record needs the record here, to know what it was
  // made against and to show its effect.
  if (action.itemId && !item) {
    return {
      error:
        "You are offline, and this record is not on this device, so the change cannot be kept for later. Make its location available offline first.",
    };
  }

  if (photo) {
    request.blobId = newId();
    await store.putBlob(request.blobId, photo);
  }
  const entry = await store.enqueue({
    id: newId(),
    idempotencyKey: key,
    createdAt: new Date().toISOString(),
    userOid: me.oid,
    userName: me.name,
    action,
    base: baseFor(action, item),
    request,
    status: "pending",
    attempts: 0,
  });
  await store.applyLocally(entry);
  await refreshQueueStatus();
  requestSync();
  return entry;
}

async function handleWrite(route: WriteRoute, ctx: Ctx): Promise<Response> {
  if (!active()) return track(nativeFetch(ctx.request));

  const request = ctx.request;
  const raw = route.raw ? await request.clone().blob() : await request.clone().text();
  let parsed: unknown = raw;
  if (!route.raw) {
    try {
      parsed = raw ? JSON.parse(raw as string) : {};
    } catch {
      return track(nativeFetch(request));
    }
  }
  const described = await route.describe(ctx, parsed).catch(() => null);
  if (!described) {
    // Not a field change: send it as it is, and say plainly if that fails.
    try {
      return await track(nativeFetch(request));
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      return offlineError(
        "You are offline. This change needs a connection; moves, check-outs, check-ins, spot checks, audits, notes and photos can be made offline.",
      );
    }
  }

  const key = request.headers.get("Idempotency-Key") ?? newId();
  const headers = new Headers(request.headers);
  headers.set("Idempotency-Key", key);
  const replay: ReplayRequest = {
    method: request.method,
    path: ctx.url.pathname + ctx.url.search,
    contentType: headers.get("Content-Type") ?? undefined,
    ...(route.raw ? {} : { body: raw as string }),
  };

  const subjects = store.subjectsOf({ action: described.action });
  const mustQueue = navigator.onLine === false || (await store.hasQueuedFor(subjects));
  if (!mustQueue) {
    try {
      const res = await withTimeout(
        nativeFetch(ctx.url.toString(), {
          method: request.method,
          headers,
          body: raw as BodyInit,
          credentials: "include",
        }),
        WRITE_TIMEOUT_MS,
      );
      noteOnline();
      if (res.ok && res.headers.get("Content-Type")?.includes("json")) {
        res
          .clone()
          .json()
          .then((b: unknown) => {
            const detail = b as Partial<ItemDetail>;
            if (detail && typeof detail === "object" && "identifiers" in detail && detail.id) {
              return store.putServerItem(detail as ItemDetail);
            }
          })
          .catch(() => undefined);
      }
      return res;
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      noteOffline();
    }
  }

  const queued = await queueChange(described.action, key, replay, route.raw ? (raw as Blob) : null);
  if ("error" in queued) return offlineError(queued.error);
  return described.answer();
}

// ---- Session -----------------------------------------------------------------

async function handleSession(ctx: Ctx): Promise<Response> {
  const path = ctx.url.pathname;
  if (path === "/auth/logout") {
    // Whoever signs in next must not open the app as this person offline.
    await setMeta("me", null).catch(() => undefined);
    return track(nativeFetch(ctx.request));
  }
  const res = await track(nativeFetch(ctx.request));
  if (res.ok && deviceOn) {
    res
      .clone()
      .json()
      .then((b: { user?: User }) => (b.user ? setMeta("me", b.user) : undefined))
      .catch(() => undefined);
  }
  return res;
}

// ---- The wrapper -------------------------------------------------------------

async function offlineFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let request: Request;
  try {
    request = new Request(input, init);
  } catch {
    return nativeFetch(input, init);
  }
  const url = new URL(request.url);
  if (url.origin !== window.location.origin) return nativeFetch(request);

  await ready;
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (method === "POST" && /^\/auth\/(logout|login|setup)$/.test(path)) {
    return handleSession({ request, url, match: [] as unknown as RegExpMatchArray });
  }
  for (const route of READS) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return handleRead(route, { request, url, match });
  }
  for (const route of WRITES) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return handleWrite(route, { request, url, match });
  }
  return track(nativeFetch(request));
}

declare global {
  interface Window {
    __bindexOfflineTransport?: boolean;
  }
}

/**
 * Install once, before the first request: the providers that load the session
 * and the configuration fetch on mount, and those are exactly the requests
 * that must work without a connection.
 */
export function installOfflineTransport(): void {
  if (typeof window === "undefined" || window.__bindexOfflineTransport) return;
  window.__bindexOfflineTransport = true;
  ready = load();
  window.fetch = offlineFetch as typeof fetch;
}
