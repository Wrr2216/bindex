/**
 * The stable API other features build on. Import from here, not from the
 * individual files, so internals can move. Documented in docs/media-ai-core.md.
 */
export {
  ATTACHMENT_KINDS,
  deleteAttachment,
  deleteAttachmentsForOwner,
  getAttachment,
  getAttachmentStream,
  listAttachments,
  readAttachmentBytes,
  saveAttachment,
  setAsPrimaryPhoto,
  thumbnail,
  updateAttachment,
  type Attachment,
  type AttachmentKind,
  type AttachmentStream,
  type ListAttachmentsOptions,
  type SaveAttachmentInput,
} from "./attachments";
export { registerOwnerType, isOwnerType, type OwnerExists, type OwnerOptions } from "./owners";
export {
  getSignature,
  getSignedContent,
  listSignatures,
  sign,
  verifySignature,
  type Signature,
  type SignInput,
  type VerifyResult,
} from "./signatures";
export { canonicalJson, contentHash } from "./canonical";
export { detectMime } from "./magic";
export { parseRange, type ByteRange } from "./range";
export { renderJpeg } from "./imaging";
export { startAttachmentSweeper, sweepOrphans } from "./sweeper";
