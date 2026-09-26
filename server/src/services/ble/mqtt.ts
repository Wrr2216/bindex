import { randomBytes } from "node:crypto";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { parseGatewayPayload, type GatewayFormat, type GatewayPayload } from "./adapters";
import { handleGatewayReport } from "./gateway";

/**
 * Optional MQTT subscription for gateways that publish rather than POST
 * (Minew and Ingics gateways both can). Off unless BLE_MQTT_URL is set, and
 * the mqtt package is only loaded then.
 *
 * Each message is one gateway report in any supported format (detected, or
 * fixed with BLE_MQTT_FORMAT). The gateway is named by the payload when it
 * says (Minew's Gateway entry, Ingics' gateway MAC, a Teltonika IMEI), else by
 * the topic segment matched by the first + in BLE_MQTT_TOPIC, so with the
 * default "bindex/ble/+" a gateway publishing to bindex/ble/AC233FC04EAB is
 * the gateway with that MAC. An unknown gateway is registered the first time
 * it reports, with no zone.
 */

/** The part of an MQTT client this module uses; the mqtt package's client fits it. */
export interface MqttClientLike {
  on(event: "connect", cb: () => void): unknown;
  on(event: "message", cb: (topic: string, payload: Buffer) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  subscribe(topics: string[], opts: { qos: 0 | 1 }, cb?: (err: Error | null) => void): unknown;
  end(force?: boolean): unknown;
}

export type MqttConnect = (url: string, opts: Record<string, unknown>) => MqttClientLike;

/** What to do with a parsed report; ingest in production, a stub in tests. */
export type MqttReportHandler = (gatewayExternalId: string, payload: GatewayPayload) => Promise<unknown>;

export type MqttStatus = {
  configured: boolean;
  connected: boolean;
  url: string | null;
  topics: string[];
  messages: number;
  rejected: number;
  lastMessageAt: string | null;
  lastError: string | null;
};

const status: MqttStatus = {
  configured: false,
  connected: false,
  url: null,
  topics: [],
  messages: 0,
  rejected: 0,
  lastMessageAt: null,
  lastError: null,
};

export const mqttStatus = (): MqttStatus => ({ ...status, topics: [...status.topics] });

/** The broker URL without its password, for status and logs. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]*):[^@/]*@/, "//$1:****@");
}

export const topicList = (value: string): string[] =>
  value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * Whether `topic` matches an MQTT filter, and the segment under its first +
 * when it has one. # matches the rest of the topic, + one level.
 */
export function matchTopic(filter: string, topic: string): { match: boolean; gateway: string | null } {
  const f = filter.split("/");
  const t = topic.split("/");
  let gateway: string | null = null;
  for (let i = 0; i < f.length; i++) {
    const part = f[i]!;
    if (part === "#") return { match: true, gateway };
    if (i >= t.length) return { match: false, gateway: null };
    if (part === "+") {
      gateway ??= t[i] || null;
      continue;
    }
    if (part !== t[i]) return { match: false, gateway: null };
  }
  return f.length === t.length ? { match: true, gateway } : { match: false, gateway: null };
}

/** Parse one message and name its gateway. Throws when either is impossible. */
export function readMessage(
  topic: string,
  message: Buffer | string,
  filters: string[],
  format: GatewayFormat | "auto",
): { gatewayId: string; payload: GatewayPayload } {
  const text = typeof message === "string" ? message : message.toString("utf8");
  const payload = parseGatewayPayload(text, format);
  let fromTopic: string | null = null;
  for (const f of filters) {
    const m = matchTopic(f, topic);
    if (m.match && m.gateway) {
      fromTopic = m.gateway;
      break;
    }
  }
  const gatewayId = payload.gatewayId ?? fromTopic;
  if (!gatewayId) {
    throw new Error(`No gateway named in the message or the topic "${topic}". Put a + in BLE_MQTT_TOPIC where the gateway id is.`);
  }
  return { gatewayId, payload };
}

/** More queued messages than this and new ones are dropped until it drains. */
const MAX_PENDING = 1000;

export type BleMqttHandle = { client: MqttClientLike; stop: () => void };

/**
 * Connect and subscribe. Resolves to null when MQTT is not configured, or the
 * mqtt package cannot be loaded; neither stops the server.
 */
export async function startBleMqtt(
  opts: {
    url?: string;
    topics?: string[];
    format?: GatewayFormat | "auto";
    connect?: MqttConnect;
    handle?: MqttReportHandler;
  } = {},
): Promise<BleMqttHandle | null> {
  const url = opts.url ?? env.BLE_MQTT_URL.trim();
  if (!url) return null;
  const topics = opts.topics ?? topicList(env.BLE_MQTT_TOPIC);
  const format = opts.format ?? env.BLE_MQTT_FORMAT;
  status.configured = true;
  status.url = redactUrl(url);
  status.topics = topics;

  let connect = opts.connect;
  if (!connect) {
    try {
      const mod = (await import("mqtt")) as unknown as { connect?: MqttConnect; default?: { connect?: MqttConnect } };
      connect = mod.connect ?? mod.default?.connect;
    } catch (err) {
      status.lastError = `The mqtt package could not be loaded: ${describeError(err)}`;
    }
    if (!connect) {
      logger.warn("ble.mqtt.unavailable", { err: status.lastError });
      return null;
    }
  }
  const handle = opts.handle ?? handleGatewayReport;

  const client = connect(url, {
    clientId: `bindex-ble-${randomBytes(4).toString("hex")}`,
    username: env.BLE_MQTT_USERNAME || undefined,
    password: env.BLE_MQTT_PASSWORD || undefined,
    reconnectPeriod: 5_000,
    connectTimeout: 10_000,
  });

  let pending = 0;
  let chain: Promise<unknown> = Promise.resolve();
  client.on("connect", () => {
    status.connected = true;
    status.lastError = null;
    client.subscribe(topics, { qos: 0 }, (err) => {
      if (err) {
        status.lastError = describeError(err);
        logger.warn("ble.mqtt.subscribe_failed", { topics, err: status.lastError });
      } else {
        logger.info("ble.mqtt.subscribed", { url: status.url, topics });
      }
    });
  });
  client.on("close", () => {
    status.connected = false;
  });
  client.on("error", (err) => {
    status.lastError = describeError(err);
    logger.warn("ble.mqtt.error", { url: status.url, err: status.lastError });
  });
  client.on("message", (topic, message) => {
    status.messages += 1;
    status.lastMessageAt = new Date().toISOString();
    if (pending >= MAX_PENDING) {
      status.rejected += 1;
      return;
    }
    pending += 1;
    // In arrival order, one at a time, so a gateway's reports are judged in sequence.
    chain = chain
      .then(async () => {
        const { gatewayId, payload } = readMessage(topic, message, topics, format);
        await handle(gatewayId, payload);
      })
      .catch((err) => {
        status.rejected += 1;
        logger.warn("ble.mqtt.message_rejected", { topic, err: describeError(err) });
      })
      .finally(() => {
        pending -= 1;
      });
  });

  return {
    client,
    stop: () => {
      client.end(true);
      status.connected = false;
    },
  };
}
