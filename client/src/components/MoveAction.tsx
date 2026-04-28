import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useConfig } from "../config/useConfig";
import { makeLocationLabel } from "../lib/locationLabel";
import type { ItemDetail, Location } from "../types";

/**
 * Move a container somewhere else. With spot checks turned on, and where the
 * item has contents or shares a location with others, it first asks whether one
 * of them was really there, and records the answer before the move goes through.
 */
export function MoveAction({ item, onChange }: { item: ItemDetail; onChange: (i: ItemDetail) => void }) {
  const [open, setOpen] = useState(false);
  const { config } = useConfig();
  const spotEnabled = config.features.spotCheck;
  const [locations, setLocations] = useState<Location[]>([]);
  const [destId, setDestId] = useState(item.locationId ?? "");
  const [candidate, setCandidate] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);

  const reset = () => {
    setOpen(false);
    setCandidate(null);
    setMsg(null);
  };

  const applyMove = async () => {
    setBusy(true);
    try {
      const updated = await api.updateItem(item.id, { locationId: destId || null });
      onChange(updated);
      setOpen(false);
      setCandidate(null);
    } finally {
      setBusy(false);
    }
  };

  const startMove = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (spotEnabled) {
        const { candidate } = await api.spotCheckCandidate(item.id);
        if (candidate) {
          setCandidate(candidate);
          return; // wait for the user's answer
        }
      }
      await applyMove();
    } finally {
      setBusy(false);
    }
  };

  const answer = async (seen: boolean) => {
    setBusy(true);
    try {
      if (candidate) await api.recordSpotCheck(candidate.id, seen);
      if (!seen && candidate) setMsg(`Flagged “${candidate.name}” as possibly missing.`);
      await applyMove();
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
      >
        Move / Retrieve
      </button>
    );
  }

  const label = makeLocationLabel(locations);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
      {candidate ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-200">
            Spot check: did you see <span className="font-medium text-slate-100">{candidate.name}</span> in there?
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => answer(true)}
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Yes, saw it
            </button>
            <button
              onClick={() => answer(false)}
              disabled={busy}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              No, not there
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-slate-300">
            Move to
            <select
              value={destId}
              onChange={(e) => setDestId(e.target.value)}
              className="ml-2 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="">Unassigned</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {label(l)}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={startMove}
            disabled={busy}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "…" : "Move"}
          </button>
          <button
            onClick={reset}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-amber-400">{msg}</p>}
    </div>
  );
}
