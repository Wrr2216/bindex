import { lazy, Suspense, type ComponentType } from "react";

/**
 * Crew screens for App.tsx. Each loads on first visit, so an instance with the
 * feature switched off does not download them. The Settings card is small and
 * loads with Settings.
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

export const CrewPage = lazyPage(() => import("./CrewPage").then((m) => m.CrewPage));
export const CrewCheckInPage = lazyPage(() => import("./CheckInBoard").then((m) => m.CheckInBoard));
export const CrewWorkerPage = lazyPage(() => import("./WorkerPage").then((m) => m.WorkerPage));
export const CrewBadgePage = lazyPage(() => import("./BadgeRedirect").then((m) => m.BadgeRedirect));
export const CrewSettingsPage = lazyPage(() => import("./CrewSettingsPage").then((m) => m.CrewSettingsPage));
export { CrewSettingsSection } from "./CrewSettingsSection";
