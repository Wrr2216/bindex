import { lazy, Suspense, type ComponentType } from "react";

/**
 * Claims screens for App.tsx. Each loads on first visit, so an instance with
 * the feature switched off, or someone who never opens a claim, does not
 * download them.
 */

function lazyPage(load: () => Promise<ComponentType>) {
  const Page = lazy(async () => ({ default: await load() }));
  return function LazyPage() {
    return (
      <Suspense fallback={<p className="text-slate-400">Loading…</p>}>
        <Page />
      </Suspense>
    );
  };
}

export const ClaimsPage = lazyPage(() => import("./ClaimsPage").then((m) => m.ClaimsPage));
export const NewClaimPage = lazyPage(() => import("./NewClaim").then((m) => m.NewClaim));
export const ClaimDetailPage = lazyPage(() => import("./ClaimDetail").then((m) => m.ClaimDetail));

/**
 * For the external portal's shipment page: lets the person holding a portal
 * link file a claim on their delivery. Rendered by the portal, which owns the
 * page and the token; nothing here reads the session.
 */
export const PortalClaimPanel = lazy(() => import("./PortalClaimPanel").then((m) => ({ default: m.PortalClaimPanel })));
