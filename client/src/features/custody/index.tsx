import { lazy, Suspense, type ComponentType } from "react";

/**
 * Custody screens for App.tsx and the item page. Each loads on first use, so
 * an instance with the feature switched off never downloads them.
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

export const CustodyPage = lazyPage(() => import("./CustodyPage").then((m) => m.CustodyPage));
export const NewTransferPage = lazyPage(() => import("./NewTransfer").then((m) => m.NewTransfer));
export const TransferPage = lazyPage(() => import("./TransferPage").then((m) => m.TransferPage));
export const SignOffPage = lazyPage(() => import("./SignOffPage").then((m) => m.SignOffPage));

const LazyCard = lazy(() => import("./CustodyCard").then((m) => ({ default: m.CustodyCard })));

/** The chain of custody section on an item's page. */
export function ItemCustodySection({ itemId }: { itemId: string }) {
  return (
    <Suspense fallback={null}>
      <LazyCard itemId={itemId} />
    </Suspense>
  );
}
