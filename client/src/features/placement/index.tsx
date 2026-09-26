import { lazy, Suspense, type ComponentType } from "react";

/**
 * Placement screens for App.tsx. Each loads on first visit, so an instance
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

export const PlacementHomePage = lazyPage(() => import("./PlacementHome").then((m) => m.PlacementHome));
export const PlacementJobPage = lazyPage(() => import("./PlacementJob").then((m) => m.PlacementJob));
export const PlacementWherePage = lazyPage(() => import("./WhereMode").then((m) => m.WhereMode));
export const PlacementSweepPage = lazyPage(() => import("./SweepMode").then((m) => m.SweepMode));
export const PlacementKioskPage = lazyPage(() => import("./Kiosk").then((m) => m.Kiosk));
