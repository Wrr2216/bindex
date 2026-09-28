import { lazy, Suspense, type ComponentType } from "react";

/**
 * GPS screens for App.tsx. Each loads on first visit, so Leaflet and its
 * styles are only downloaded by someone who opens a map.
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

export const GpsMapPage = lazyPage(() => import("./GpsMapPage").then((m) => m.GpsMapPage));
export const TrackersPage = lazyPage(() => import("./TrackersPage").then((m) => m.TrackersPage));
export const TrailPage = lazyPage(() => import("./TrailPage").then((m) => m.TrailPage));
export const GeofencesPage = lazyPage(() => import("./GeofencesPage").then((m) => m.GeofencesPage));
export const ShipmentMapPage = lazyPage(() => import("./ShipmentMapPage").then((m) => m.ShipmentMapPage));
