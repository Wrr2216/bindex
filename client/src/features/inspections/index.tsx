import { lazy, Suspense, type ComponentType } from "react";

/**
 * Inspection screens for App.tsx. Each loads on first visit, so an instance
 * with the feature switched off does not download them.
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

export const InspectionsListPage = lazyPage(() => import("./InspectionsPage").then((m) => m.InspectionsPage));
export const InspectionDetailPage = lazyPage(() => import("./InspectionDetail").then((m) => m.InspectionDetail));
