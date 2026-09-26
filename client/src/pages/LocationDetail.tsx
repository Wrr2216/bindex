import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { NfcTagUrl } from "../components/NfcTagUrl";
import { ItemTagChip } from "../features/tag-commissioning/badges";
import { VerifyContents } from "../components/VerifyContents";
import { useFeatures } from "../config/useConfig";
import { DetectedHere } from "../features/tracking-core/DetectedHere";
import { LocationMediaSection } from "../features/media-ai-core";
import { ArrowLeftIcon, CloseIcon, PencilIcon } from "../components/icons";
import type { Item, LocationDetail as Detail } from "../types";

export function LocationDetail() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [loc, setLoc] = useState<Detail | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [containerNames, setContainerNames] = useState("");
  const [addingContainers, setAddingContainers] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingChildId, setEditingChildId] = useState<string | null>(null);
  const [childDraft, setChildDraft] = useState("");

  const load = useCallback(() => {
    if (!id) return;
    api.getLocation(id).then(setLoc).catch(() => setLoc(null));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // The picker searches on the server, so it can find things not on screen.
  useEffect(() => {
    if (!adding) return;
    let active = true;
    api
      .listItems({ q: q.trim() || undefined })
      .then((items) => active && setResults(items))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [adding, q]);

  if (!loc) return <p className="py-10 text-center text-slate-500">Loading…</p>;

  const printLabel = () => window.open(`/print?location=${loc.id}`, "_blank", "noopener");
  const printCompact = () =>
    window.open(`/print?location=${loc.id}&style=compact`, "_blank", "noopener");
  const printContents = () => window.open(api.locationManifestPdfUrl(loc.id), "_blank", "noopener");

  // Several names at once ("1A, 1B, 1C") so a whole rack of containers can be
  // set up in one go rather than one form submission each.
  const addContainers = async () => {
    const names = containerNames
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return;
    setAddingContainers(true);
    try {
      for (const name of names) {
        await api.createLocation({ name, parentId: loc.id, companyId: loc.companyId });
      }
      setContainerNames("");
      load();
    } finally {
      setAddingContainers(false);
    }
  };

  const toggle = (itemId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });

  const addSelected = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      setLoc(await api.assignItemsToLocation(loc.id, [...selected]));
      setSelected(new Set());
      setAdding(false);
      setQ("");
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (itemId: string) => {
    await api.updateItem(itemId, { locationId: null });
    load();
  };

  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name || !loc) return;
    await api.updateLocation(loc.id, { name });
    setEditingName(false);
    setNameDraft("");
    load();
  };

  const startChildRename = (id: string, name: string) => {
    setEditingChildId(id);
    setChildDraft(name);
  };

  const saveChildRename = async (id: string) => {
    const name = childDraft.trim();
    if (!name) return;
    await api.updateLocation(id, { name });
    setEditingChildId(null);
    setChildDraft("");
    load();
  };

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") saveName();
    if (e.key === "Escape") {
      setEditingName(false);
      setNameDraft("");
    }
  };

  const onChildKey = (id: string, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") saveChildRename(id);
    if (e.key === "Escape") {
      setEditingChildId(null);
      setChildDraft("");
    }
  };

  // Nothing already here is worth offering to add.
  const candidates = results.filter((r) => r.locationId !== loc.id);

  return (
    <div className="space-y-6">
      <Link
        to="/locations"
        className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:underline"
      >
        <ArrowLeftIcon className="h-3.5 w-3.5" />
        Back to all
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {loc.parentId && loc.parentName && (
            <p className="text-sm text-slate-400">
              In{" "}
              <Link to={`/locations/${loc.parentId}`} className="text-sky-400 hover:underline">
                {loc.parentName}
              </Link>
            </p>
          )}
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={onNameKey}
                aria-label="Rename location"
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-lg font-semibold text-slate-100"
              />
              <button
                onClick={saveName}
                className="text-sm text-emerald-400 hover:text-emerald-300"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditingName(false);
                  setNameDraft("");
                }}
                className="text-sm text-slate-500 hover:text-slate-300"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-100">{loc.name}</h1>
              <button
                onClick={() => {
                  setEditingName(true);
                  setNameDraft(loc.name);
                }}
                aria-label="Rename location"
                className="text-sm text-slate-500 hover:text-sky-300"
              >
                <PencilIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <p className="text-slate-400">
            {[loc.companyName, loc.address].filter(Boolean).join(" · ") || "Not set"}
          </p>
          <p className="mt-1 text-sm text-sky-300">
            {loc.itemCount} item{loc.itemCount === 1 ? "" : "s"} · {loc.totalUnits} unit
            {loc.totalUnits === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={printLabel}
            className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
          >
            Container label
          </button>
          <button
            onClick={printCompact}
            title="Just the QR code with the code beneath it"
            className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
          >
            Compact label
          </button>
          <button
            onClick={printContents}
            className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
          >
            Contents sheet
          </button>
          <a
            href={api.locationLabelPreviewUrl(loc.id)}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            Preview label
          </a>
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Containers ({loc.children.length})
        </h2>
        <ul className="space-y-1.5">
          {loc.children.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between rounded-lg bg-slate-800/60 px-3 py-2"
            >
              {editingChildId === c.id ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={childDraft}
                    onChange={(e) => setChildDraft(e.target.value)}
                    onKeyDown={(e) => onChildKey(c.id, e)}
                    aria-label={`Rename ${c.name}`}
                    className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
                  />
                  <button
                    onClick={() => saveChildRename(c.id)}
                    className="text-xs text-emerald-400 hover:text-emerald-300"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => {
                      setEditingChildId(null);
                      setChildDraft("");
                    }}
                    className="text-xs text-slate-500 hover:text-slate-300"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Link to={`/locations/${c.id}`} className="text-sky-400 hover:underline">
                    {c.name}
                  </Link>
                  <button
                    onClick={() => startChildRename(c.id, c.name)}
                    aria-label={`Rename ${c.name}`}
                    className="text-xs text-slate-500 hover:text-sky-300"
                  >
                    <PencilIcon className="h-3 w-3" />
                  </button>
                </div>
              )}
              <span className="text-sm text-slate-500">
                {c.itemCount} item{c.itemCount === 1 ? "" : "s"}
              </span>
            </li>
          ))}
          {loc.children.length === 0 && (
            <li className="text-sm text-slate-500">
              No containers yet. Add some below, such as 1A, 1B, 1C.
            </li>
          )}
        </ul>
        <div className="mt-2 flex gap-2">
          <input
            value={containerNames}
            onChange={(e) => setContainerNames(e.target.value)}
            placeholder="New container names, comma-separated (1A, 1B, 1C…)"
            aria-label="New container names"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
          />
          <button
            onClick={addContainers}
            disabled={addingContainers || !containerNames.trim()}
            className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {addingContainers ? "Adding…" : "Add containers"}
          </button>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Contents ({loc.itemCount})
          </h2>
          <button
            onClick={() => setAdding((v) => !v)}
            className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
          >
            {adding ? "Done" : "+ Add items"}
          </button>
        </div>

        <div className="mb-3">
          <VerifyContents location={loc} onApplied={setLoc} />
        </div>

        {adding && (
          <div className="mb-3 rounded-xl border border-slate-700 bg-slate-900 p-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
              placeholder="Search items to add…"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
            />
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
              {candidates.map((r) => (
                <li key={r.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-800">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                    <span className="text-sm text-slate-200">{r.name}</span>
                    <span className="font-mono text-xs text-slate-500">{r.assetCode}</span>
                    {r.locationName && (
                      <span className="text-xs text-slate-500">· in {r.locationName}</span>
                    )}
                  </label>
                </li>
              ))}
              {candidates.length === 0 && (
                <li className="px-2 py-1 text-sm text-slate-500">No matching items.</li>
              )}
            </ul>
            <button
              onClick={addSelected}
              disabled={busy || selected.size === 0}
              className="mt-2 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {busy ? "Adding…" : `Add ${selected.size || ""} to ${loc.name}`}
            </button>
          </div>
        )}

        <ul className="space-y-1.5">
          {loc.contents.map((c) => (
            <li
              key={c.id}
              className="flex items-start justify-between gap-3 rounded-lg bg-slate-800/60 px-3 py-2"
            >
              <div className="min-w-0">
                <Link
                  to={`/items/${c.id}`}
                  className={c.flaggedMissing ? "text-red-300 hover:underline" : "text-sky-400 hover:underline"}
                >
                  {c.name}
                </Link>{" "}
                <span className="text-sm text-slate-500">×{c.quantity}</span>{" "}
                <ItemTagChip itemId={c.id} />
                {[c.brand, c.model].filter(Boolean).length > 0 && (
                  <p className="text-xs text-slate-500">{[c.brand, c.model].filter(Boolean).join(" · ")}</p>
                )}
                {c.serials.length > 0 && (
                  <p className="font-mono text-xs text-slate-400">S/N: {c.serials.join(", ")}</p>
                )}
                {c.flaggedMissing && (
                  <span className="text-xs text-red-400">possibly missing</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="font-mono text-xs text-slate-500">{c.assetCode}</span>
                <button
                  onClick={() => removeItem(c.id)}
                  aria-label={`Remove ${c.name} from ${loc.name}`}
                  className="text-slate-500 hover:text-red-400"
                  title="Take out of this location"
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
          {loc.contents.length === 0 && (
            <li className="text-sm text-slate-500">Nothing in this location yet. Use “Add items”.</li>
          )}
        </ul>
      </section>

      {features.tracking && <DetectedHere locationId={loc.id} />}
      <LocationMediaSection locationId={loc.id} />

      <NfcTagUrl path={`/locations/${loc.id}`} kind="location" />
    </div>
  );
}
