// Makes the app installable, keeps the built app so it opens with no
// connection, and passes Background Sync wake-ups on to the open app.
//
// Anything under /api or /auth always goes to the network: this worker never
// answers for data, so stale data is never served as if it were current. The
// app itself decides what to show offline, and marks it as such.
//
// The server stamps this file with the build it belongs to (see
// server/src/services/offline-field/serviceWorker.ts), so each deploy is a new
// worker the browser installs alongside the running one. The Vite dev server
// serves it unstamped; the placeholders then stay strings and the worker keeps
// what it sees instead of a precached list.
const BUILD_ID = "__BINDEX_BUILD_ID__";
const PRECACHE = "__BINDEX_PRECACHE__";

const STAMPED = !BUILD_ID.startsWith("__");
const CACHE = `bindex-app-${STAMPED ? BUILD_ID : "dev"}`;
const SHELL = ["/", "/icon.svg", "/manifest.webmanifest"];
const FILES = Array.isArray(PRECACHE) ? PRECACHE : [];
const SYNC_TAG = "bindex-offline-sync";
// Long enough for the app to plan and send a queue over a weak signal.
const SYNC_REPLY_MS = 60_000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // All or nothing: a half-cached build could not open offline, so a
      // failure here leaves the previous worker and its copy in charge.
      await cache.addAll([...SHELL, ...FILES]);
      // The very first install has nothing to replace and takes over at once.
      // An update waits for the app to ask, so nobody is switched mid-task.
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("bindex-") && k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/auth")) return; // always live

  // Pages: the network first, so an online visit always gets the newest
  // build; with no network, this build's own shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("/", { cacheName: CACHE })) || Response.error()),
    );
    return;
  }

  // Built files carry a content hash in their name and never change, so the
  // copy is as good as the network.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        const resp = await fetch(request);
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return resp;
      })(),
    );
    return;
  }

  // Everything else (icon, manifest): the network, falling back to the copy.
  event.respondWith(
    fetch(request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(async () => (await caches.match(request)) || Response.error()),
  );
});

// The browser says the connection is back. Sending the queue needs the app's
// own code and session, so an open app does it; with none open, failing here
// asks the browser to try again later, and the app sends the queue itself
// the next time it opens anyway.
self.addEventListener("sync", (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!windows.length) throw new Error("No open app to send the queue");
      const replies = windows.map(
        (client) =>
          new Promise((resolve) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => resolve(false), SYNC_REPLY_MS);
            channel.port1.onmessage = (e) => {
              clearTimeout(timer);
              resolve(Boolean(e.data && e.data.ok));
            };
            client.postMessage({ type: "bindex-sync" }, [channel.port2]);
          }),
      );
      const results = await Promise.all(replies);
      if (!results.some(Boolean)) throw new Error("The queue was not sent; try again later");
    })(),
  );
});
