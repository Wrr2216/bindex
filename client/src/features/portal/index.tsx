import { lazy, Suspense, type ComponentType } from "react";

/**
 * External portal screens for App.tsx. Both load on first visit: the public
 * link page so a customer's phone downloads only what it shows, and the
 * administrators' page so an instance that never shares a link never
 * downloads it.
 */

function lazyPage(load: () => Promise<ComponentType>) {
  const Page = lazy(async () => ({ default: await load() }));
  return function LazyPage() {
    return (
      <Suspense fallback={<p className="p-6 text-center text-slate-400">Loading…</p>}>
        <Page />
      </Suspense>
    );
  };
}

export const PortalAdminPage = lazyPage(() => import("./AdminPage").then((m) => m.PortalAdminPage));
/** Everything under /p/:token, outside the sign-in gate. */
export const PortalLinkPage = lazyPage(() => import("./PortalLink").then((m) => m.PortalLinkPage));
