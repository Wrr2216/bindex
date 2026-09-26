/**
 * Documents: templates, the custom field library, packets and filled-in
 * documents. Other features import from here, not from the files behind it.
 * docs/documents.md describes each function and the extension points.
 */

import "./hooks";

export * from "./model";
export { mergeKeys, resolveMerge, formatValue, lookup, MERGE_CATALOG, type MergeContext, type Formatting } from "./merge";
export {
  evaluateConditions,
  evaluateRule,
  conditionsSchema,
  readConditions,
  isUnconditional,
  RULE_OPS,
  RULE_FIELDS,
  type PacketConditions,
  type PacketJob,
  type Rule,
  type Evaluation,
} from "./conditions";
export {
  registerTableSource,
  tableSources,
  tableSource,
  columnLabel,
  MAX_TABLE_ROWS,
  type TableSource,
  type TableRow,
  type TableData,
  type Terms,
} from "./sources";
export { buildRenderModel, type RenderModel, type RenderBlock, type Snapshot } from "./layout";
export { documentContent, documentContentHash, signingContent } from "./content";
export { applyValuesPatch, copyValues, missingRequired, isSignatureValue, type Values, type SignatureValue } from "./values";
export { renderDocumentPdf } from "./pdf";
export { listCustomFields, createCustomField, updateCustomField, deleteCustomField, type CustomFieldInput } from "./fields";
export {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  publishTemplate,
  discardDraft,
  deleteTemplate,
  getVersionByNumber,
  latestPublished,
  type TemplateInput,
} from "./templates";
export {
  listPackets,
  getPacket,
  createPacket,
  updatePacket,
  deletePacket,
  syncJobPackets,
  attachPacket,
  detachPacket,
  applyPacketToOpenJobs,
  testConditions,
  jobDocuments,
  type PacketInput,
  type SyncResult,
} from "./packets";
export {
  listDocuments,
  getDocumentDetail,
  createDocument,
  saveValues,
  copyFrom,
  copySources,
  duplicateDocument,
  completeDocument,
  reopenDocument,
  attachSignature,
  verifyDocument,
  deleteDocument,
  renderModel,
  formatting,
  instanceTerms,
  type DocumentFilters,
  type VerifyReport,
} from "./documents";
export { documentPdf, verifyPdf, pdfFilename, type PdfCheck } from "./exports";
export { mergeContext, sampleMergeContext, tableData, todayIn } from "./context";
export { registerDocumentShareProvider, shareAvailability, shareDocument, type DocumentShareProvider } from "./share";
export { DOCUMENTS_TABLES, DOCUMENTS_DATE_FIELDS, exportDocumentsTables, restoreDocumentsTables } from "./backup";
export type { Actor } from "./shared";
