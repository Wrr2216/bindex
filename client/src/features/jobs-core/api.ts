import { req } from "../../api/client";
import type {
  AddByCodesResult,
  AdvanceResult,
  CsvImportResult,
  GroupBy,
  HistoryEntry,
  JobDetail,
  JobStatus,
  JobSummary,
  JobType,
  JobsMeta,
  LineFields,
  ManifestPage,
  Phase,
  Project,
  ProjectDetail,
  ProjectStatus,
  Shipment,
  ShipmentDetail,
  ShipmentStatus,
  Task,
  TaskStatus,
  TemplateStep,
} from "./types";

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;

export type JobInput = {
  name: string;
  projectId?: string | null;
  phaseId?: string | null;
  jobTypeId?: string | null;
  status?: JobStatus;
  originLocationId?: string | null;
  destinationLocationId?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  notes?: string | null;
};

export type ProjectInput = {
  name: string;
  companyId?: string | null;
  entityId?: string | null;
  status?: ProjectStatus;
  startsOn?: string | null;
  endsOn?: string | null;
  notes?: string | null;
};

export type PhaseInput = {
  name: string;
  sequence?: number;
  startsOn?: string | null;
  endsOn?: string | null;
  notes?: string | null;
};

export type ShipmentInput = {
  name: string;
  vehicleLocationId?: string | null;
  carrier?: string | null;
  sealNumbers?: string[];
  weightKg?: number | null;
  volumeM3?: number | null;
  distanceKm?: number | null;
  eta?: string | null;
  notes?: string | null;
};

export type TaskInput = {
  title: string;
  kind?: string;
  status?: TaskStatus;
  assigneeEntityId?: string | null;
  dueAt?: string | null;
  notes?: string | null;
};

export type StageRequest = {
  stage: string;
  shipmentId?: string | null;
  via?: string;
  deviceId?: string | null;
  force?: boolean;
  note?: string | null;
};

export type DocumentOptions = {
  groupBy?: GroupBy;
  shipmentId?: string;
  floor?: string;
  department?: string;
  stage?: string;
};

