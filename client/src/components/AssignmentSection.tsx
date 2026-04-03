import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useTerms } from "../config/useConfig";
import type { Entity, ItemDetail } from "../types";

const fmt = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Check-out / check-in control plus the item's assignment history. */
export function AssignmentSection({
  item,
  onChange,
}: {
  item: ItemDetail;
  onChange: (i: ItemDetail) => void;
}) {
  const terms = useTerms();
  const one = terms.holder.singular.toLowerCase();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [entityId, setEntityId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listEntities().then(setEntities).catch(() => undefined);
  }, []);

  const open = item.assignments.find((a) => a.checkedInAt === null) ?? null;

  const checkOut = async () => {
    if (!entityId) return;
    setBusy(true);
    setErr(null);
    try {
      onChange(await api.checkOut(item.id, entityId));
      setEntityId("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Check-out failed");
    } finally {
      setBusy(false);
    }
  };

  const checkIn = async () => {
    setBusy(true);
    setErr(null);
    try {
      onChange(await api.checkIn(item.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Check-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Assignment
      </h2>

      {open ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-800/60 px-3 py-2">
          <span className="text-sm text-slate-200">
            Checked out to <span className="font-medium text-slate-100">{open.entityName}</span>{" "}
            <span className="text-slate-500">since {fmt(open.checkedOutAt)}</span>
          </span>
          <button
            onClick={checkIn}
            disabled={busy}
            className="ml-auto rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "…" : "Check in"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            aria-label={`${terms.holder.singular} to check out to`}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
          >
            <option value="">{`Select ${one}…`}</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.kind ? ` (${e.kind})` : ""}
              </option>
            ))}
          </select>
          <button
            onClick={checkOut}
            disabled={busy || !entityId}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "…" : "Check out"}
          </button>
          {entities.length === 0 && (
            <span className="text-sm text-slate-500">
              Add {terms.holder.plural.toLowerCase()} first.
            </span>
          )}
        </div>
      )}

      {err && <p className="mt-1 text-sm text-red-400">{err}</p>}

      {item.assignments.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {item.assignments.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between rounded-lg bg-slate-800/40 px-3 py-2 text-sm"
            >
              <span className="text-slate-200">{a.entityName}</span>
              <span className="text-slate-500">
                {fmt(a.checkedOutAt)} to {a.checkedInAt ? fmt(a.checkedInAt) : "now"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
