import { useMemo, useState } from "react";

export type Option = { id: string; name: string };

const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";

/**
 * A select with a "new" option built in, so a missing location or person can be
 * created and chosen without abandoning the form you were filling in.
 */
export function CreatableSelect({
  label,
  value,
  onChange,
  options,
  onCreate,
  placeholder = "None",
  createLabel = "+ New…",
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  options: Option[];
  onCreate: (name: string) => Promise<Option>;
  placeholder?: string;
  createLabel?: string;
}) {
  const [extra, setExtra] = useState<Option[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const all = useMemo(() => {
    const ids = new Set(options.map((o) => o.id));
    return [...options, ...extra.filter((e) => !ids.has(e.id))];
  }, [options, extra]);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await onCreate(n);
      setExtra((x) => [...x, created]);
      onChange(created.id);
      setCreating(false);
      setName("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </label>
      {creating ? (
        <div className="flex gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
            placeholder={`New ${label.toLowerCase()} name`}
            className={FIELD}
          />
          <button
            type="button"
            onClick={create}
            disabled={busy || !name.trim()}
            className="shrink-0 rounded-lg bg-sky-600 px-3 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setName("");
              setErr(null);
            }}
            className="shrink-0 rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      ) : (
        <select
          value={value}
          onChange={(e) => (e.target.value === "__new" ? setCreating(true) : onChange(e.target.value))}
          className={FIELD}
        >
          <option value="">{placeholder}</option>
          {all.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          <option value="__new">{createLabel}</option>
        </select>
      )}
      {err && <p className="mt-1 text-xs text-red-400">{err}</p>}
    </div>
  );
}
