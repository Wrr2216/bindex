import { createSocket } from "node:dgram";
import { createConnection } from "node:net";
import { hostname } from "node:os";

export type WazuhAlert = {
  app: string;
  title: string;
  message: string;
  /** Pushover-style priority: 1 and above is an error, below 0 is informational. */
  priority: number;
};

/**
 * One syslog line: an RFC 3164 envelope tagged `mct-alert` around a JSON
 * payload. The manager's shared mct-alert decoder and rules match this exact
 * shape, so keep it stable.
 */
export function formatAlert(event: WazuhAlert, date = new Date()): string {
  const severity = event.priority >= 1 ? 3 : event.priority < 0 ? 6 : 5;
  const stamp = `${date.toUTCString().slice(8, 11)} ${String(date.getUTCDate()).padStart(2, " ")} ${date.toISOString().slice(11, 19)}`;
  const host = hostname().replace(/[^A-Za-z0-9_.-]/g, "_");
  return `<${128 + severity}>${stamp} ${host} mct-alert: ${JSON.stringify({
    ...event,
    app: event.app.slice(0, 128),
    title: Array.from(event.title).slice(0, 250).join(""),
    message: Array.from(event.message).slice(0, 1024).join(""),
    event: "notification",
    ts: date.toISOString(),
  })}`;
}

// Failures go straight to stderr: the logger forwards its warnings here, so
// reporting through it could loop.
function reportFailure(reason: string): void {
  process.stderr.write(`${new Date().toISOString()} WARN  alerts.wazuh.failed reason=${reason}\n`);
}

/**
 * Best-effort delivery to a Wazuh manager, bounded to 3 seconds. Settings are
 * read at send time: WAZUH_HOST (empty disables it), WAZUH_PORT (514),
 * WAZUH_PROTOCOL (tcp or udp) and WAZUH_ENABLED ("false" disables it).
 */
export async function sendWazuh(event: WazuhAlert): Promise<boolean> {
  const host = process.env.WAZUH_HOST?.trim();
  if (!host || process.env.WAZUH_ENABLED === "false") return false;
  const port = Number(process.env.WAZUH_PORT || "514");
  const protocol = process.env.WAZUH_PROTOCOL || "tcp";
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !["tcp", "udp", "tcp4", "udp4"].includes(protocol)) {
    reportFailure("invalid_port_or_protocol");
    return false;
  }

  const payload = formatAlert(event);
  return new Promise((resolve) => {
    const udp = protocol.startsWith("udp") ? createSocket("udp4") : undefined;
    const tcp = udp ? undefined : createConnection({ host, port });
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (udp) {
        try {
          udp.close();
        } catch {
          // The socket was never bound.
        }
      }
      tcp?.destroy();
      if (!ok) reportFailure("delivery");
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 3000);
    if (udp) {
      udp.on("error", () => finish(false));
      udp.send(payload, port, host, (err) => finish(!err));
    } else if (tcp) {
      tcp.on("error", () => finish(false));
      tcp.on("connect", () => tcp.end(`${payload}\n`, () => finish(true)));
    }
  });
}
