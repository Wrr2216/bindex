/**
 * T21: AI bulk capture. Walkthroughs of rooms, desk surveys and paper
 * inventories become a reviewed draft list, then items. Documented in
 * docs/bulk-capture.md.
 */
export {
  addDraft,
  addSource,
  analyse,
  commitSession,
  createSession,
  deleteSession,
  getSessionDetail,
  listSessions,
  mergeDrafts,
  removeSource,
  retrySource,
  splitDraft,
  updateDraft,
  updateSession,
  updateSource,
  type CommitOptions,
  type CreateSessionInput,
  type DraftInput,
  type SessionView,
} from "./sessions";
export { getBulkCaptureSettings, saveBulkCaptureSettings, MAX_IMAGE_CAP, type BulkCaptureSettings } from "./settings";
export { mediaTools } from "./media";
