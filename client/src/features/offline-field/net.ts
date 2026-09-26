/**
 * The browser's own fetch, captured before the offline transport wraps it, so
 * the sync loop and the transport itself can reach the network without going
 * back through the wrapper.
 */
export const nativeFetch: typeof fetch =
  typeof window !== "undefined" ? window.fetch.bind(window) : (undefined as unknown as typeof fetch);

/** A request that took too long to wait for in a dead zone. */
export class TimeoutError extends Error {
  constructor() {
    super("The network took too long to answer.");
    this.name = "TimeoutError";
  }
}

/**
 * fetch rejects with a TypeError when there is no network, whatever the
 * browser's wording. A caller's own abort is not a network failure.
 */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || err instanceof TimeoutError;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID needs a secure context; a LAN install over plain http lacks one.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
