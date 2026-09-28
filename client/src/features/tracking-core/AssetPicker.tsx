import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useFeatures, useTerms } from "../../config/useConfig";
import { FIELD } from "../../components/ui";
import type { Item, ItemUnit } from "../../types";

export type AssetChoice = {
  itemId: string | null;
  itemName: string | null;
  unitId: string | null;
};

/**
 * Pick the thing a tag or tracker is attached to: search for it, then
 * optionally narrow to one of its units.
 */
export function AssetPicker({ value, onChange }: { value: AssetChoice; onChange: (next: AssetChoice) => void }) {
  const terms = useTerms();
  const features = useFeatures();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [units, setUnits] = useState<ItemUnit[]>([]);

  useEffect(() => {
    if (value.itemId || !q.trim()) {
      setResults([]);
      return;
    }
    let active = true;
    const t = setTimeout(() => {
      api
        .listItems({ q: q.trim() })
        .then((items) => active && setResults(items.slice(0, 8)))
        .catch(() => undefined);
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [q, value.itemId]);

  useEffect(() => {
    if (!value.itemId || !features.units) {
      setUnits([]);
      return;
    }
    let active = true;
    api
      .getItem(value.itemId)
      .then((item) => active && setUnits(item.units))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [value.itemId, features.units]);

  if (value.itemId) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-800/60 px-3 py-2">
          <span className="truncate text-sm text-slate-200">{value.itemName ?? terms.item.singular}</span>
          <button
            type="button"
            onClick={() => onChange({ itemId: null, itemName: null, unitId: null })}
            className="text-xs text-slate-400 hover:text-red-300"
          >
            Detach
          </button>
        </div>
        {units.length > 0 && (
          <select
            value={value.unitId ?? ""}
            onChange={(e) => onChange({ ...value, unitId: e.target.value || null })}
            aria-label="Unit"
            className={FIELD}
          >
            <option value="">The whole {terms.item.singular.toLowerCase()}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label || u.serial || u.assetCode}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${terms.item.plural.toLowerCase()}…`}
        aria-label={`Attach to ${terms.item.singular.toLowerCase()}`}
        className={FIELD}
      />
      {results.length > 0 && (
        <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900">
          {results.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  onChange({ itemId: item.id, itemName: item.name, unitId: null });
                  setQ("");
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800"
              >
                <span className="truncate text-slate-200">{item.name}</span>
                <span className="font-mono text-xs text-slate-500">{item.assetCode}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
