import { Link } from "react-router-dom";
import type { Item } from "../types";
import { ProductImage } from "./ProductImage";
import { AlertIcon, CheckIcon } from "./icons";

function CardBody({ item }: { item: Item }) {
  return (
    <>
      <ProductImage
        src={item.primaryImageUrl}
        className="h-16 w-16 shrink-0 rounded-lg object-contain"
      />
      <div className="min-w-0 flex-1 text-left">
        <h3 className="truncate font-medium text-slate-100">{item.name}</h3>
        <p className="truncate text-sm text-slate-400">
          {[item.brand, item.model].filter(Boolean).join(" · ") || "Not set"}
        </p>
        <p className="mt-1 flex items-center gap-2 text-xs text-slate-500">
          <span>
            Qty {item.quantity} · {item.locationName ?? "Unassigned"}
            {item.companyName ? ` · ${item.companyName}` : ""}
          </span>
          {item.ninjaoneAssetId && (
            <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-emerald-400">NinjaOne</span>
          )}
          {item.flaggedMissing && (
            <span className="inline-flex items-center gap-1 rounded bg-red-950 px-1.5 py-0.5 text-red-400">
              <AlertIcon className="h-3 w-3" />
              possibly missing
            </span>
          )}
        </p>
      </div>
    </>
  );
}

export function ItemCard({
  item,
  selectable,
  selected,
  onToggle,
}: {
  item: Item;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (id: string) => void;
}) {
  const base = "flex gap-3 rounded-xl border p-3 transition";

  if (selectable) {
    return (
      <button
        type="button"
        onClick={() => onToggle?.(item.id)}
        aria-pressed={selected}
        className={`${base} text-left ${
          selected
            ? "border-sky-500 bg-sky-950/40"
            : "border-slate-800 bg-slate-900 hover:border-slate-700"
        }`}
      >
        <span
          className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
            selected ? "border-sky-500 bg-sky-500 text-white" : "border-slate-600"
          }`}
          aria-hidden="true"
        >
          {selected && <CheckIcon className="h-3.5 w-3.5" />}
        </span>
        <CardBody item={item} />
      </button>
    );
  }

  return (
    <Link
      to={`/items/${item.id}`}
      className={`${base} ${
        item.flaggedMissing
          ? "border-red-900 bg-red-950/20 hover:border-red-700"
          : "border-slate-800 bg-slate-900 hover:border-slate-700 hover:bg-slate-800/50"
      }`}
    >
      <CardBody item={item} />
    </Link>
  );
}
