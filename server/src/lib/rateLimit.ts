import type { Request, RequestHandler } from "express";
import { HttpError } from "./errors";

type Window = { count: number; resetAt: number };

/**
 * Fixed-window request limiter held in memory. Enough for a single instance
 * guarding a few sensitive endpoints; the counters reset on restart, which is
 * acceptable for slowing down password guessing.
 *
 * `key` returning null skips the limiter for that request (for example when
 * the field it keys on is missing, which validation rejects anyway).
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key: (req: Request) => string | null;
}): RequestHandler {
  const windows = new Map<string, Window>();

  // Drop expired windows so the map cannot grow without bound.
  setInterval(() => {
    const now = Date.now();
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
  }, opts.windowMs).unref();

  return (req, res, next) => {
    const key = opts.key(req);
    if (key === null) return next();

    const now = Date.now();
    let w = windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + opts.windowMs };
      windows.set(key, w);
    }
    w.count++;
    if (w.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((w.resetAt - now) / 1000)));
      return next(new HttpError(429, "rate_limited", "Too many attempts. Try again later."));
    }
    next();
  };
}
