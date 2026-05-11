import { env } from "../../env";
import { logger } from "../../lib/logger";
import type { DnsZone, RegistrarDomain } from "./types";

/**
 * Cloudflare API client (read-only). Uses a single API token with
 * Zone:Read + (optionally) account Domain Registrar:Read permissions.
 */

const BASE = "https://api.cloudflare.com/client/v4";

type CfEnvelope<T> = {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number };
};

async function cfGet<T>(pathWithQuery: string): Promise<CfEnvelope<T>> {
  const resp = await fetch(`${BASE}${pathWithQuery}`, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, Accept: "application/json" },
  });
  const body = (await resp.json().catch(() => null)) as CfEnvelope<T> | null;
  if (!resp.ok || !body?.success) {
    const detail = body?.errors?.map((e) => e.message).join("; ") || `HTTP ${resp.status}`;
    throw new Error(`Cloudflare GET ${pathWithQuery} failed: ${detail}`);
  }
  return body;
}

type RawZone = { name: string; status: string; name_servers?: string[] };

/** All zones on the token's accounts (paginated). */
export async function getZones(): Promise<DnsZone[]> {
  const out: DnsZone[] = [];
  for (let page = 1; page <= 50; page++) {
    const body = await cfGet<RawZone[]>(`/zones?per_page=50&page=${page}`);
    for (const z of body.result) {
      out.push({ name: z.name.toLowerCase(), nameservers: z.name_servers ?? [] });
    }
    if (!body.result_info || page >= body.result_info.total_pages) break;
  }
  return out;
}

type RawRegistrarDomain = {
  name: string;
  expires_at?: string;
  auto_renew?: boolean;
  current_registrar?: string;
};

/**
 * Domains registered with Cloudflare Registrar, across all accounts the token
 * can see. A token without registrar permission yields an empty list (warned),
 * so a zones-only token still syncs DNS info.
 */
export async function getCloudflareDomains(): Promise<RegistrarDomain[]> {
  const accounts = await cfGet<{ id: string; name: string }[]>(`/accounts?per_page=50`);
  const out: RegistrarDomain[] = [];
  for (const account of accounts.result) {
    let raw: RawRegistrarDomain[];
    try {
      raw = (await cfGet<RawRegistrarDomain[]>(`/accounts/${account.id}/registrar/domains`)).result;
    } catch (err) {
      logger.warn("registrars.cloudflare.domains_failed", { account: account.name, err: String(err) });
      continue;
    }
    for (const d of raw) {
      out.push({
        name: d.name.toLowerCase(),
        registrar: "cloudflare",
        status: d.current_registrar ? "registered" : null,
        expiresAt: d.expires_at ? new Date(d.expires_at) : null,
        autoRenew: d.auto_renew ?? null,
        whoisPrivacy: null,
      });
    }
  }
  return out;
}
