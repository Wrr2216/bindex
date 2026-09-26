import { checkSize } from "../../tracking/adapters/common";
import { finiteOrNull, parseTimestamp } from "../../tracking/normalize";
import { formatMac } from "../advert";
import { AdapterError, isRecord, type GatewayPayload, type RawAdvert } from "./common";

const EXAMPLE = "$GPRP,C4BE84E7EC3E,E1C8BC3DFF84,-58,02010612FF590080BC360100D8C101,1540879478";

/** Report types that carry one advertiser each. */
const REPORTS = new Set(["$GPRP", "$SRRP", "$LRRP", "$LRSR"]);

/**
 * Ingics iGS gateways (iGS01, iGS02, iGS03) posting their text report format:
 * one advertisement per line,
 *
 *   $GPRP,<tag MAC>,<gateway MAC>,<RSSI>,<advertising data hex>[,<unix time>]
 *
 * $GPRP is an advertisement, $SRRP a scan response, $LRRP and $LRSR the same
 * for long-range (coded PHY) reports. The time is only present when the
 * gateway's timestamp option is on. Accepts a text body, a JSON array of
 * lines, or a form whose values hold the lines.
 *
 * Built from Ingics' published iGS message format; not yet verified on
 * hardware.
 */
export function parseIngics(body: unknown): GatewayPayload {
  const text = textOf(body);
  if (!text.trim()) throw new AdapterError(`Empty body. Expected Ingics report lines such as ${EXAMPLE}`);
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  checkSize(lines.length);

  const out: GatewayPayload = { adverts: [], skipped: 0 };
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim());
    if (!REPORTS.has(parts[0]!.toUpperCase())) {
      out.skipped += 1;
      continue;
    }
    const [, tagMac, gatewayMac, rssi, data, ts] = parts;
    if (!tagMac || !formatMac(tagMac)) {
      out.skipped += 1;
      continue;
    }
    if (gatewayMac && formatMac(gatewayMac)) out.gatewayId ??= formatMac(gatewayMac)!;
    const advert: RawAdvert = {
      mac: tagMac,
      rssi: finiteOrNull(rssi),
      data: data && /^[0-9a-f]+$/i.test(data) && data.length % 2 === 0 ? data : null,
      at: ts ? parseTimestamp(ts) : null,
    };
    out.adverts.push(advert);
  }
  if (!out.adverts.length && out.skipped === lines.length && !lines.some((l) => l.startsWith("$"))) {
    throw new AdapterError(`No Ingics report lines found. Expected lines such as ${EXAMPLE}`);
  }
  return out;
}

function textOf(body: unknown): string {
  if (typeof body === "string") return body;
  if (Array.isArray(body)) return body.filter((l): l is string => typeof l === "string").join("\n");
  if (isRecord(body)) {
    // A form post: the lines are in whichever field the gateway was told to use.
    return Object.values(body)
      .filter((v): v is string => typeof v === "string")
      .join("\n");
  }
  return "";
}
