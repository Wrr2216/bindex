import { badRequest, notFound } from "../../lib/errors";
import { diffDefects, ratingChange, type DefectDiff } from "./diff";
import { getReport, type ConditionReport } from "./reports";

/**
 * AI container capture and condition records. Other features import from
 * here; docs/ai-condition.md describes the contract.
 *
 * - handlingNoteFor(itemIds) / handlingNotesForRefs(refs): the handling line
 *   for manifests (T03) and placement cards (T11).
 * - listReports / getReport: condition history, for claims (T16) and
 *   inspections (T13).
 */
export { handlingNoteFor, handlingNotesForRefs, handlingText, type HandlingNote, type HandlingRef } from "./handling";
export {
  createReport,
  deleteReport,
  getReport,
  insertReport,
  listReports,
  updateReport,
  type ConditionReport,
  type ReportInput,
  type ReportPatch,
} from "./reports";
export { getCapture, listCaptures, saveCapture, type CaptureInput, type ContainerCapture } from "./containers";
export { closeSweep, getSweep, getSweepDetail, listSweeps, resolveSweepScan, startSweep, type Sweep } from "./sweeps";
export { assessCondition, compareReportsWithAi, readContainer } from "./vision";
export { getConditionSettings, updateConditionSettings, defaultConditionSettings, type ConditionSettings } from "./settings";
export { diffDefects, ratingChange, type DefectDiff } from "./diff";

export type Comparison = {
  before: ConditionReport;
  after: ConditionReport;
  diff: DefectDiff;
  rating: "worse" | "better" | "same" | null;
};

/** The deterministic comparison of two reports of one item. */
export async function compareReports(beforeId: string, afterId: string): Promise<Comparison> {
  const [before, after] = await Promise.all([getReport(beforeId), getReport(afterId)]);
  if (!before || !after) throw notFound("One of those condition reports no longer exists.");
  if (before.itemId !== after.itemId) throw badRequest("Compare two reports of the same item.");
  return {
    before,
    after,
    diff: diffDefects(before.defects, after.defects),
    rating: ratingChange(before.rating, after.rating),
  };
}
