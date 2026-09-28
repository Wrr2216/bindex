import { lazy, Suspense } from "react";

// Loaded on first visit, so instances that never open Supplies do not pay for it.
const SuppliesRoutes = lazy(() => import("./routes"));

/** The Supplies section: consumable stock and equipment kits. Mounted at /supplies/*. */
export function SuppliesSection() {
  return (
    <Suspense fallback={<p className="py-10 text-center text-slate-500">Loading…</p>}>
      <SuppliesRoutes />
    </Suspense>
  );
}
