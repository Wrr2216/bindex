import type { PortalGrant } from "../../db/schema";
import { logger } from "../../lib/logger";
import { publish } from "../event-backbone";
import { portalActor } from "./policy";

/**
 * The access record. Every portal request is written to the server log
 * (`portal.request`), and a visit is published to the audit log as
 * `portal.accessed`: the first request from an address, then again after
 * VISIT_MS of activity, so a page that polls does not write an audit entry
 * every few seconds. Everything a link changes is published separately, one
 * entry per action.
 */

const VISIT_MS = 15 * 60_000;
const MAX_TRACKED = 10_000;

const lastVisit = new Map<string, number>();

function due(key: string, now: number): boolean {
  const last = lastVisit.get(key);
  if (last !== undefined && now - last < VISIT_MS) return false;
  if (lastVisit.size >= MAX_TRACKED) {
    for (const [k, t] of lastVisit) if (now - t >= VISIT_MS) lastVisit.delete(k);
    // Still full: every entry is recent. Forget the oldest rather than grow.
    if (lastVisit.size >= MAX_TRACKED) lastVisit.delete(lastVisit.keys().next().value!);
  }
  lastVisit.set(key, now);
  return true;
}

export type RequestInfo = { ip: string | null; userAgent: string | null; method: string; path: string };

const ua = (s: string | null) => (s ? s.slice(0, 200) : null);

export function recordAccess(grant: PortalGrant, req: RequestInfo, now = Date.now()): void {
  logger.info("portal.request", { grantId: grant.id, method: req.method, path: req.path, ip: req.ip });
  if (!due(`ok|${grant.id}|${req.ip}`, now)) return;
  void publish(
    "portal.accessed",
    { ip: req.ip, userAgent: ua(req.userAgent), scope: grant.scope, role: grant.role },
    { actor: portalActor(grant), subject: { type: "portal_grant", id: grant.id } },
  );
}

/**
 * A refused request. With a known grant (revoked, expired, missing its code)
 * it is also published, throttled like visits so a stuck browser cannot fill
 * the audit log; an unknown token is only logged, since anyone can send one.
 */
export function recordDenied(grant: PortalGrant | null, reason: string, req: RequestInfo, now = Date.now()): void {
  logger.warn("portal.denied", { grantId: grant?.id ?? null, reason, method: req.method, path: req.path, ip: req.ip });
  if (!grant || !due(`denied|${grant.id}|${reason}|${req.ip}`, now)) return;
  void publish(
    "portal.access_denied",
    { reason, ip: req.ip, userAgent: ua(req.userAgent) },
    { actor: portalActor(grant), subject: { type: "portal_grant", id: grant.id } },
  );
}

/** For tests. */
export function resetAccessThrottle(): void {
  lastVisit.clear();
}
