import { parseJsonBody } from "../../tracking/adapters/common";
import { AdapterError, arrayIn, isRecord, type GatewayPayload } from "./common";
import { parseBleGeneric } from "./generic";
import { parseIngics } from "./ingics";
import { parseKontakt } from "./kontakt";
import { parseMinew } from "./minew";
import { parseTeltonika } from "./teltonika";

/**
 * BLE gateway payload parsers. Each is a pure function from a request body (or
 * an MQTT message) to a GatewayPayload; see common.ts for the contract.
 */
export {
  AdapterError,
  interpretAdvert,
  type GatewayPayload,
  type Observation,
  type RawAdvert,
} from "./common";
export { parseBleGeneric } from "./generic";
export { parseMinew } from "./minew";
export { parseIngics } from "./ingics";
export { parseKontakt } from "./kontakt";
export { parseTeltonika } from "./teltonika";
export { parsePhone } from "./phone";

export const GATEWAY_FORMATS = ["generic", "minew", "ingics", "kontakt", "teltonika"] as const;
export type GatewayFormat = (typeof GATEWAY_FORMATS)[number];

export const PARSERS: Record<GatewayFormat, (body: unknown) => GatewayPayload> = {
  generic: parseBleGeneric,
  minew: parseMinew,
  ingics: parseIngics,
  kontakt: parseKontakt,
  teltonika: parseTeltonika,
};

/**
 * Which format a payload is in, from its shape. For MQTT, where one broker can
 * carry several makes of gateway and there is no URL to say which.
 */
export function detectFormat(body: unknown): GatewayFormat {
  if (typeof body === "string" && /^\s*\$[A-Z]{4},/m.test(body)) return "ingics";
  let payload: unknown;
  try {
    payload = parseJsonBody(body, "a gateway payload");
  } catch (err) {
    if (err instanceof AdapterError) throw new AdapterError("The message is neither JSON nor Ingics report lines.");
    throw err;
  }
  if (Array.isArray(payload) && payload.every((l) => typeof l === "string")) return "ingics";
  if (isRecord(payload) && (Array.isArray(payload.reads) || Array.isArray(payload.adverts))) return "generic";
  // Vendors wrap their entries under various keys; look at the first entry.
  const entries = arrayIn(payload, ["events", "data", "content", "items", "telemetry", "result", "messages", "records", "devices"]);
  const first = (entries ?? (isRecord(payload) ? [payload] : [])).find(isRecord);
  if (!first) throw new AdapterError("The message holds no gateway entries.");
  if ("trackingId" in first || "uniqueId" in first) return "kontakt";
  if ("ble.beacons" in first || "ident" in first || (isRecord(first.ble) && "beacons" in first.ble)) return "teltonika";
  if ("rawData" in first || ("type" in first && "mac" in first)) return "minew";
  if ("reads" in first || "mac" in first || "data" in first || "code" in first) return "generic";
  throw new AdapterError("Could not tell which gateway format the message is in; set BLE_MQTT_FORMAT.");
}

/** Parse a payload in a named format, or the one it looks like. */
export function parseGatewayPayload(body: unknown, format: GatewayFormat | "auto" = "auto"): GatewayPayload {
  return PARSERS[format === "auto" ? detectFormat(body) : format](body);
}