export const jobsApi = {
  meta: () => req<JobsMeta>("/api/jobs/meta"),

  // Job types
  listJobTypes: (all = false) => req<JobType[]>(`/api/job-types${all ? "?all=true" : ""}`),
  createJobType: (input: { name: string; color?: string; description?: string | null; taskTemplate?: TemplateStep[]; active?: boolean }) =>
    req<JobType>("/api/job-types", json("POST", input)),
  updateJobType: (id: string, patch: Partial<Omit<JobType, "id" | "settings" | "createdAt" | "updatedAt">>) =>
    req<JobType>(`/api/job-types/${id}`, json("PATCH", patch)),
  deleteJobType: (id: string) => req<void>(`/api/job-types/${id}`, { method: "DELETE" }),

  // Projects
  listProjects: (params: { status?: ProjectStatus; q?: string } = {}) =>
    req<Project[]>(`/api/projects${query(params)}`),
  getProject: (id: string) => req<ProjectDetail>(`/api/projects/${id}`),
  createProject: (input: ProjectInput) => req<Project>("/api/projects", json("POST", input)),
  updateProject: (id: string, patch: Partial<ProjectInput>) => req<Project>(`/api/projects/${id}`, json("PATCH", patch)),
  deleteProject: (id: string) => req<void>(`/api/projects/${id}`, { method: "DELETE" }),
  addPhase: (projectId: string, input: PhaseInput) =>
    req<Phase>(`/api/projects/${projectId}/phases`, json("POST", input)),
  updatePhase: (projectId: string, phaseId: string, patch: Partial<PhaseInput>) =>
    req<Phase>(`/api/projects/${projectId}/phases/${phaseId}`, json("PATCH", patch)),
  deletePhase: (projectId: string, phaseId: string) =>
    req<void>(`/api/projects/${projectId}/phases/${phaseId}`, { method: "DELETE" }),

  // Jobs
  listJobs: (params: { projectId?: string; status?: JobStatus; q?: string } = {}) =>
    req<JobSummary[]>(`/api/jobs${query(params)}`),
  getJob: (id: string) => req<JobDetail>(`/api/jobs/${id}`),
  createJob: (input: JobInput & { seedTasks?: boolean }) => req<JobSummary>("/api/jobs", json("POST", input)),
  updateJob: (id: string, patch: Partial<JobInput>) => req<JobSummary>(`/api/jobs/${id}`, json("PATCH", patch)),
  deleteJob: (id: string) => req<void>(`/api/jobs/${id}`, { method: "DELETE" }),

  addTask: (jobId: string, input: TaskInput) => req<Task>(`/api/jobs/${jobId}/tasks`, json("POST", input)),
  updateTask: (jobId: string, taskId: string, patch: Partial<TaskInput>) =>
    req<Task>(`/api/jobs/${jobId}/tasks/${taskId}`, json("PATCH", patch)),
  deleteTask: (jobId: string, taskId: string) =>
    req<void>(`/api/jobs/${jobId}/tasks/${taskId}`, { method: "DELETE" }),

  // Manifest
  listLines: (
    jobId: string,
    filters: { stage?: string; shipmentId?: string; floor?: string; department?: string; q?: string } = {},
  ) => req<ManifestPage>(`/api/jobs/${jobId}/items${query(filters)}`),
  addByCodes: (jobId: string, codes: string[], fields: LineFields = {}) =>
    req<AddByCodesResult>(`/api/jobs/${jobId}/items`, json("POST", { codes, ...fields })),
  addFromLocation: (
    jobId: string,
    input: LineFields & {
      locationId: string;
      includeContents?: boolean;
      perUnit?: boolean;
      departmentLevel?: number | null;
      floorLevel?: number | null;
    },
  ) =>
    req<{ added: number; alreadyOnJob: number; found: number }>(
      `/api/jobs/${jobId}/items/from-location`,
      json("POST", input),
    ),
  importCsv: (jobId: string, csv: string, addMissing = true) =>
    req<CsvImportResult>(`/api/jobs/${jobId}/items/import`, json("POST", { csv, addMissing })),
  updateLines: (jobId: string, ids: string[], set: LineFields) =>
    req<{ updated: number }>(`/api/jobs/${jobId}/items`, json("PATCH", { ids, set })),
  removeLines: (jobId: string, ids: string[]) =>
    req<{ removed: number }>(`/api/jobs/${jobId}/items/remove`, json("POST", { ids })),
  setLineStage: (jobId: string, ids: string[], body: StageRequest) =>
    req<AdvanceResult>(`/api/jobs/${jobId}/items/stage`, json("POST", { ids, ...body })),
  advance: (jobId: string, codes: string[], body: StageRequest) =>
    req<AdvanceResult>(`/api/jobs/${jobId}/advance`, json("POST", { codes, ...body })),
  history: (jobId: string, limit = 50) => req<HistoryEntry[]>(`/api/jobs/${jobId}/history?limit=${limit}`),

  manifestPdfUrl: (jobId: string, opts: DocumentOptions = {}) =>
    `/api/jobs/${jobId}/manifest.pdf${query({ ...opts, tz: tz() })}`,
  manifestXlsxUrl: (jobId: string, opts: DocumentOptions = {}) =>
    `/api/jobs/${jobId}/manifest.xlsx${query({ ...opts })}`,

  // Shipments
  getShipment: (id: string) => req<ShipmentDetail>(`/api/shipments/${id}`),
  createShipment: (jobId: string, input: ShipmentInput) =>
    req<Shipment>("/api/shipments", json("POST", { jobId, ...input })),
  updateShipment: (id: string, patch: Partial<ShipmentInput>) =>
    req<Shipment>(`/api/shipments/${id}`, json("PATCH", patch)),
  setShipmentStatus: (id: string, status: ShipmentStatus, force?: boolean, reason?: string | null) =>
    req<Shipment>(`/api/shipments/${id}/status`, json("POST", { status, force, reason })),
  deleteShipment: (id: string) => req<void>(`/api/shipments/${id}`, { method: "DELETE" }),
  loadSheetUrl: (id: string) => `/api/shipments/${id}/load-sheet.pdf${query({ tz: tz() })}`,
};
