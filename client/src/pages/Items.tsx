import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useConfig } from "../config/useConfig";
import { makeLocationLabel } from "../lib/locationLabel";
import type { Company, Entity, Item, ItemKind, Location } from "../types";
import { itemKind } from "../types";
import { ItemCard } from "../components/ItemCard";
import { DomainRow } from "../components/DomainRow";
import { useScan } from "../scan/ScanProvider";

const DIGITAL_KINDS: Set<ItemKind> = new Set(["digital", "all"]);

const KINDS: { value: ItemKind; label: string }[] = [
  { value: "physical", label: "Physical" },
  { value: "digital", label: "Digital" },
  { value: "all", label: "All" },
];

function parseKind(raw: string | null): ItemKind {
  return KINDS.some((k) => k.value === raw) ? (raw as ItemKind) : "physical";
}

export function Items() {
  const { scan } = useScan();
  const { config } = useConfig();
  const { terms, features } = config;
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [askMode, setAskMode] = useState(false);
  const [askFilter, setAskFilter] = useState<Record<string, unknown> | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [busy, setBusy] = useState(false);
  const kind = parseKind(params.get("kind"));
  const isDigitalList = DIGITAL_KINDS.has(kind);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
    api.listEntities().then(setEntities).catch(() => undefined);
    api.listCompanies().then(setCompanies).catch(() => undefined);
  }, []);

  const listParams = () => ({
    q: q.trim() || undefined,
    companyId: companyId || undefined,
    kind,
  });

  const refresh = () => api.listItems(listParams()).then(setItems).catch(() => setItems([]));

  const updateParams = (nextKind: ItemKind) => {
    const next: Record<string, string> = {};
    if (q.trim()) next.q = q.trim();
    if (nextKind !== "physical") next.kind = nextKind;
    setParams(next, { replace: true });
  };

  // Keyword search runs as you type; asking a question runs on submit instead.
  useEffect(() => {
    if (askMode) return;
    const handle = setTimeout(() => {
      setLoading(true);
      updateParams(kind);
      api
        .listItems(listParams())
        .then(setItems)
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, askMode, companyId, kind]);

  const ask = async () => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setAskFilter(null);
    try {
      const res = await api.askSearch(query, kind);
      setItems(res.items);
      setAskFilter(res.filter);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const setKind = (next: ItemKind) => {
    setSelected(new Set());
    updateParams(next);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const printSelected = (compact = false) => {
    if (selected.size === 0) return;
    const style = compact ? "&style=compact" : "";
    window.open(`/print?ids=${[...selected].join(",")}${style}`, "_blank", "noopener");
    exitSelect();
  };

  const bulkSet = async (set: { locationId?: string | null; utilizedByEntityId?: string | null }) => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      await api.bulkUpdate([...selected], set);
      exitSelect();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const bulkRemove = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} item(s)? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.bulkDelete([...selected]);
      exitSelect();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const locLabel = makeLocationLabel(locations);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (askMode && e.key === "Enter") {
              e.preventDefault();
              void ask();
            }
          }}
          placeholder={
            askMode
              ? "Describe what you are looking for, such as unassigned monitors over $200"
              : `Search ${terms.item.plural.toLowerCase()}…`
          }
          aria-label={`Search ${terms.item.plural.toLowerCase()}`}
          autoFocus
          className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
        />
        {askMode && (
          <button
            onClick={ask}
            className="shrink-0 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-500"
          >
            Search
          </button>
        )}
        {features.askSearch && (
          <button
            onClick={() => {
              setAskMode((v) => !v);
              setAskFilter(null);
            }}
            aria-pressed={askMode}
            title="Describe what you are looking for instead of setting filters"
            className={`shrink-0 rounded-lg border px-4 py-2.5 text-sm ${
              askMode
                ? "border-sky-500 bg-sky-950/40 text-sky-300"
                : "border-slate-700 text-slate-200 hover:bg-slate-800"
            }`}
          >
            Ask
          </button>
        )}
        <button
          onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
          className="shrink-0 rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          {selectMode ? "Cancel" : "Select"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k.value}
            onClick={() => setKind(k.value)}
            aria-pressed={kind === k.value}
            className={`rounded-full border px-3 py-1 text-xs ${
              kind === k.value
                ? "border-sky-500 bg-sky-950/40 text-sky-300"
                : "border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {!askMode && features.groups && companies.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setCompanyId("")}
            aria-pressed={companyId === ""}
            className={`rounded-full border px-3 py-1 text-xs ${
              companyId === ""
                ? "border-sky-500 bg-sky-950/40 text-sky-300"
                : "border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
          >
            All
          </button>
          {companies.map((c) => (
            <button
              key={c.id}
              onClick={() => setCompanyId(companyId === c.id ? "" : c.id)}
              aria-pressed={companyId === c.id}
              className={`rounded-full border px-3 py-1 text-xs ${
                companyId === c.id
                  ? "border-sky-500 bg-sky-950/40 text-sky-300"
                  : "border-slate-700 text-slate-300 hover:bg-slate-800"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {askMode && askFilter && Object.keys(askFilter).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500">Read as:</span>
          {Object.entries(askFilter).map(([k, v]) => (
            <span key={k} className="rounded-full bg-slate-800 px-2 py-0.5 text-slate-300">
              {k}: {String(v)}
            </span>
          ))}
        </div>
      )}

      {selectMode && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900 px-4 py-2.5">
          <span className="text-sm text-slate-300">{selected.size} selected</span>
          <button
            onClick={() => setSelected(new Set(items.map((i) => i.id)))}
            className="text-sm text-sky-400 hover:underline"
          >
            Select all
          </button>
          {!isDigitalList && (
            <select
              aria-label="Move to location"
              disabled={selected.size === 0 || busy}
              value=""
              onChange={(e) => e.target.value && bulkSet({ locationId: e.target.value })}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-50"
            >
              <option value="">Move to…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {locLabel(l)}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label={`Assign to ${terms.holder.singular.toLowerCase()}`}
            disabled={selected.size === 0 || busy}
            value=""
            onChange={(e) =>
              bulkSet({ utilizedByEntityId: e.target.value === "__none" ? null : e.target.value })
            }
            className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-50"
          >
            <option value="">{`Assign to ${terms.holder.singular.toLowerCase()}…`}</option>
            <option value="__none">Unassign</option>
            {entities.map((en) => (
              <option key={en.id} value={en.id}>
                {en.name}
              </option>
            ))}
          </select>
          {!isDigitalList && (
            <>
              <button
                onClick={() => printSelected()}
                disabled={selected.size === 0}
                className="ml-auto rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                Print {selected.size} label{selected.size === 1 ? "" : "s"}
              </button>
              <button
                onClick={() => printSelected(true)}
                disabled={selected.size === 0}
                title="Just the QR code with the code beneath it"
                className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                Compact
              </button>
            </>
          )}
          <button
            onClick={bulkRemove}
            disabled={selected.size === 0 || busy}
            className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      )}

      {loading ? (
        <p className="py-10 text-center text-slate-500">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center">
          <p className="text-slate-500">
            {q
              ? `Nothing matches “${q}”.`
              : `No ${terms.item.plural.toLowerCase()} yet.`}
          </p>
          {q.trim() && (
            <button
              onClick={() => scan(q.trim())}
              className="mt-4 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
            >
              Create “{q.trim()}” and look up the details
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) =>
            itemKind(item.category) === "digital" ? (
              <DomainRow
                key={item.id}
                domain={item}
                selectable={selectMode}
                selected={selected.has(item.id)}
                onToggle={toggle}
              />
            ) : (
              <ItemCard
                key={item.id}
                item={item}
                selectable={selectMode}
                selected={selected.has(item.id)}
                onToggle={toggle}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
