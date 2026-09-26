import { CloseIcon } from "../../components/icons";
import type { Defect } from "./types";
import { DEFECT_LABEL, DEFECT_TYPES, SEVERITIES, SEVERITY_LABEL } from "./vocab";

const INPUT =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none";

/** The defect list of a report: where, what, how bad, and a few words. */
export function DefectEditor({ defects, onChange, highlight = false }: { defects: Defect[]; onChange: (d: Defect[]) => void; highlight?: boolean }) {
  const set = (i: number, patch: Partial<Defect>) => onChange(defects.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <div className="space-y-2">
      {defects.length === 0 && <p className="text-sm text-slate-500">No defects recorded.</p>}
      {defects.map((d, i) => (
        <div
          key={i}
          className={`grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-[1.4fr_1fr_1fr_2fr_auto] ${
            highlight ? "border-sky-800 bg-sky-950/30" : "border-slate-800 bg-slate-800/40"
          }`}
        >
          <input
            value={d.area}
            onChange={(e) => set(i, { area: e.target.value })}
            placeholder="Where (lid, front left leg)"
            aria-label="Where"
            maxLength={80}
            className={`${INPUT} col-span-2 sm:col-span-1`}
          />
          <select value={d.type} onChange={(e) => set(i, { type: e.target.value as Defect["type"] })} aria-label="Type" className={INPUT}>
            {DEFECT_TYPES.map((t) => (
              <option key={t} value={t}>
                {DEFECT_LABEL[t]}
              </option>
            ))}
          </select>
          <select
            value={d.severity}
            onChange={(e) => set(i, { severity: e.target.value as Defect["severity"] })}
            aria-label="Severity"
            className={INPUT}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
          <input
            value={d.description ?? ""}
            onChange={(e) => set(i, { description: e.target.value || null })}
            placeholder="What it looks like"
            aria-label="Description"
            maxLength={300}
            className={`${INPUT} col-span-2 sm:col-span-1`}
          />
          <button
            type="button"
            onClick={() => onChange(defects.filter((_, j) => j !== i))}
            aria-label="Remove defect"
            className="justify-self-end text-slate-500 hover:text-red-400 sm:self-center"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...defects, { area: "", type: "scratch", severity: "minor", description: null }])}
        className="rounded-lg border border-dashed border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
      >
        Add a defect
      </button>
    </div>
  );
}

/** A read-only defect list, with an optional marker per defect. */
export function DefectList({ defects, mark }: { defects: Defect[]; mark?: (d: Defect, i: number) => { label: string; tone: string } | null }) {
  if (!defects.length) return <p className="text-sm text-slate-500">No defects recorded.</p>;
  return (
    <ul className="space-y-1">
      {defects.map((d, i) => {
        const m = mark?.(d, i);
        return (
          <li key={i} className={`rounded-lg px-2 py-1 text-sm ${m ? m.tone : "bg-slate-800/50 text-slate-300"}`}>
            {m && <span className="mr-1.5 text-[10px] font-bold uppercase tracking-wide">{m.label}</span>}
            <span className="font-medium">{DEFECT_LABEL[d.type]}</span>
            <span className="text-slate-400"> · {SEVERITY_LABEL[d.severity].toLowerCase()} · </span>
            {d.area}
            {d.description && <span className="text-slate-400">: {d.description}</span>}
          </li>
        );
      })}
    </ul>
  );
}
