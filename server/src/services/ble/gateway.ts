import { getConfig } from "../config";
import type { GatewayPayload } from "./adapters";
import { findOrCreateGateway } from "./devices";
import { processGatewayReport, type BleIngestResult } from "./ingest";

/**
 * A report that names its gateway rather than arriving with the gateway's own
 * token: MQTT messages. Dropped while the feature is off; an unknown gateway
 * is registered on first report, as the tracking core does for readers.
 */
export async function handleGatewayReport(
  gatewayExternalId: string,
  payload: GatewayPayload,
): Promise<BleIngestResult | null> {
  if (!(await getConfig()).features.ble) return null;
  const gateway = await findOrCreateGateway(gatewayExternalId);
  if (gateway.disabled) return null;
  return processGatewayReport(gateway, payload);
}
