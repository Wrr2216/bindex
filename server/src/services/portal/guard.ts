import { AsyncLocalStorage } from "node:async_hooks";
import type { StageGuard } from "../jobs-core";

/**
 * The last line of defence for contributor scans. The portal works out which
 * lines a scan may move before it asks the jobs core to move them, but the
 * core re-plans inside its own lock; this guard, registered with the core,
 * vetoes any line in that batch that is not one the portal allowed. It only
 * acts inside `withPortalScope`, so it never touches anyone else's scans.
 */

export type PortalScanScope = {
  grantId: string;
  jobId: string;
  /** job_items ids this call may move. */
  allowed: ReadonlySet<string>;
};

const store = new AsyncLocalStorage<PortalScanScope>();

export const NOT_IN_SCOPE = "Not part of what this link covers.";

export function withPortalScope<T>(scope: PortalScanScope, fn: () => Promise<T>): Promise<T> {
  return store.run(scope, fn);
}

export const portalScopeGuard: StageGuard = (ctx) => {
  const scope = store.getStore();
  // Outside a portal call, or a nested change another feature makes from a
  // listener under its own `via`: not ours to judge.
  if (!scope || ctx.via !== "portal") return [];
  if (ctx.jobId !== scope.jobId) return ctx.lines.map((l) => ({ jobItemId: l.jobItemId, reason: NOT_IN_SCOPE }));
  return ctx.lines.filter((l) => !scope.allowed.has(l.jobItemId)).map((l) => ({ jobItemId: l.jobItemId, reason: NOT_IN_SCOPE }));
};
