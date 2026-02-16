import { useEffect, useState } from "react";
import type { Enrichment, ItemDetail, Location, OverlayState } from "../types";
import { ItemForm } from "./ItemForm";
import { ProductImage } from "./ProductImage";
import { CloseIcon } from "./icons";

function IdentifierPills({ item }: { item: ItemDetail }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {item.identifiers.map((id) => (
        <span
          key={id.id}
          className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300"
          title={id.type}
        >
          {id.type}: {id.value}
        </span>
      ))}
    </div>
  );
}

function FoundView({
  item,
  onViewFull,
}: {
  item: ItemDetail;
  onViewFull: (id: string, unitId?: string | null) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <ProductImage
          src={item.primaryImageUrl}
          alt={item.name}
          className="h-20 w-20 shrink-0 rounded-lg object-contain"
        />
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold text-slate-100">{item.name}</h3>
          <p className="text-sm text-slate-400">
            {[item.brand, item.model].filter(Boolean).join(" · ") || "Not set"}
          </p>
          <p className="mt-0.5 text-sm text-sky-300">
            Qty {item.quantity} · {item.locationName ?? "Unassigned"}
            {item.companyName ? ` · ${item.companyName}` : ""}
          </p>
        </div>
      </div>
      {item.description && <p className="text-sm text-slate-300">{item.description}</p>}
      <IdentifierPills item={item} />
      {item.children.length > 0 && (
        <p className="text-sm text-slate-400">Contains {item.children.length} item(s).</p>
      )}
      <button
        onClick={() => onViewFull(item.id, item.matchedUnitId)}
        className="w-full rounded-lg bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-500"
      >
        View full details
      </button>
    </div>
  );
}

/** New-item view: a re-search row (correct the lookup term / enter manually) over the form. */
function CreateView({
  code,
  enrichment,
  enriching,
  rev,
  locations,
  researching,
  onResearch,
  onManual,
  onSkipEnrich,
  onSaved,
  onClose,
}: {
  code: string;
  enrichment?: Enrichment;
  enriching?: boolean;
  rev?: number;
  locations: Location[];
  researching: boolean;
  onResearch: (term: string) => void;
  onManual: () => void;
  onSkipEnrich: () => void;
  onSaved: (item: ItemDetail) => void;
  onClose: () => void;
}) {
  const [term, setTerm] = useState(code);

  return (
    <>
      <p className="mb-3 text-sm text-slate-400">
        No match for <span className="font-mono text-slate-200">{code}</span>.{" "}
        {enriching
          ? "Fill it in now, or wait for the lookup running in the background."
          : enrichment?.found
            ? `Filled in from ${enrichment.source}. Check it over and save, or search again.`
            : "Nothing matched the code. Search by name or model, or type the details in."}
      </p>

      {enriching && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-sky-900 bg-sky-950/30 px-3 py-2">
          <span className="flex items-center gap-2 text-sm text-sky-300">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
            Looking up the product…
          </span>
          <button
            type="button"
            onClick={onSkipEnrich}
            className="shrink-0 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            Skip
          </button>
        </div>
      )}

      <div className="mb-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
          Search term
        </label>
        <p className="mb-1.5 text-xs text-slate-500">
          Wrong result? Type the product name or model and search again.
        </p>
        <div className="flex gap-2">
          <input
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onResearch(term);
              }
            }}
            placeholder="e.g. UniFi U6 Pro"
          />
          <button
            type="button"
            onClick={() => onResearch(term)}
            disabled={researching || !term.trim()}
            className="shrink-0 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {researching ? "Searching…" : "Search again"}
          </button>
          <button
            type="button"
            onClick={onManual}
            disabled={researching}
            className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Enter manually
          </button>
        </div>
      </div>

      <ItemForm
        key={`${code}:${rev ?? 0}`}
        code={code}
        enrichment={enrichment}
        locations={locations}
        onSaved={onSaved}
        onCancel={onClose}
      />
    </>
  );
}

/** Portal-free modal shown over any route when a scan resolves or needs creating. */
export function ItemOverlay({
  state,
  locations,
  researching,
  onResearch,
  onManual,
  onSkipEnrich,
  onClose,
  onSaved,
  onViewFull,
}: {
  state: OverlayState;
  locations: Location[];
  researching: boolean;
  onResearch: (term: string) => void;
  onManual: () => void;
  onSkipEnrich: () => void;
  onClose: () => void;
  onSaved: (item: ItemDetail) => void;
  onViewFull: (id: string, unitId?: string | null) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (state.kind === "closed") return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16 backdrop-blur-sm sm:items-center sm:pt-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            {state.kind === "found" && "Item found"}
            {state.kind === "create" && "New item"}
            {state.kind === "loading" && "Looking up…"}
            {state.kind === "error" && "Scan error"}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {state.kind === "loading" && (
          <p className="py-8 text-center text-slate-400">
            Resolving <span className="font-mono text-slate-200">{state.code}</span>…
          </p>
        )}

        {state.kind === "error" && <p className="py-6 text-center text-red-400">{state.message}</p>}

        {state.kind === "found" && <FoundView item={state.item} onViewFull={onViewFull} />}

        {state.kind === "create" && (
          <CreateView
            code={state.code}
            enrichment={state.enrichment}
            enriching={state.enriching}
            rev={state.rev}
            locations={locations}
            researching={researching}
            onResearch={onResearch}
            onManual={onManual}
            onSkipEnrich={onSkipEnrich}
            onSaved={onSaved}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
