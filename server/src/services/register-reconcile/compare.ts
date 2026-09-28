import type { ReconcileClass } from "../../db/tables/register-reconcile";
import { CLASS_ORDER } from "./classify";

/**
 * What changed between two reconciliation runs: which discrepancies were
 * cleared, which are new, and which moved from one class to another. Results
 * are paired by the asset they are about, or by the register key when nothing
 * here matched, so two runs of different uploads of the same register still
 * line up.
 */

export type CompareInput = {
  /** Stable identity: the asset, else the register's key for the row. */
  key: string;
  label: string;
  classes: ReconcileClass[];
  ignored: boolean;
};

export type CompareEntry = { key: string; label: string; before: ReconcileClass[]; after: ReconcileClass[] };

export type RunComparison = {
  counts: Record<ReconcileClass, { before: number; after: number }>;
  cleared: CompareEntry[];
  appeared: CompareEntry[];
  changed: CompareEntry[];
  unchanged: number;
};

const issues = (classes: ReconcileClass[]) => classes.filter((c) => c !== "matched");

export function compareRuns(before: CompareInput[], after: CompareInput[]): RunComparison {
  const counts = Object.fromEntries(CLASS_ORDER.map((c) => [c, { before: 0, after: 0 }])) as RunComparison["counts"];
  for (const r of before) for (const c of r.classes) counts[c].before++;
  for (const r of after) for (const c of r.classes) counts[c].after++;

  // An ignored discrepancy is one a person has decided is not a discrepancy.
  const open = (r: CompareInput | undefined) => (r && !r.ignored ? issues(r.classes) : []);
  const a = new Map(before.map((r) => [r.key, r]));
  const b = new Map(after.map((r) => [r.key, r]));

  const cleared: CompareEntry[] = [];
  const appeared: CompareEntry[] = [];
  const changed: CompareEntry[] = [];
  let unchanged = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    const was = open(x);
    const now = open(y);
    const entry = { key, label: (y ?? x)!.label, before: x?.classes ?? [], after: y?.classes ?? [] };
    if (was.length && !now.length) cleared.push(entry);
    else if (!was.length && now.length) appeared.push(entry);
    else if (was.join() !== now.join()) changed.push(entry);
    else unchanged++;
  }
  const byLabel = (p: CompareEntry, q: CompareEntry) => p.label.localeCompare(q.label);
  return {
    counts,
    cleared: cleared.sort(byLabel),
    appeared: appeared.sort(byLabel),
    changed: changed.sort(byLabel),
    unchanged,
  };
}
