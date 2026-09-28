import { useState } from "react";
import { PencilIcon } from "../../components/icons";
import { teardownApi } from "./api";
import { KIND_LABEL, KIND_TONE, errorMessage } from "./format";
import type { Guide, Part, PartKind } from "./types";

const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
const KINDS: PartKind[] = ["hardware", "component", "cable", "other"];

function PartEditor({
  guide,
  part,
  onSaved,
  onCancel,
}: {
  guide: Guide;
  part: Part | null;
  onSaved: (guide: Guide) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(part?.name ?? "");
  const [kind, setKind] = useState<PartKind | "">(part?.kind ?? "");
  const [qty, setQty] = useState(String(part?.qty ?? 1));
  const [stepId, setStepId] = useState(part?.stepId ?? "");
  const [note, setNote] = useState(part?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<Guide>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await fn());
    } catch (err) {
      setError(errorMessage(err, "Could not save the part."));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const n = Number(qty);
    if (!name.trim()) return setError("Name the part.");
    if (!Number.isInteger(n) || n < 1) return setError("The quantity is a whole number, 1 or more.");
    const payload = { name: name.trim(), qty: n, stepId: stepId || null, note: note.trim() || null, ...(kind ? { kind } : {}) };
    void run(() => (part ? teardownApi.updatePart(part.id, payload) : teardownApi.addPart(guide.id, payload)));
  };

  return (
    <div className="space-y-2 rounded-lg border border-sky-800 bg-slate-950 p-3">
      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="M6 hex bolt" maxLength={120} className={FIELD} aria-label="Part name" autoFocus />
        <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" className={FIELD} aria-label="Quantity" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as PartKind | "")} className={FIELD} aria-label="Kind">
          {!part && <option value="">Kind: work it out</option>}
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <select value={stepId} onChange={(e) => setStepId(e.target.value)} className={FIELD} aria-label="Step">
          <option value="">No particular step</option>
          {guide.steps.map((s) => (
            <option key={s.id} value={s.id}>
              Step {s.n}: {s.title.slice(0, 40)}
            </option>
          ))}
        </select>
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional): colour, length, where it goes" maxLength={500} className={FIELD} aria-label="Note" />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        {part ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (confirm(`Remove ${part.name} from the list?`)) void run(() => teardownApi.deletePart(part.id));
            }}
            className="rounded-lg border border-red-900 px-2.5 py-1 text-xs text-red-300 hover:bg-red-950"
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy} className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
            {part ? "Save" : "Add part"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The running list of parts detached, filterable by kind, with a box to tick
 * each one off at reassembly and an editor for every field.
 */
export function PartsPanel({ guide, onChange, onToggle }: { guide: Guide; onChange: (g: Guide) => void; onToggle: (p: Part, refitted: boolean) => void }) {
  const [filter, setFilter] = useState<PartKind | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const visible = guide.parts.filter((p) => !filter || p.kind === filter);
  const counts = KINDS.map((k) => ({ kind: k, lines: guide.parts.filter((p) => p.kind === k) })).filter((c) => c.lines.length);
  const hardwarePieces = guide.parts.filter((p) => p.kind === "hardware").reduce((n, p) => n + p.qty, 0);
  const bagCount = new Set(guide.parts.filter((p) => p.kind === "hardware").map((p) => p.stepN ?? 0)).size;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setFilter(null)}
          aria-pressed={filter === null}
          className={`rounded-lg px-3 py-1 text-xs ${filter === null ? "bg-slate-200 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
        >
          All {guide.parts.length}
        </button>
        {counts.map((c) => (
          <button
            key={c.kind}
            type="button"
            onClick={() => setFilter(c.kind)}
            aria-pressed={filter === c.kind}
            className={`rounded-lg px-3 py-1 text-xs ${filter === c.kind ? "bg-slate-200 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
          >
            {KIND_LABEL[c.kind]} {c.lines.length}
          </button>
        ))}
      </div>
      {hardwarePieces > 0 && (
        <p className="text-xs text-slate-500">
          {hardwarePieces} piece{hardwarePieces === 1 ? "" : "s"} of hardware in {bagCount} bag{bagCount === 1 ? "" : "s"}, one per step.
        </p>
      )}

      {guide.parts.length === 0 && editing !== "new" && (
        <p className="text-sm text-slate-500">No parts listed yet. Add them as they come off, or let the narration list them.</p>
      )}

      <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900">
        {visible.map((p) =>
          editing === p.id ? (
            <li key={p.id} className="p-2">
              <PartEditor guide={guide} part={p} onCancel={() => setEditing(null)} onSaved={(g) => (onChange(g), setEditing(null))} />
            </li>
          ) : (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                checked={p.reassembledAt !== null}
                onChange={(e) => onToggle(p, e.target.checked)}
                aria-label={`${p.name} refitted`}
                className="h-4 w-4 shrink-0 accent-emerald-500"
              />
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${p.reassembledAt ? "text-slate-500 line-through" : "text-slate-100"}`}>
                  <span className="font-mono text-slate-400">{p.qty}×</span> {p.name}
                </p>
                <p className="text-xs text-slate-500">
                  {[p.stepN ? `Step ${p.stepN}` : "No step", p.note, p.heardAs ? `heard as "${p.heardAs}"` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${KIND_TONE[p.kind]}`}>{p.kind}</span>
              <button type="button" onClick={() => setEditing(p.id)} aria-label={`Edit ${p.name}`} className="shrink-0 text-slate-400 hover:text-slate-100">
                <PencilIcon className="h-4 w-4" />
              </button>
            </li>
          ),
        )}
      </ul>

      {editing === "new" ? (
        <PartEditor guide={guide} part={null} onCancel={() => setEditing(null)} onSaved={(g) => (onChange(g), setEditing(null))} />
      ) : (
        <button type="button" onClick={() => setEditing("new")} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
          Add a part
        </button>
      )}
    </div>
  );
}
