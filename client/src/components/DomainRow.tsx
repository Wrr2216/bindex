import { Link } from "react-router-dom";
import type { Item } from "../types";
import { ProductImage } from "./ProductImage";
import { CheckIcon } from "./icons";

const daysUntil = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

export function DomainRow({ domain, selectable, selected, onToggle }: {
  domain: Item;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (id: string) => void;
}) {
  const meta = domain.metadata;
  const registrar = typeof meta.registrar === "string" ? meta.registrar : null;
  const dns = typeof meta.dnsProvider === "string" ? meta.dnsProvider : null;
  const autoRenew = typeof meta.autoRenew === "boolean" ? meta.autoRenew : null;
  const expired = domain.expiresAt ? daysUntil(domain.expiresAt) : null;

  const body = (
    <>
      <ProductImage
        src={domain.primaryImageUrl}
        alt={domain.name}
        className="h-12 w-12 shrink-0 rounded-lg object-contain"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate font-medium text-slate-100">{domain.name}</h3>
          {domain.flaggedMissing && (
            <span className="rounded bg-red-950 px-1.5 py-0.5 text-xs text-red-400">missing?</span>
          )}
        </div>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-400">
          {registrar && <span>Registrar: {registrar}</span>}
          {dns && <span>DNS: {dns}</span>}
          {autoRenew !== null && <span>Auto-renew: {autoRenew ? "on" : "off"}</span>}
        </p>
        {expired !== null && (
          <p
            className={`mt-1 text-xs ${
              expired <= 30 && autoRenew === false ? "text-red-300" : "text-slate-500"
            }`}
          >
            Expires{" "}
            <span className="text-slate-300">
              {new Date(domain.expiresAt!).toLocaleDateString()}
            </span>{" "}
            ({expired < 0 ? "expired" : `in ${expired}d`})
          </p>
        )}
      </div>
    </>
  );

  const base = "flex items-start gap-3 rounded-xl border p-3 transition text-left";

  if (selectable) {
    return (
      <button
        type="button"
        onClick={() => onToggle?.(domain.id)}
        aria-pressed={selected}
        className={`${base} ${
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
        {body}
      </button>
    );
  }

  return (
    <Link
      to={`/items/${domain.id}`}
      className={`${base} border-slate-800 bg-slate-900 hover:border-slate-700`}
    >
      {body}
    </Link>
  );
}
