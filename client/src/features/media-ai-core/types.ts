/**
 * Types for attachments, signatures and AI capture. Mirrors the server's
 * services/media-ai-core; see docs/media-ai-core.md.
 */

export type AttachmentKind = "photo" | "video" | "audio" | "document" | "signature";

export interface Attachment {
  id: string;
  ownerType: string;
  ownerId: string;
  kind: AttachmentKind;
  /** Free text such as before, after, pack, delivery, label. Always lowercase. */
  stage: string | null;
  caption: string | null;
  mime: string;
  sizeBytes: number;
  sha256: string;
  storage: "db" | "disk";
  width: number | null;
  height: number | null;
  durationMs: number | null;
  meta: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  /** Streams the file, with Range support. */
  url: string;
  /** A small JPEG preview; photos only. */
  thumbUrl: string | null;
}

export interface Signature {
  id: string;
  ownerType: string;
  ownerId: string;
  signerName: string;
  signerEmail: string | null;
  signerRole: string | null;
  statement: string;
  contentHash: string;
  attachmentId: string | null;
  signedAt: string;
  ip: string | null;
  userAgent: string | null;
  signedByUser: string | null;
  imageUrl: string | null;
}

export interface VerifyResult {
  valid: boolean;
  reason: "ok" | "content_changed" | "image_missing" | "image_altered";
  signedHash: string;
  currentHash: string;
  signedAt: string;
}

export interface AiAvailability {
  /** A chat model is configured (text only). */
  languageModel: boolean;
  /** A model that reads photos is configured. */
  vision: boolean;
  /** Speech to text is configured. */
  transcription: boolean;
}

export type DataPlateField =
  | "brand"
  | "model"
  | "serial"
  | "partNumber"
  | "assetTag"
  | "mac"
  | "manufactureDate"
  | "voltage"
  | "amperage"
  | "wattage"
  | "frequency";

export interface DataPlateReading {
  brand: string | null;
  model: string | null;
  serial: string | null;
  partNumber: string | null;
  assetTag: string | null;
  mac: string | null;
  manufactureDate: string | null;
  ratings: { voltage: string | null; amperage: string | null; wattage: string | null; frequency: string | null };
  otherIdentifiers: { label: string; value: string }[];
  confidence: Record<DataPlateField, number>;
  rawText: string;
}

export interface TakenBy {
  itemId: string;
  itemName: string;
  unitId: string | null;
}

export interface DataPlateResult {
  /** False when no vision model is configured. */
  available: boolean;
  found: boolean;
  reading: DataPlateReading | null;
  /** Identifiers read that already belong to something else. */
  taken: { serial: TakenBy | null; mac: TakenBy | null; assetTag: TakenBy | null } | null;
  /** Confidence below this deserves a second look. */
  lowConfidence: number;
  message?: string;
}

/** The fields of a reading that can be saved onto an item or unit. */
export interface DataPlateAccepted {
  brand?: string | null;
  model?: string | null;
  serial?: string | null;
  mac?: string | null;
  assetTag?: string | null;
  partNumber?: string | null;
}
