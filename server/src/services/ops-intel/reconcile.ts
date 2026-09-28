import type { RuleId } from "./model";
import type { Finding } from "./rules";

/**
 * Turns one run's findings into changes to the anomaly table, given the rows
 * already there. Pure, so the lifecycle below is tested without a database.
 *
 * - A finding with an open row refreshes it (latest detail, last seen). For a
 *   sticky rule, a newer occurrence also counts one more.
 * - A condition someone dismissed stays dismissed while it keeps being found.
 *   Once a run no longer finds it, it is marked cleared, and if it comes back
 *   later it is reported afresh.
 * - A condition marked fixed that is found again opens a new row pointing at
 *   the old one: it was not fixed.
 * - A sticky finding (an event) opens a new row only when it happened after
 *   the latest row for it; an event already reported is not reported twice.
 * - An open condition a run no longer finds is closed as cleared. Open sticky
 *   rows stay until a person resolves them.
 * - Open rows of a rule that has been switched off are closed as cleared.
 *
 * Only rules that ran successfully touch their rows: a rule whose gather
 * failed leaves its anomalies exactly as they were.
 */

export type ExistingAnomaly = {
  id: string;
  rule: string;
  key: string;
  sticky: boolean;
  occurrences: number;
  occurredAt: Date | null;
  resolvedAt: Date | null;
  resolution: "fixed" | "dismissed" | "cleared" | null;
  clearedAt: Date | null;
};

export type ClearReason = "not_found" | "rule_disabled";

export type ReconcileOps = {
  insert: { finding: Finding; reopenedFrom: string | null }[];
  refresh: { id: string; finding: Finding; occurrences: number; occurredAt: Date | null }[];
  /**
   * Rows found again with nothing new to record (a dismissed condition still
   * there, a sticky event already on file): only their last-seen time moves.
   */
  touch: string[];
  clear: { id: string; rule: string; reason: ClearReason }[];
  /** Dismissed rows whose condition went away. */
  markCleared: string[];
};

export const identity = (rule: string, key: string) => `${rule}\u0000${key}`;

/**
 * The latest row per (rule, key). The caller passes open rows, dismissed rows
 * not yet cleared, and the latest row of every (rule, key) found this run.
 */
function latestByIdentity(rows: ExistingAnomaly[]): Map<string, ExistingAnomaly> {
  const out = new Map<string, ExistingAnomaly>();
  for (const r of rows) {
    const id = identity(r.rule, r.key);
    const prev = out.get(id);
    // An open row always wins: there is at most one, and it is the newest.
    if (!prev || (prev.resolvedAt !== null && r.resolvedAt === null)) out.set(id, r);
  }
  return out;
}

/** One finding per (rule, key); for sticky rules the most recent occurrence. */
function dedupe(findings: Finding[]): Map<string, Finding> {
  const out = new Map<string, Finding>();
  for (const f of findings) {
    const id = identity(f.rule, f.key);
    const prev = out.get(id);
    if (!prev || (f.occurredAt?.getTime() ?? 0) >= (prev.occurredAt?.getTime() ?? 0)) out.set(id, f);
  }
  return out;
}

export function reconcile(input: {
  findings: Finding[];
  existing: ExistingAnomaly[];
  /** Rules that ran without error this time. */
  rulesRun: Iterable<RuleId>;
  /** Rules switched off in settings. */
  rulesDisabled: Iterable<RuleId>;
}): ReconcileOps {
  const ran = new Set<string>(input.rulesRun);
  const disabled = new Set<string>(input.rulesDisabled);
  const latest = latestByIdentity(input.existing);
  const found = dedupe(input.findings.filter((f) => ran.has(f.rule)));
  const ops: ReconcileOps = { insert: [], refresh: [], touch: [], clear: [], markCleared: [] };

  for (const [id, f] of found) {
    const prev = latest.get(id);
    if (!prev) {
      ops.insert.push({ finding: f, reopenedFrom: null });
      continue;
    }
    const newer = f.occurredAt !== null && (prev.occurredAt === null || f.occurredAt.getTime() > prev.occurredAt.getTime());
    if (prev.resolvedAt === null) {
      // The same event seen again inside the look-back window is not news:
      // keep the detail of the occurrence already on file.
      if (prev.sticky && !newer) {
        ops.touch.push(prev.id);
        continue;
      }
      ops.refresh.push({
        id: prev.id,
        finding: f,
        occurrences: prev.occurrences + (prev.sticky ? 1 : 0),
        occurredAt: prev.sticky ? f.occurredAt : prev.occurredAt,
      });
      continue;
    }
    if (f.sticky) {
      // An event is new only if it happened after the one already on file.
      if (newer) ops.insert.push({ finding: f, reopenedFrom: prev.id });
      continue;
    }
    if (prev.resolution === "dismissed" && prev.clearedAt === null) {
      ops.touch.push(prev.id);
      continue;
    }
    ops.insert.push({ finding: f, reopenedFrom: prev.id });
  }

  for (const [id, row] of latest) {
    if (disabled.has(row.rule)) {
      if (row.resolvedAt === null) ops.clear.push({ id: row.id, rule: row.rule, reason: "rule_disabled" });
      continue;
    }
    if (!ran.has(row.rule) || found.has(id) || row.sticky) continue;
    if (row.resolvedAt === null) ops.clear.push({ id: row.id, rule: row.rule, reason: "not_found" });
    else if (row.resolution === "dismissed" && row.clearedAt === null) ops.markCleared.push(row.id);
  }
  return ops;
}
