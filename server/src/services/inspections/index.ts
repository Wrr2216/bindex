import { env } from "../../env";
import { logger } from "../../lib/logger";
import { getAttachment, readAttachmentBytes, thumbnail } from "../media-ai-core";
import { matchWithAi, readDamage, type DamageSuggestion } from "./ai";
import { knownRooms, loadInspection, storeAiPairs } from "./inspections";
import { renderInspectionPdf, type ReportImage } from "./pdf";
import { buildReport } from "./report";
import { badRequest } from "../../lib/errors";

/**
 * Pre- and post-move facility inspections: the public surface. Other features
 * (a portal, claims) import from here. docs/inspections.md has the details.
 */

export * from "./model";
export {
  compareFindings,
  normalizeRoom,
  sameRoom,
  textSimilarity,
  unmatched,
  CHANGE_KINDS,
  type ChangeKind,
  type Comparison,
  type ComparisonEntry,
  type MatchSource,
  type PairingFinding,
} from "./pairing";
export {
  normalizeDamageReading,
  normalizeAiMatches,
  normalizeSpot,
  normalizeSeverity,
  normalizeArea,
  matchKnownRoom,
  MATCH_MIN_CONFIDENCE,
  type DamageSuggestion,
  type KnownRoom,
  type AiMatch,
} from "./ai";
export { buildSignContent, CONTENT_FORMAT, type SignContent } from "./content";
export {
  listInspections,
  getInspectionDetail,
  loadInspection,
  createInspection,
  updateInspection,
  deleteInspection,
  completeInspection,
  reopenInspection,
  listFindings,
  addFinding,
  updateFinding,
  removeFinding,
  setPairing,
  getComparison,
  signRequest,
  signContentFor,
  signaturesOf,
  recordSignoff,
  knownRooms,
  findPreFor,
  genInspectionCode,
  type InspectionActor,
  type InspectionInput,
  type FindingInput,
  type InspectionFilters,
  type FindingView,
  type SignatureView,
} from "./inspections";
export { buildReport, reportFileIds, reportFileIdsFor, groupByRoom, type InspectionReport } from "./report";
export { renderInspectionPdf, formatWhen, type ReportImage, type ImageLoader } from "./pdf";
export { renderShareHtml, renderShareProblem } from "./html";
export {
  listShares,
  createShare,
  revokeShare,
  openShare,
  signShareToken,
  readShareToken,
  shareKey,
  sharePath,
  SHARE_DEFAULT_DAYS,
  SHARE_MAX_DAYS,
  type ShareLink,
} from "./share";
export { exportInspectionTables, restoreInspectionTables, INSPECTION_TABLES } from "./backup";

/** A photo or signature as the PDF can embed it; null for formats it cannot. */
export async function loadReportImage(id: string): Promise<ReportImage | null> {
  const a = await getAttachment(id);
  if (!a || !a.mime.startsWith("image/")) return null;
  if (a.kind === "signature" && (a.mime === "image/png" || a.mime === "image/jpeg")) {
    const { bytes } = await readAttachmentBytes(id, 2 * 1024 * 1024);
    return { kind: a.mime === "image/png" ? "png" : "jpg", bytes };
  }
  // Redrawn smaller: a report with forty phone photos at full size would run
  // to hundreds of megabytes.
  const small = await thumbnail(id, 1000);
  return small ? { kind: "jpg", bytes: small.bytes } : null;
}

export async function inspectionPdf(id: string, tz: string): Promise<{ pdf: Buffer; filename: string }> {
  const report = await buildReport(id);
  const pdf = await renderInspectionPdf(report, loadReportImage, tz);
  return { pdf, filename: `${report.code}-${report.kind}-inspection.pdf` };
}

/**
 * "Add damage by AI": read one of the inspection's photos and suggest a
 * finding. Saves nothing. `available` is false when no vision model is
 * configured; `suggestion` is null when the model could not help.
 */
export async function suggestFinding(
  inspectionId: string,
  attachmentId: string,
  userOid: string | null,
): Promise<{ available: boolean; suggestion: DamageSuggestion | null; message?: string }> {
  const inspection = await loadInspection(inspectionId);
  const a = await getAttachment(attachmentId);
  if (!a || a.ownerType !== "inspection" || a.ownerId !== inspection.id) {
    throw badRequest("That photo is not one of this inspection's files. Upload it to the inspection first.");
  }
  if (a.kind !== "photo") throw badRequest("Only a photo can be read. Take a picture of the damage.");
  if (!env.llmVisionConfigured) return { available: false, suggestion: null };
  const { bytes } = await readAttachmentBytes(attachmentId, 25 * 1024 * 1024);
  const suggestion = await readDamage(
    { mime: a.mime, bytes },
    {
      kind: inspection.kind,
      siteName: inspection.siteName,
      knownRooms: await knownRooms(inspection),
      context: { inspectionId, attachmentId, user: userOid },
    },
  );
  logger.info("inspections.ai.read", { inspectionId, found: Boolean(suggestion?.damage) });
  if (!suggestion) {
    return { available: true, suggestion: null, message: "The photo could not be read. Fill the finding in by hand." };
  }
  return {
    available: true,
    suggestion,
    ...(suggestion.damage ? {} : { message: "No damage was seen in this photo. Check it, or describe it by hand." }),
  };
}

/** Ask a language model to pair what the room-and-spot rule could not. */
export async function matchUnpairedWithAi(inspectionId: string) {
  if (!env.llmConfigured) return { available: false, considered: { pre: 0, post: 0 }, paired: 0 };
  return storeAiPairs(inspectionId, (pre, post) => matchWithAi(pre, post, { inspectionId }));
}
