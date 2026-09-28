import { env } from "../../env";

/**
 * Shared AI helpers. Every one returns null rather than throwing when the
 * provider is missing, slow, down or talking nonsense; see
 * docs/media-ai-core.md for the contract.
 */
export { visionJson, type VisionImage, type VisionOptions } from "./vision";
export { transcribe, type TranscribeInput, type Transcript } from "./transcribe";
export { parseChatReply, parseTranscription, replyText, type TranscriptSegment } from "./reply";
export { chatJson } from "../enrichment/model";

/** What is configured, for gating a feature's AI buttons on the server side. */
export function aiAvailability(): { languageModel: boolean; vision: boolean; transcription: boolean } {
  return {
    languageModel: env.llmConfigured,
    vision: env.llmVisionConfigured,
    transcription: env.sttConfigured,
  };
}
