import { lazy, Suspense, type ComponentType } from "react";

/**
 * Jobs screens for App.tsx. Each loads on first visit, so an instance with the
 * feature switched off, or someone who never opens a job, does not download
 * them.
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

export const JobsPage = lazyPage(() => import("./JobsPage").then((m) => m.JobsPage));
export const JobDetailPage = lazyPage(() => import("./JobDetail").then((m) => m.JobDetail));
export const ProjectsPage = lazyPage(() => import("./Projects").then((m) => m.ProjectsPage));
export const ProjectDetailPage = lazyPage(() => import("./Projects").then((m) => m.ProjectDetail));
export const ShipmentDetailPage = lazyPage(() => import("./ShipmentDetail").then((m) => m.ShipmentDetail));
export const JobTypesPage = lazyPage(() => import("./JobTypesPage").then((m) => m.JobTypesPage));
