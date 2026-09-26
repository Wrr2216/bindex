/**
 * Jobs core: the public surface later features build on. Import from here,
 * not from the files behind it, so those can move without breaking callers.
 * docs/jobs-core.md describes each function and the extension points.
 */

export * from "./model";
export {
  decideStage,
  hasReached,
  stageRank,
  checkShipmentTransition,
  requiredStageFor,
  type StageDecision,
  type ShipmentCheck,
} from "./rules";
export { rollup, rollupCounts, rollupBy, jobProgress, type Progress, type GroupProgress, type RollupLine } from "./rollups";
export { parseCsv, parseManifestCsv, type ManifestCsv, type ManifestCsvRow } from "./csv";
export { planAdvance, uniqueCodes, candidatesFor, type ScanRef, type ScanPlan, type MatchLine } from "./match";
export { resolveScanCodes, parseDeepLink } from "./resolve";
export { genCode, parseCode, CODE_PREFIX, type CodeKind } from "./codes";
export {
  registerStageGuard,
  onStageChanged,
  onShipmentStatusChanged,
  onJobChanged,
  onTaskStatusChanged,
  type ChangeContext,
  type StageGuard,
  type StageGuardContext,
  type StageVeto,
  type StageChange,
  type StageListener,
  type ShipmentStatusEvent,
  type JobEvent,
  type TaskEvent,
} from "./hooks";
export type { Actor } from "./shared";

export {
  listJobTypes,
  getJobType,
  createJobType,
  updateJobType,
  deleteJobType,
  setJobTypeSetting,
  getJobTypeSetting,
  type JobTypeInput,
} from "./jobTypes";
export {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listPhases,
  addPhase,
  updatePhase,
  deletePhase,
  type ProjectInput,
  type PhaseInput,
} from "./projects";
export {
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  setJobMetadata,
  listTasks,
  addTask,
  updateTask,
  deleteTask,
  completeTasksByKind,
  type JobInput,
  type TaskInput,
} from "./jobs";
export {
  listShipments,
  getShipment,
  createShipment,
  updateShipment,
  setShipmentStatus,
  deleteShipment,
  setShipmentMetadata,
  type ShipmentInput,
} from "./shipments";
export {
  listJobItems,
  jobLinesForItem,
  addItemsByCodes,
  addItemsFromLocation,
  importManifestCsv,
  updateJobItems,
  removeJobItems,
  manifestFacets,
  type LineFields,
  type LineFilters,
  type ManifestLine,
  type SubtreeOptions,
  type CsvImportResult,
} from "./manifest";
export {
  advanceStage,
  setLineStage,
  stageHistory,
  lineHistory,
  canMove,
  MAX_BATCH,
  type AdvanceOptions,
  type AdvanceResult,
  type LineOutcome,
  type NotOnJobOutcome,
} from "./advance";
export { getJobProgress, progressByJob, progressByShipment, progressByProject } from "./progress";
export { jobManifestPdf, jobManifestXlsx, shipmentLoadSheetPdf, type GroupBy, type DocumentFilters } from "./documents";
