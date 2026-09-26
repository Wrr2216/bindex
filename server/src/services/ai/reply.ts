import { extractJson } from "../enrichment/extract";

/**
 * Pure parsers for what OpenAI-compatible endpoints send back. Kept apart from
 * the HTTP code so the awkward replies real providers produce can be tested
 * with fixtures.
 */

type ContentPart = { type?: unknown; text?: unknown };

/** The assistant text of a chat/completions reply, whether a string or content parts. */
export function replyText(data: unknown): string {
  const choice = (data as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: ContentPart) => (typeof p?.text === "string" && (p.type === undefined || p.type === "text" || p.type === "output_text") ? p.text : ""))
      .join("");
  }
  return "";
}

/**
 * The single JSON object in a chat reply, or null. An array, a bare string, a
 * refusal or a reply cut off mid-object all come back as null.
 */
export function parseChatReply(data: unknown): Record<string, unknown> | null {
  const parsed = extractJson(replyText(data));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

export type TranscriptSegment = { start: number; end: number; text: string };
export type Transcript = {
  text: string;
  /** Timestamped pieces in seconds. Empty when the provider sent none. */
  segments: TranscriptSegment[];
  language?: string;
  durationSec?: number;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * An /audio/transcriptions reply in verbose_json (or plain json) form. Drops
 * segments with missing or backwards timestamps rather than trusting them.
 */
export function parseTranscription(data: unknown): Transcript | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as { text?: unknown; segments?: unknown; language?: unknown; duration?: unknown };
  const segments: TranscriptSegment[] = [];
  if (Array.isArray(d.segments)) {
    for (const s of d.segments as { start?: unknown; end?: unknown; text?: unknown }[]) {
      const start = num(s?.start);
      const end = num(s?.end);
      const text = typeof s?.text === "string" ? s.text.trim() : "";
      if (start === null || end === null || end < start || !text) continue;
      segments.push({ start, end, text });
    }
  }
  let text = typeof d.text === "string" ? d.text.trim() : "";
  if (!text && segments.length) text = segments.map((s) => s.text).join(" ");
  if (!text) return null;
  const out: Transcript = { text, segments };
  if (typeof d.language === "string" && d.language) out.language = d.language;
  const duration = num(d.duration);
  if (duration !== null) out.durationSec = duration;
  return out;
}
