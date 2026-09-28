/**
 * Valuation, high-value declarations, receipts, warranty and service (T19).
 * Documented in docs/valuation.md. Importing this module registers the
 * feature's event types and attachment owners.
 */
import "./events";

export { estimateValue, listValuations, recordValuation, type EstimateResult, type RecordValuationInput, type Valuation } from "./valuations";
export {
  createServicePlan,
  deleteServicePlan,
  getProfile,
  listServicePlans,
  listServiceRecords,
  logService,
  updateServicePlan,
  upsertProfile,
  type ProfilePatch,
} from "./profiles";
export {
  confirmReceipt,
  createReceipt,
  deleteReceipt,
  getReceipt,
  listReceipts,
  readReceipt,
  receiptMatches,
  receiptsForItem,
  updateReceipt,
  type ConfirmLine,
  type ReceiptLineInput,
  type ReceiptPatch,
} from "./receipts";
export {
  addDeclarationLines,
  createDeclaration,
  declarationContent,
  deleteDeclaration,
  getDeclaration,
  listDeclarations,
  markDeclarationSigned,
  removeDeclarationLine,
  updateDeclaration,
  updateDeclarationLine,
  verifyDeclaration,
  type CreateDeclarationInput,
} from "./declarations";
export { declarationPdf } from "./declarationPdf";
export { buildReport, type ReportOptions } from "./report";
export { reportPdf } from "./reportPdf";
export { reportXlsx } from "./reportXlsx";
export { listDue, runDigest, startValuationDigest } from "./digest";
export { getItemValuation, getOverview } from "./summary";
export { getValuationSettings, updateValuationSettings, type ValuationSettings } from "./settings";
export { pdfReadingAvailable } from "./pdfImages";
