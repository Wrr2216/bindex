import { lazy, Suspense } from "react";

/**
 * The Insights page for App.tsx. Loaded on first visit, so an instance with
 * the feature off, or someone who never opens it, does not download it.
 */
const Page = lazy(async () => ({ default: (await import("./InsightsPage")).InsightsPage }));

export function InsightsPage() {
  return (
    <Suspense fallback={<p className="text-slate-400">Loading…</p>}>
      <Page />
    </Suspense>
  );
}
