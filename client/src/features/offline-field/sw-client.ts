import { setState } from "./status";
import { syncNow } from "./sync";

/**
 * The page's side of the service worker: pass on Background Sync wake-ups,
 * and notice when a newer build has been installed so the app can offer it
 * rather than switch versions under someone mid-task.
 */

let waiting: ServiceWorker | null = null;
let updating = false;
let lastCheck = 0;
const CHECK_EVERY_MS = 10 * 60_000;

function offer(worker: ServiceWorker): void {
  waiting = worker;
  setState({ updateAvailable: true });
}

function track(reg: ServiceWorkerRegistration): void {
  const sw = navigator.serviceWorker;
  // A worker waiting while another controls the page is an update; the very
  // first install has nothing to replace and takes over by itself.
  if (reg.waiting && sw.controller) offer(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const next = reg.installing;
    next?.addEventListener("statechange", () => {
      if (next.state === "installed" && sw.controller) offer(next);
    });
  });
}

let started = false;

export function watchServiceWorker(): void {
  if (started || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  started = true;
  const sw = navigator.serviceWorker;

  // The worker got a Background Sync event and needs an open app to run it.
  sw.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string } | null;
    if (data?.type !== "bindex-sync") return;
    const port = event.ports[0];
    syncNow()
      .then((o) => port?.postMessage({ ok: !o.offline && !o.error }))
      .catch(() => port?.postMessage({ ok: false }));
  });

  sw.addEventListener("controllerchange", () => {
    if (updating) window.location.reload();
  });

  // main.tsx registers the worker once the page has loaded.
  sw.getRegistration()
    .then((reg) => (reg ? track(reg) : sw.ready.then(track)))
    .catch(() => undefined);

  const check = () => {
    if (Date.now() - lastCheck < CHECK_EVERY_MS) return;
    lastCheck = Date.now();
    sw.getRegistration()
      .then((reg) => reg?.update())
      .catch(() => undefined);
  };
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
}

/** Switch to the waiting build and reload into it. */
export function applyUpdate(): void {
  if (!waiting) {
    window.location.reload();
    return;
  }
  updating = true;
  waiting.postMessage({ type: "SKIP_WAITING" });
}
