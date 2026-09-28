import { env } from "../env";
import { logger } from "./logger";
import { sendWazuh } from "./wazuh";

export type PushoverPriority = "min" | "low" | "default" | "high" | "max";

export type Notification = {
  title: string;
  message: string;
  priority?: PushoverPriority;
};

// Pushover's numeric priorities, from -2 (lowest) to 2 (emergency).
const PRIORITY: Record<PushoverPriority, number> = { min: -2, low: -1, default: 0, high: 1, max: 2 };

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

/** The first `max` characters, counting an emoji as one. */
function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/**
 * Settings are read at send time: PUSHOVER_TOKEN and PUSHOVER_USER (both
 * required), PUSHOVER_DEVICE (optional) and PUSHOVER_ENABLED ("false"
 * disables it).
 */
async function sendPushover(n: Notification, priority: number): Promise<boolean> {
  const token = process.env.PUSHOVER_TOKEN ?? "";
  const user = process.env.PUSHOVER_USER ?? "";
  if (process.env.PUSHOVER_ENABLED === "false" || !token || !user) return false;

  const body: Record<string, unknown> = {
    token,
    user,
    title: clip(n.title, 250),
    message: clip(n.message, 1024),
    priority,
  };
  if (process.env.PUSHOVER_DEVICE) body.device = process.env.PUSHOVER_DEVICE;
  if (priority === 2) {
    // Emergency priority must say how to re-alert: every 60 s for up to an
    // hour, until someone acknowledges it.
    body.retry = 60;
    body.expire = 3600;
  }

  try {
    const res = await fetch(PUSHOVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const result = (await res.json().catch(() => ({}))) as { status?: number };
    if (res.ok && result.status === 1) return true;
    logger.warn("notify.pushover.failed", { status: res.status });
    return false;
  } catch (err) {
    logger.warn("notify.pushover.failed", { error: err });
    return false;
  }
}

/** Best-effort alerts; either destination can operate without the other. */
export async function notify(n: Notification): Promise<boolean> {
  const priority = PRIORITY[n.priority ?? "default"];
  const [wazuh, pushover] = await Promise.all([
    sendWazuh({ app: env.APP_NAME, title: n.title, message: n.message, priority }),
    sendPushover(n, priority),
  ]);
  return pushover || wazuh;
}
