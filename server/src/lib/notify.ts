import { env } from "../env";
import { logger } from "./logger";

export type Notification = {
  title: string;
  message: string;
  /** ntfy priority, 1 (min) to 5 (max). Defaults to the server default of 3. */
  priority?: number;
  /** ntfy tag names, rendered as emoji or plain text by the client. */
  tags?: string[];
};

/**
 * Push a notification to an ntfy topic. Background jobs use this to report
 * things nobody is watching a screen for, such as the domain expiry digest.
 * Delivery is best effort: a failure is logged and swallowed so the caller
 * never fails because a notification did not go out.
 *
 * Unconfigured (no NTFY_URL/NTFY_TOPIC) is a supported state, not an error.
 */
export async function notify(n: Notification): Promise<boolean> {
  if (!env.ntfyConfigured) return false;

  const url = `${env.NTFY_URL.replace(/\/+$/, "")}/${env.NTFY_TOPIC}`;
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: n.title,
  };
  if (n.priority) headers.Priority = String(n.priority);
  if (n.tags?.length) headers.Tags = n.tags.join(",");
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;

  try {
    const res = await fetch(url, { method: "POST", headers, body: n.message });
    if (!res.ok) {
      logger.warn("notify.http_error", { status: res.status, topic: env.NTFY_TOPIC });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("notify.fetch_error", { err: String(err) });
    return false;
  }
}
