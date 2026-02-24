import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { makeLocationLabel } from "../lib/locationLabel";
import { useConfig } from "../config/useConfig";
import type { Company, Location } from "../types";

export function Locations() {
  const [locations, setLocations] = useState<Location[]>([]);
  const { config } = useConfig();
  const { terms, features } = config;
  const group = terms.group.singular;
  const [companies, setCompanies] = useState<Company[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [parentId, setParentId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = () => {
    api.listLocations().then(setLocations).catch(() => undefined);
    api.listCompanies().then(setCompanies).catch(() => undefined);
  };
  useEffect(() => {
    load();
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await api.createLocation({
      name: name.trim(),
      address: address.trim() || null,
      companyId: companyId || null,
      parentId: parentId || null,
    });
    setName("");
    setAddress("");
    setCompanyId("");
    setParentId("");
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this location? Items there become unassigned.")) return;
    await api.deleteLocation(id);
    load();
  };

  const addCompany = async (e: FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) return;
    await api.createCompany({ name: companyName.trim() });
    setCompanyName("");
    load();
  };

  const removeCompany = async (id: string) => {
    if (!confirm(`Delete this ${group.toLowerCase()}? Its ${terms.location.plural.toLowerCase()} become unassigned.`)) return;
    await api.deleteCompany(id);
    load();
  };

  const setLocationCompany = async (id: string, value: string) => {
    await api.updateLocation(id, { companyId: value || null });
    load();
  };

  const setLocationParent = async (id: string, value: string) => {
    try {
      await api.updateLocation(id, { parentId: value || null });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Couldn't set parent location");
    }
    load();
  };

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setDraft(name);
  };

  const cancelRename = () => {
    setEditingId(null);
    setDraft("");
  };

  const saveRename = async (id: string) => {
    const name = draft.trim();
    if (!name) return;
    await api.updateLocation(id, { name });
    cancelRename();
    load();
  };

  const onRenameKey = (id: string, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") saveRename(id);
    if (e.key === "Escape") cancelRename();
  };

  const label = makeLocationLabel(locations);

  // Group into a tree: top-level locations, with their containers nested beneath.
  const byParent = new Map<string, Location[]>();
  for (const l of locations) {
    if (!l.parentId) continue;
    byParent.set(l.parentId, [...(byParent.get(l.parentId) ?? []), l]);
  }
  const ids = new Set(locations.map((l) => l.id));
  const roots = locations.filter((l) => !l.parentId || !ids.has(l.parentId));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">{terms.location.plural}</h1>

      {features.groups && (
      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          {terms.group.plural}
        </h2>
        <form onSubmit={addCompany} className="flex flex-col gap-2 sm:flex-row">
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder={`${group} name`}
            aria-label={`${group} name`}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100"
          />
          <button className="rounded-lg bg-sky-600 px-5 py-2 font-medium text-white hover:bg-sky-500">
            Add
          </button>
        </form>
        <ul className="flex flex-wrap gap-2">
          {companies.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-sm text-slate-200"
            >
              {c.name}
              <button
                onClick={() => removeCompany(c.id)}
                aria-label={`Delete ${c.name}`}
                className="text-slate-500 hover:text-red-400"
              >
                ×
              </button>
            </li>
          ))}
          {companies.length === 0 && (
            <li className="text-sm text-slate-500">No {terms.group.plural.toLowerCase()} yet.</li>
          )}
        </ul>
      </section>
      )}

      <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${terms.location.singular} name`}
          aria-label={`${terms.location.singular} name`}
          className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100"
        />
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Address (optional)"
          aria-label="Address"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100"
        />
        <select
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          aria-label={group}
          hidden={!features.groups}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100"
        >
          <option value="">{`No ${group.toLowerCase()}`}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          aria-label="Inside (parent location)"
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100"
        >
          <option value="">Top level</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {label(l)}
            </option>
          ))}
        </select>
        <button className="rounded-lg bg-sky-600 px-5 py-2 font-medium text-white hover:bg-sky-500">
          Add
        </button>
      </form>

      <ul className="space-y-2">
        {roots.map((l) => renderLocation(l, 0))}
        {locations.length === 0 && <li className="text-slate-500">No locations yet.</li>}
      </ul>
    </div>
  );

  /** One location row, then its containers indented beneath it. */
  function renderLocation(l: Location, depth: number): ReactElement {
    const children = byParent.get(l.id) ?? [];
    return (
      <li key={l.id} style={depth ? { marginLeft: depth * 24 } : undefined}>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900 px-4 py-3">
          <div>
            {editingId === l.id ? (
              <div className="flex items-center gap-2">
                {depth > 0 && <span className="h-4 w-3 border-b border-l border-slate-700" />}
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => onRenameKey(l.id, e)}
                  aria-label={`Rename ${l.name}`}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100"
                />
                <button
                  onClick={() => saveRename(l.id)}
                  className="text-sm text-emerald-400 hover:text-emerald-300"
                >
                  Save
                </button>
                <button onClick={cancelRename} className="text-sm text-slate-500 hover:text-slate-300">
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <Link to={`/locations/${l.id}`} className="font-medium text-sky-400 hover:underline">
                  {depth > 0 && <span className="mr-1 h-4 w-3 border-b border-l border-slate-700" />}
                  {l.name}
                </Link>
                {l.address && <p className="text-sm text-slate-500">{l.address}</p>}
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <select
              value={l.parentId ?? ""}
              onChange={(e) => setLocationParent(l.id, e.target.value)}
              aria-label={`Parent location for ${l.name}`}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-300"
            >
              <option value="">Top level</option>
              {locations
                .filter((p) => p.id !== l.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {label(p)}
                  </option>
                ))}
            </select>
            <select
              value={l.companyId ?? ""}
              onChange={(e) => setLocationCompany(l.id, e.target.value)}
              aria-label={`${group} for ${l.name}`}
              hidden={!features.groups}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-300"
            >
              <option value="">{`No ${group.toLowerCase()}`}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => startRename(l.id, l.name)}
              className="text-sm text-slate-500 hover:text-sky-300"
              aria-label={`Rename ${l.name}`}
            >
              Rename
            </button>
            <button
              onClick={() => remove(l.id)}
              className="text-sm text-slate-500 hover:text-red-400"
            >
              Delete
            </button>
          </div>
        </div>
        {children.length > 0 && (
          <ul className="mt-2 space-y-2">{children.map((c) => renderLocation(c, depth + 1))}</ul>
        )}
      </li>
    );
  }
}
