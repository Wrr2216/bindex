import { useConfig } from "../../config/useConfig";
import type { AiAvailability } from "./types";

/**
 * Which AI providers this instance has, from the configuration loaded at
 * start-up. Hide an AI button when its provider is missing rather than showing
 * one that can only fail.
 */
export function useAiAvailability(): AiAvailability {
  const integrations = useConfig().config.integrations as { languageModel: boolean } & Partial<
    Pick<AiAvailability, "vision" | "transcription">
  >;
  return {
    languageModel: Boolean(integrations.languageModel),
    vision: Boolean(integrations.vision),
    transcription: Boolean(integrations.transcription),
  };
}
