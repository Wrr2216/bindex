import { useState } from "react";
import { api } from "../api/client";
import { useMoney } from "../config/useConfig";
import type { ItemDetail, PricingResult } from "../types";
import { ProductImage } from "./ProductImage";
import { CheckIcon, ExternalLinkIcon, RefreshIcon } from "./icons";

/**
 * Look up what an item currently sells for, and what it looks like. The result
 * is only a suggestion: the price is applied to the item's value, and a photo
 * copied into local storage, when the person picks one.
 */
export function PricingLookup({
  item,
  onUpdated,
}: {
  item: ItemDetail;
  onUpdated: (item: ItemDetail) => void;
}) {
  const money = useMoney();
  const [result, setResult] = useState<PricingResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Either the string "value" or the URL of the photo being applied.
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.lookupPricing(item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  };

  const useAsValue = async (priceCents: number) => {
    setApplying("value");
    setError(null);
    try {
      onUpdated(await api.updateItem(item.id, { valueCents: priceCents }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set value");
    } finally {
      setApplying(null);
    }
  };

  const usePhoto = async (url: string) => {
    setApplying(url);
    setError(null);
    try {
      onUpdated(await api.setPhotoFromUrl(item.id, url));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set photo");
    } finally {
      setApplying(null);
    }
  };

  const checked =
    result?.checkedAt && !Number.isNaN(Date.parse(result.checkedAt))
      ? new Date(result.checkedAt).toLocaleDateString()
      : null;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Price &amp; photos
        </h2>
        <button
          onClick={lookup}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {result && !busy && <RefreshIcon className="h-3.5 w-3.5" />}
          {busy ? "Searching…" : result ? "Search again" : "Look up price & photos"}
        </button>
      </div>

      {busy && (
        <p className="text-sm text-slate-500">Searching for a current price and photos…</p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {result && !busy && (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
          {result.priceCents != null ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg font-semibold text-slate-100">
                {money(result.priceCents)}
              </span>
              <button
                onClick={() => useAsValue(result.priceCents!)}
                disabled={applying === "value"}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                {applying === "value" ? "Saving…" : `Use as value (${money(result.priceCents)})`}
              </button>
              {item.valueCents === result.priceCents && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                  <CheckIcon className="h-3 w-3" />
                  current value
                </span>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-400">No current price found.</p>
          )}

          {(result.retailer || result.url || checked) && (
            <p className="text-xs text-slate-500">
              {result.retailer && <span>{result.retailer}</span>}
              {result.url && (
                <>
                  {result.retailer ? " · " : ""}
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sky-400 hover:underline"
                  >
                    View source
                    <ExternalLinkIcon className="h-3 w-3" />
                  </a>
                </>
              )}
              {checked && <span> · checked {checked}</span>}
            </p>
          )}

          {result.notes && <p className="text-sm text-slate-300">{result.notes}</p>}

          {result.images.length > 0 && (
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">
                Photos. Pick one to use it for this item.
              </p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {result.images.map((url) => (
                  <button
                    key={url}
                    onClick={() => usePhoto(url)}
                    disabled={applying !== null}
                    title="Set as item photo"
                    className="group relative aspect-square overflow-hidden rounded-lg border border-slate-700 hover:border-sky-500 disabled:opacity-50"
                  >
                    <ProductImage
                      src={url}
                      alt="Candidate product photo"
                      className="h-full w-full object-contain bg-slate-800"
                    />
                    <span className="absolute inset-x-0 bottom-0 bg-slate-900/80 py-0.5 text-center text-[10px] text-slate-200 opacity-0 group-hover:opacity-100">
                      {applying === url ? "Saving…" : "Use this"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {result.priceCents == null && result.images.length === 0 && (
            <p className="text-sm text-slate-500">
              Nothing found. Try correcting the name, brand or model first.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
