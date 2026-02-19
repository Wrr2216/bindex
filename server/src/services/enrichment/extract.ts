/**
 * Pull a JSON object out of a chat reply, which may arrive fenced in a code
 * block or bare. Returns null when there is nothing parseable, so a chatty
 * model produces a miss rather than an exception.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A trimmed string, or undefined when the value is empty or not a string. */
export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
