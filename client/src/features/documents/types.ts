import type { Signature } from "../media-ai-core";

/** Shapes returned by /api/documents and friends. Mirrors services/documents on the server. */

export type FieldType = "text" | "number" | "date" | "checkbox" | "select" | "signature" | "initials";
export type DocumentStatus = "draft" | "completed" | "signed";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  multiline?: boolean;
  placeholder?: string;
  help?: string;
  statement?: string;
  min?: number;
  max?: number;
  libraryId?: string;
}

export interface TableFilter {
  floor?: string;
  department?: string;
  stage?: string;
}

export type Block =
  | { id: string; type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "field"; field: FieldDef }
  | { id: string; type: "table"; source: string; columns: string[]; title?: string; filter?: TableFilter; emptyText?: string }
  | { id: string; type: "divider" };

export type BlockType = Block["type"];

export interface SignatureValue {
  signatureId: string;
  signerName: string;
  signerRole?: string | null;
  signedAt: string;
}

export type RenderBlock =
  | { id: string; type: "heading"; level: 1 | 2 | 3; text: string }
  | { id: string; type: "paragraph"; text: string }
  | {
      id: string;
      type: "field";
      field: FieldDef;
      value: unknown;
      display: string;
      filled: boolean;
      signature: SignatureValue | null;
    }
  | {
      id: string;
      type: "table";
      title: string | null;
      columns: { key: string; label: string }[];
      rows: string[][];
      total: number;
      truncated: boolean;
      emptyText: string;
    }
  | { id: string; type: "divider" };

export interface RenderModel {
  title: string;
  blocks: RenderBlock[];
  unknown: string[];
}

export interface BodyProblem {
  blockId: string | null;
  message: string;
}

export interface DocumentRow {
  id: string;
  templateId: string;
  templateVersionId: string;
  jobId: string | null;
  packetId: string | null;
  position: number;
  title: string;
  status: DocumentStatus;
  values: Record<string, unknown>;
  contentHash: string | null;
  copiedFrom: string | null;
  completedAt: string | null;
  completedBy: string | null;
  signedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentExport {
  id: string;
  documentId: string;
  sha256: string;
  contentHash: string;
  status: DocumentStatus;
  sizeBytes: number;
  attachmentId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface DocumentDetail {
  document: DocumentRow;
  template: { id: string; name: string; latestVersion: number | null };
  version: { id: string; version: number; title: string; body: Block[] };
  job: { id: string; code: string; name: string; status: string } | null;
  packet: { id: string; name: string } | null;
  render: RenderModel;
  signatures: Signature[];
  /** What each signature field signs, once the document is completed. */
  signing: Record<string, { statement: string; content: unknown }> | null;
  exports: DocumentExport[];
}

export interface DocumentSummary {
  id: string;
  title: string;
  status: DocumentStatus;
  templateId: string;
  templateName: string;
  version: number;
  jobId: string | null;
  jobCode: string | null;
  jobName: string | null;
  packetId: string | null;
  packetName: string | null;
  position: number;
  contentHash: string | null;
  filledCount: number;
  completedAt: string | null;
  signedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CopySource {
  id: string;
  title: string;
  status: DocumentStatus;
  templateId: string;
  templateName: string;
  jobCode: string | null;
  jobName: string | null;
  updatedAt: string;
  shared: number;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  latestVersion: number | null;
  publishedVersion: number | null;
  hasDraft: boolean;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateVersion {
  id: string;
  templateId: string;
  version: number;
  status: "draft" | "published";
  title: string;
  body: Block[];
  publishedAt: string | null;
  publishedBy: string | null;
  updatedAt: string;
}

export interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  draft: TemplateVersion | null;
  published: TemplateVersion | null;
  editing: TemplateVersion | null;
  versions: {
    id: string;
    version: number;
    status: "draft" | "published";
    title: string;
    publishedAt: string | null;
    publishedBy: string | null;
    updatedAt: string;
    documentCount: number;
  }[];
  problems: BodyProblem[];
}

export type RuleOp =
  | "equals"
  | "not_equals"
  | "in"
  | "not_in"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "exists"
  | "not_exists"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export interface Rule {
  field: string;
  op: RuleOp;
  value?: string | number | boolean | string[];
}

export interface PacketConditions {
  jobTypeIds?: string[];
  projectIds?: string[];
  phaseIds?: string[];
  siteLocationIds?: string[];
  siteSide?: "either" | "origin" | "destination";
  rules?: Rule[];
  ruleMatch?: "all" | "any";
}

export interface Packet {
  id: string;
  name: string;
  description: string | null;
  conditions: PacketConditions;
  autoAttach: boolean;
  active: boolean;
  templates: { id: string; name: string; active: boolean; publishedVersion: number | null }[];
  jobCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PacketOptions {
  jobTypes: { id: string; name: string; color: string; active: boolean }[];
  projects: { id: string; code: string; name: string; phases: { id: string; name: string }[] }[];
  ruleFields: { key: string; label: string }[];
  ruleOps: RuleOp[];
}

export interface Evaluation {
  matches: boolean;
  checks: { kind: string; ok: boolean; detail: string }[];
}

export interface CustomField {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  config: Record<string, unknown>;
  active: boolean;
  definition: FieldDef;
}

export interface TableSourceInfo {
  name: string;
  label: string;
  columns: { key: string; label: string }[];
  defaultColumns: string[];
  filters: (keyof TableFilter)[];
}

export interface DocumentsMeta {
  fieldTypes: FieldType[];
  blockTypes: BlockType[];
  statuses: DocumentStatus[];
  tableSources: TableSourceInfo[];
  mergeFields: { key: string; label: string }[];
  share: { available: boolean; provider: string | null };
  jobs: boolean;
}

export interface JobPick {
  id: string;
  code: string;
  name: string;
  status: string;
  jobTypeName: string | null;
}

export interface JobDocuments {
  job: { id: string; code: string; name: string; status: string; jobTypeId: string | null };
  packets: { packetId: string; name: string; auto: boolean; applies: boolean; attachedAt: string }[];
  documents: DocumentSummary[];
}

export interface SyncResult {
  attached: { packetId: string; name: string; documents: number; unpublished: string[] }[];
  withdrawn: { packetId: string; name: string; removed: number; kept: number }[];
}

export interface VerifyReport {
  documentId: string;
  status: DocumentStatus;
  valid: boolean;
  content: { storedHash: string | null; currentHash: string | null; matches: boolean };
  signatures: { field: string; label: string; signatureId: string; signerName: string; valid: boolean; reason: string }[];
}

export interface PdfCheck {
  sha256: string;
  found: boolean;
  exports: { id: string; documentId: string; title: string; status: DocumentStatus; contentHash: string; createdAt: string }[];
  document: (VerifyReport & { title: string; exportedContentStillCurrent: boolean }) | null;
}
