import { loadConfig, PushoverClient, type PushoverPriority } from "@loganmct/lm-observability";
import { env } from "../env";

export type Notification = {
  title: string;
  message: string;
  priority?: PushoverPriority;
};

/** Best-effort alerts; either destination can operate without the other. */
export async function notify(n: Notification): Promise<boolean> {
  const config = loadConfig({ appName: env.APP_NAME });
  const client = new PushoverClient(config.pushover, config.appName);
  const result = await client.deliver(n);
  return result.pushover || result.wazuh;
}
