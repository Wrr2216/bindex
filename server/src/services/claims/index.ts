/**
 * Claims and incident reports. Import from here, not from the files behind
 * it. docs/claims.md describes the workflow, the evidence pack and the API.
 */
import "./owners";
import "./events";

export * from "./model";
export { claimTotals, isLineDecided, lineApprovedCents, normalizeLineDecision, type ClaimTotals, type TotalsLine } from "./totals";
export {
  TRANSITIONS,
  checkTransition,
  computeSla,
  findTransition,
  transitionStamps,
  transitionsFrom,
  type Sla,
  type SlaState,
  type Transition,
  type TransitionCheck,
} from "./workflow";
export { decisionRefusal, type ClaimActor } from "./shared";
export {
  addComment,
  addLines,
  assignClaim,
  claimCandidates,
  createClaim,
  deleteClaim,
  getClaim,
  getEvidence,
  listClaims,
  listReviewers,
  recordExport,
  removeLine,
  resolveLines,
  setStatus,
  slaHoursFor,
  updateClaim,
  updateLine,
  type Candidate,
  type ClaimDetail,
  type ClaimFilters,
  type ClaimInput,
  type ClaimPatch,
  type ClaimSummary,
  type LineInput,
  type LinePatch,
  type StatusInput,
} from "./claims";
export { buildEvidence, type EvidencePack, type LineEvidence } from "./evidence";
export { claimPdf, claimXlsx } from "./documents";
export { portalFileClaim, portalView, type PortalClaimInput, type PortalView } from "./portal";
export { availability, detectShapes, hashPortalToken, type SourceAvailability } from "./sources";
export { checkSlaBreaches, startClaimsSlaWatch } from "./sla";
