/**
 * Delivery policy, in one place so the documentation, the worker and the
 * tests all read the same numbers.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Wait before retry n (1-based): after the first failure 1 minute, then 5
 * minutes, 30 minutes, 2 hours and 12 hours. A sixth failure is final.
 */
export const RETRY_SCHEDULE_MS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 12 * HOUR] as const;

/** Attempts in all, the first send included. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;

/** Consecutive failures, across deliveries, after which an endpoint is switched off. */
export const AUTO_DISABLE_AFTER = 50;

/** Per-request limit; a receiver should answer quickly and do its work later. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * How long a worker holds a delivery it is sending. Longer than the timeout,
 * so a live worker never loses its lease, and short enough that a crashed one
 * delays the delivery by a minute at most.
 */
export const DELIVERY_LEASE_MS = 60_000;

/** Finished deliveries are kept this long for the delivery log, then pruned. */
export const DELIVERY_RETENTION_DAYS = 30;

/**
 * Delay before the next attempt after `failedAttempts` failures, or null when
 * the delivery has used all its attempts and is dead.
 */
export function nextRetryDelayMs(failedAttempts: number): number | null {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) return RETRY_SCHEDULE_MS[0];
  return RETRY_SCHEDULE_MS[failedAttempts - 1] ?? null;
}

/** 2xx is delivered. Anything else, redirects included, is a failure. */
export function isSuccessStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}
