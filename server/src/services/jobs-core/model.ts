import type { JobStatus, JobTaskStatus, ProjectStatus, ShipmentStatus } from "../../db/schema";

/**
 * The vocabulary of jobs: stages a manifest line moves through, kinds of task,
 * and the lifecycle of projects, jobs and shipments.
 *
 * The lifecycles are fixed (and CHECKed in the database). Stages and task kinds
 * are open: the core set is here, and a later feature adds its own with
 * `registerExceptionStage` or `registerTaskKind` when its module loads. Nothing
 * here touches the database, so it is safe to import from anywhere.
 */

/**
 * The ladder every line climbs, in order. A line may skip rungs (scanning
 * straight to "loaded" implies it was packed) but never climbs down without
 * being forced.
 */
export const PROGRESS_STAGES = ["pending", "packed", "loaded", "delivered", "placed"] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

/** Something went wrong with the line. Reachable from any stage, and left by scanning it onward. */
export const CORE_EXCEPTION_STAGES = ["missing", "wrong_shipment", "damaged"] as const;
export type CoreExceptionStage = (typeof CORE_EXCEPTION_STAGES)[number];

/**
 * A stage name. The core names autocomplete; a registered exception stage is
 * any other string, which `isStage` checks at runtime.
 */
export type JobItemStage = ProgressStage | CoreExceptionStage | (string & {});

export type StageInfo = {
  name: string;
  label: string;
  kind: "progress" | "exception";
  /** Tailwind-free hex, so the PDF and the client can both use it. */
  color: string;
};

const PROGRESS_INFO: Record<ProgressStage, Omit<StageInfo, "name" | "kind">> = {
  pending: { label: "Pending", color: "#64748b" },
  packed: { label: "Packed", color: "#0ea5e9" },
  loaded: { label: "Loaded", color: "#6366f1" },
  delivered: { label: "Delivered", color: "#a855f7" },
  placed: { label: "Placed", color: "#10b981" },
};

// Stage names must fit the database CHECK on job_items.stage.
const STAGE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

const exceptionStages = new Map<string, StageInfo>([
  ["missing", { name: "missing", label: "Missing", kind: "exception", color: "#f59e0b" }],
  ["wrong_shipment", { name: "wrong_shipment", label: "Wrong shipment", kind: "exception", color: "#ef4444" }],
  ["damaged", { name: "damaged", label: "Damaged", kind: "exception", color: "#dc2626" }],
]);

/**
 * Add an exception stage, such as "refused" for a delivery sign-off. Only
 * exception stages can be added: the progress ladder is what progress bars and
 * shipment rules are built on, so it stays fixed. Registering the same name
 * twice updates its label and colour.
 */
export function registerExceptionStage(name: string, info: { label: string; color?: string }): void {
  if (!STAGE_NAME.test(name)) {
    throw new Error(`Stage name "${name}" must be lower_snake_case, at most 32 characters.`);
  }
  if ((PROGRESS_STAGES as readonly string[]).includes(name)) {
    throw new Error(`"${name}" is a progress stage and cannot be registered as an exception.`);
  }
  exceptionStages.set(name, { name, kind: "exception", label: info.label, color: info.color ?? "#f97316" });
}

export const isProgressStage = (stage: string): stage is ProgressStage =>
  (PROGRESS_STAGES as readonly string[]).includes(stage);

export const isExceptionStage = (stage: string): boolean => exceptionStages.has(stage);

export const isStage = (stage: string): boolean => isProgressStage(stage) || isExceptionStage(stage);

/** Every stage, progress first and in order, then exceptions in registration order. */
export function stageList(): StageInfo[] {
  return [
    ...PROGRESS_STAGES.map((name) => ({ name, kind: "progress" as const, ...PROGRESS_INFO[name] })),
    ...exceptionStages.values(),
  ];
}

export function stageLabel(stage: string): string {
  if (isProgressStage(stage)) return PROGRESS_INFO[stage].label;
  return exceptionStages.get(stage)?.label ?? stage;
}

// --- Task kinds --------------------------------------------------------------

export const CORE_TASK_KINDS = [
  "pre_inspection",
  "pack",
  "load",
  "transit",
  "unload",
  "place",
  "post_inspection",
  "custom",
] as const;
export type CoreTaskKind = (typeof CORE_TASK_KINDS)[number];
export type TaskKind = CoreTaskKind | (string & {});

export type TaskKindInfo = {
  kind: string;
  label: string;
  /**
   * The stage whose progress drives this task: it starts when the first line
   * reaches the stage and is done when every line has.
   */
  stage: ProgressStage | null;
};

const TASK_KIND = /^[a-z][a-z0-9_]{0,39}$/;

const taskKinds = new Map<string, TaskKindInfo>([
  ["pre_inspection", { kind: "pre_inspection", label: "Pre-inspection", stage: null }],
  ["pack", { kind: "pack", label: "Pack", stage: "packed" }],
  ["load", { kind: "load", label: "Load", stage: "loaded" }],
  ["transit", { kind: "transit", label: "Transit", stage: null }],
  ["unload", { kind: "unload", label: "Unload", stage: "delivered" }],
  ["place", { kind: "place", label: "Place", stage: "placed" }],
  ["post_inspection", { kind: "post_inspection", label: "Post-inspection", stage: null }],
  ["custom", { kind: "custom", label: "Custom", stage: null }],
]);

/**
 * Add a task kind a later feature attaches its work to ("crew_checkin",
 * "document_packet"). It then appears in job type templates and task pickers.
 */
export function registerTaskKind(kind: string, info: { label: string }): void {
  if (!TASK_KIND.test(kind)) {
    throw new Error(`Task kind "${kind}" must be lower_snake_case, at most 40 characters.`);
  }
  const existing = taskKinds.get(kind);
  taskKinds.set(kind, { kind, label: info.label, stage: existing?.stage ?? null });
}

export const isTaskKind = (kind: string): boolean => taskKinds.has(kind);
export const taskKindList = (): TaskKindInfo[] => [...taskKinds.values()];
export const taskKindsForStage = (stage: string): string[] =>
  [...taskKinds.values()].filter((k) => k.stage === stage).map((k) => k.kind);

// --- Lifecycles ----------------------------------------------------------------

export const PROJECT_STATUSES = [
  "planned",
  "active",
  "on_hold",
  "completed",
  "cancelled",
] as const satisfies readonly ProjectStatus[];
export const JOB_STATUSES = ["planned", "in_progress", "completed", "cancelled"] as const satisfies readonly JobStatus[];
export const TASK_STATUSES = ["todo", "doing", "done", "skipped"] as const satisfies readonly JobTaskStatus[];
export const SHIPMENT_STATUSES = [
  "planned",
  "staged",
  "loaded",
  "in_transit",
  "delivered",
  "closed",
] as const satisfies readonly ShipmentStatus[];

/** Jobs that still accept scans and manifest changes. */
export const OPEN_JOB_STATUSES: readonly JobStatus[] = ["planned", "in_progress"];

/**
 * How a stage change was made. Free-form beyond these, as long as it is
 * lower_snake_case (a portal contribution might say "portal").
 */
export const CORE_VIA = ["scan", "rfid", "manual", "api", "csv"] as const;
export type StageVia = (typeof CORE_VIA)[number] | (string & {});
export const VIA_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
