import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useTerms } from "../config/useConfig";
import type { Entity } from "../types";

const KINDS = ["customer", "department", "person", "site", "other"];

export function Entities() {
  const terms = useTerms();
  const one = terms.holder.singular;
  const [entities, setEntities] = useState<Entity[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");

  const load = () => api.listEntities().then(setEntities).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await api.createEntity({ name: name.trim(), kind: kind || null });
    setName("");
    setKind("");
    load();
  };

  const remove = async (id: string) => {
    if (!confirm(`Delete this ${one.toLowerCase()}? Anything assigned becomes unassigned.`)) return;
    await api.deleteEntity(id);
    load();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">{terms.holder.plural}</h1>
      <p className="text-sm text-slate-400">
        Who or what has something out: a person, a team, a customer or a site. Assign from the
        edit form on any {terms.item.singular.toLowerCase()}.
      </p>

      <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${one} name`}
          aria-label={`${one} name`}
          className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label={`${one} kind`}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100"
        >
          <option value="">Kind (optional)</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button className="rounded-lg bg-sky-600 px-5 py-2 font-medium text-white hover:bg-sky-500">
          Add
        </button>
      </form>

      <ul className="space-y-2">
        {entities.map((ent) => (
          <li
            key={ent.id}
            className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 px-4 py-3"
          >
            <div>
              <p className="font-medium text-slate-100">{ent.name}</p>
              {ent.kind && <p className="text-sm text-slate-500">{ent.kind}</p>}
            </div>
            <button
              onClick={() => remove(ent.id)}
              className="text-sm text-slate-500 hover:text-red-400"
            >
              Delete
            </button>
          </li>
        ))}
        {entities.length === 0 && (
          <li className="text-slate-500">No {terms.holder.plural.toLowerCase()} yet.</li>
        )}
      </ul>
    </div>
  );
}
