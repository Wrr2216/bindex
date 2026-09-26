/**
 * Attachments, signatures and AI capture: the shared pieces other features
 * build on. Import from here. Documented in docs/media-ai-core.md.
 */
export { AttachmentGallery, type AttachmentGalleryProps } from "./AttachmentGallery";
export { SignaturePad, strokesToPng } from "./SignaturePad";
export { SignDialog, type SignDialogProps } from "./SignDialog";
export { useAiAvailability } from "./useAiAvailability";
export { Modal } from "./Modal";
export {
  ReadFromLabel,
  applyLabelReview,
  saveLabelPhoto,
  useLabelCapture,
  useLabelCaptureEnabled,
  type LabelDetails,
  type LabelReview,
  type LabelTarget,
} from "./DataPlate";
export { ItemMediaSection, LocationMediaSection } from "./RecordMedia";
export * from "./api";
export type * from "./types";
