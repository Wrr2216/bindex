import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useConfig } from "../config/useConfig";
import type { Item, ItemKind } from "../types";
import { itemKind } from "../types";
import { ItemCard } from "../components/ItemCard";
import { DomainRow } from "../components/DomainRow";

const KINDS: { value: ItemKind; label: string }[] = [
  { value: "physical", label: "Physical" },
  { value: "digital", label: "Digital" },
  { value: "all", label: "All" },
];

export function Home() {
  const navigate = useNavigate();
  const { config } = useConfig();
  const terms = config.terms;
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<ItemKind>("physical");
  const [recent, setRecent] = useState<Item[]>([]);

  useEffect(() => {
    api
      .listItems({ kind })
      .then(setRecent)
      .catch(() => undefined);
  }, [kind]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const qs = new URLSearchParams({ q: q.trim() });
    if (kind !== "physical") qs.set("kind", kind);
    navigate(`/items?${qs}`);
  };

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-800/40 to-slate-900 p-6 text-center">
        <h1 className="text-2xl font-semibold text-slate-100">Find anything you own</h1>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
          Search before you buy, or scan a code. A reader works anywhere on the page, and the scan
          button uses the camera.
        </p>
        <form onSubmit={onSubmit} className="mx-auto mt-4 flex max-w-lg gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, brand, model, or identifier…"
            aria-label={`Search ${terms.item.plural.toLowerCase()}`}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
          <button className="rounded-lg bg-sky-600 px-5 py-2.5 font-medium text-white hover:bg-sky-500">
            Search
          </button>
        </form>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold text-slate-200">Recently updated</h2>
          <div className="flex items-center gap-2">
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
            <span className="ml-2 text-sm text-slate-500">{recent.length} shown</span>
          </div>
        </div>
        {recent.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-slate-500">
            Nothing here yet. Scan something to add your first{" "}
            {terms.item.singular.toLowerCase()}.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {recent.map((item) =>
              itemKind(item.category) === "digital" ? (
                <DomainRow key={item.id} domain={item} />
              ) : (
                <ItemCard key={item.id} item={item} />
              ),
            )}
          </div>
        )}
      </section>
    </div>
  );
}
