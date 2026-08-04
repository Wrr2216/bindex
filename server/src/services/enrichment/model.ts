import { env } from "../../env";
import { logger } from "../../lib/logger";
import { extractJson } from "./extract";

/**
 * Minimal client for an OpenAI-compatible chat endpoint, used by the optional
 * lookup features. Any provider that speaks that protocol works: set
 * LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.
 *
 * Every call asks for one JSON object and returns null on anything that is not
 * one, so callers never have to handle a half-parsed reply. Failures are logged
 * and swallowed: these features are conveniences, and none of them is allowed
 * to fail a request.
 */

type ChatResponse = { choices?: { message?: { content?: string } }[] };

const TIMEOUT_MS = 10_000;

export async function chatJson(opts: {
  /** Event prefix used in the logs, e.g. "enrich.product". */
  event: string;
  system: string;
  user: string;
  maxTokens?: number;
  /** Extra fields for the log line, such as the code being looked up. */
  context?: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  if (!env.llmConfigured) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${env.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        max_tokens: opts.maxTokens ?? 512,
        temperature: 0,
        // The system prompt belongs in the message list. Sending it as a
        // top-level `system` field is a different protocol's shape, and this
        // one silently ignores it.
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn(`${opts.event}.fetch_error`, { ...opts.context, err: String(err) });
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    logger.warn(`${opts.event}.http_error`, { ...opts.context, status: resp.status });
    return null;
  }

  const data = (await resp.json().catch(() => null)) as ChatResponse | null;
  return extractJson(data?.choices?.[0]?.message?.content ?? "");
}
