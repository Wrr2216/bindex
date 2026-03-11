import { eq } from "drizzle-orm";
import { env } from "../../env";
import { db } from "../../db/client";
import { ninjaoneTokens, type NinjaoneToken } from "../../db/schema";

/**
 * NinjaOne Public API client using the OAuth2 authorization_code grant.
 *
 * An admin connects once interactively (browser consent, then an authorization code),
 * which we exchange for an access token + refresh token. The refresh token is
 * persisted in `ninjaone_tokens` so unattended syncs can mint fresh access
 * tokens via the refresh_token grant without any further human interaction.
 */

const PROVIDER = "ninjaone";

type AccessCache = { token: string; expiresAt: number };
let cache: AccessCache | null = null;

const base = () => env.NINJAONE_BASE_URL.replace(/\/+$/, "");

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const resp = await fetch(`${base()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.NINJAONE_CLIENT_ID,
      client_secret: env.NINJAONE_CLIENT_SECRET,
      ...params,
    }),
  });
  if (!resp.ok) {
    throw new Error(`NinjaOne token request failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as TokenResponse;
}

/** Persist a token response, preserving the prior refresh token if none is rotated in. */
async function storeTokens(
  data: TokenResponse,
  opts: { connectedBy?: string | null; priorRefresh?: string } = {},
): Promise<void> {
  const refreshToken = data.refresh_token ?? opts.priorRefresh;
  if (!refreshToken) {
    throw new Error(
      "NinjaOne returned no refresh token. Request the offline_access scope.",
    );
  }
  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + data.expires_in * 1000);
  const row = {
    provider: PROVIDER,
    refreshToken,
    accessToken: data.access_token,
    accessExpiresAt,
    scope: data.scope ?? env.NINJAONE_SCOPES,
    updatedAt: now,
    ...(opts.connectedBy !== undefined
      ? { connectedBy: opts.connectedBy, connectedAt: now }
      : {}),
  };
  await db
    .insert(ninjaoneTokens)
    .values(row)
    .onConflictDoUpdate({ target: ninjaoneTokens.provider, set: row });
  cache = { token: data.access_token, expiresAt: accessExpiresAt.getTime() };
}

/** The URL to send the admin to for interactive consent. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.NINJAONE_CLIENT_ID,
    redirect_uri: env.ninjaoneRedirectUri,
    scope: env.NINJAONE_SCOPES,
    state,
  });
  return `${base()}/oauth/authorize?${params}`;
}

/** Exchange an authorization code for tokens and persist them. */
export async function exchangeCode(code: string, connectedBy: string | null): Promise<void> {
  const data = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.ninjaoneRedirectUri,
  });
  await storeTokens(data, { connectedBy });
}

async function loadConnection(): Promise<NinjaoneToken | null> {
  const [row] = await db
    .select()
    .from(ninjaoneTokens)
    .where(eq(ninjaoneTokens.provider, PROVIDER))
    .limit(1);
  return row ?? null;
}

/** Connection status for the Settings UI. */
export async function getConnection(): Promise<{ connected: boolean; connectedAt: string | null }> {
  const row = await loadConnection();
  return { connected: Boolean(row), connectedAt: row ? row.connectedAt.toISOString() : null };
}

/** Forget the stored tokens (disconnect). */
export async function clearConnection(): Promise<void> {
  cache = null;
  await db.delete(ninjaoneTokens).where(eq(ninjaoneTokens.provider, PROVIDER));
}

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now + 30_000) return cache.token;

  const row = await loadConnection();
  if (!row) {
    throw new Error("NinjaOne is not connected. Authorize it in Settings first.");
  }
  if (row.accessToken && row.accessExpiresAt && row.accessExpiresAt.getTime() > now + 30_000) {
    cache = { token: row.accessToken, expiresAt: row.accessExpiresAt.getTime() };
    return cache.token;
  }

  const data = await postToken({ grant_type: "refresh_token", refresh_token: row.refreshToken });
  await storeTokens(data, { priorRefresh: row.refreshToken });
  return cache!.token;
}

async function ninjaGet<T>(pathWithQuery: string): Promise<T> {
  const token = await getToken();
  const resp = await fetch(`${base()}${pathWithQuery}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`NinjaOne GET ${pathWithQuery} failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

async function ninjaPatch(pathWithQuery: string, body: unknown): Promise<void> {
  const token = await getToken();
  const resp = await fetch(`${base()}${pathWithQuery}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`NinjaOne PATCH ${pathWithQuery} failed (${resp.status}): ${await resp.text()}`);
  }
}

/** Write a device's Asset ID custom field. This app owns that value. */
export async function setDeviceAssetId(
  deviceId: number,
  fieldName: string,
  value: string,
): Promise<void> {
  await ninjaPatch(`/v2/device/${deviceId}/custom-fields`, { [fieldName]: value });
}

export type NinjaDevice = {
  id: number;
  name: string;
  serial: string | null;
  manufacturer: string | null;
  model: string | null;
  organizationId: number | null;
};

type RawDevice = {
  id: number;
  systemName?: string;
  dnsName?: string;
  organizationId?: number;
  system?: { serialNumber?: string; biosSerialNumber?: string; manufacturer?: string; model?: string };
};

/** Page through /v2/devices-detailed and normalize the fields we care about. */
export async function getDevices(): Promise<NinjaDevice[]> {
  const out: NinjaDevice[] = [];
  let after = 0;
  // Cursor pagination: `after` = last device id seen.
  for (let guard = 0; guard < 1000; guard++) {
    const page = await ninjaGet<RawDevice[]>(`/v2/devices-detailed?pageSize=1000&after=${after}`);
    if (!page.length) break;
    for (const d of page) {
      const serial = d.system?.serialNumber || d.system?.biosSerialNumber || null;
      out.push({
        id: d.id,
        name: d.systemName || d.dnsName || `NinjaOne device ${d.id}`,
        serial: serial && serial.trim() ? serial.trim() : null,
        manufacturer: d.system?.manufacturer ?? null,
        model: d.system?.model ?? null,
        organizationId: d.organizationId ?? null,
      });
    }
    after = page[page.length - 1]!.id;
    if (page.length < 1000) break;
  }
  return out;
}

/** Map each organization id to its name. */
export async function getOrganizations(): Promise<Map<number, string>> {
  const orgs = await ninjaGet<{ id: number; name: string }[]>(`/v2/organizations?pageSize=1000`);
  return new Map(orgs.map((o) => [o.id, o.name]));
}

type CustomFieldRow = { deviceId: number; fields?: Record<string, unknown> };
type CustomFieldQuery = { results?: CustomFieldRow[]; cursor?: { offset?: number; count?: number } };

/** Map each device id to its Asset ID custom-field value, in one query. */
export async function getAssetIds(fieldName: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const data = await ninjaGet<CustomFieldQuery>(
    `/v2/queries/custom-fields?fields=${encodeURIComponent(fieldName)}&pageSize=1000`,
  );
  for (const row of data.results ?? []) {
    const raw = row.fields?.[fieldName];
    const value = raw == null ? "" : String(raw).trim();
    if (value) map.set(row.deviceId, value);
  }
  return map;
}
