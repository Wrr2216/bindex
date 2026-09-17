import { sendWazuh } from "@loganmct/lm-observability";
import { env } from "../env";

type Meta = Record<string, unknown>;
type Level = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug: (event: string, meta?: Meta) => void;
  info: (event: string, meta?: Meta) => void;
  warn: (event: string, meta?: Meta) => void;
  error: (event: string, meta?: Meta) => void;
};

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = RANK[env.LOG_LEVEL];

/**
 * Values are logged as-is where they are already scalar, and shortened where
 * they are not, so a stray object graph cannot flood the log.
 */
function render(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value) ?? "null";
  return json.length > 400 ? `${json.slice(0, 397)}...` : json;
}

function emit(level: Level, event: string, meta?: Meta): void {
  if (RANK[level] < threshold) return;
  if (level === "warn" || level === "error") {
    void sendWazuh({ app: env.APP_NAME, title: `${env.APP_NAME}: ${level}`,
      message: event, priority: level === "error" ? 1 : 0 });
  }
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;

  if (env.LOG_FORMAT === "json") {
    stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...meta })}\n`);
    return;
  }

  const pairs = Object.entries(meta ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${render(v)}`)
    .join(" ");
  stream.write(
    `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${event}${pairs ? ` ${pairs}` : ""}\n`,
  );
}

/**
 * Event-style structured logger. The first argument is a stable dotted event
 * name rather than a sentence, so logs stay greppable across releases; anything
 * variable belongs in the metadata object.
 */
export const logger: Logger = {
  debug: (event, meta) => emit("debug", event, meta),
  info: (event, meta) => emit("info", event, meta),
  warn: (event, meta) => emit("warn", event, meta),
  error: (event, meta) => emit("error", event, meta),
};
