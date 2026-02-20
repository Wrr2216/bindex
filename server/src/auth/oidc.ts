import { Issuer, generators, type Client } from "openid-client";
import { env } from "../env";
import { logger } from "../lib/logger";

let cached: Client | null = null;
let discovery: Promise<Client | null> | null = null;

/**
 * Build the OpenID Connect client from OIDC_ISSUER_URL. Any compliant provider
 * works: Entra, Google, Keycloak, Authentik, Okta and so on. Discovery is done
 * once and shared, so a slow or unreachable provider does not produce one
 * outbound request per sign-in attempt.
 */
export async function getOidcClient(): Promise<Client | null> {
  if (!env.oidcConfigured) return null;
  if (cached) return cached;

  discovery ??= (async () => {
    try {
      const issuer = await Issuer.discover(env.OIDC_ISSUER_URL);
      cached = new issuer.Client({
        client_id: env.OIDC_CLIENT_ID,
        client_secret: env.OIDC_CLIENT_SECRET,
        redirect_uris: [env.oidcRedirectUri],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      });
      logger.info("auth.oidc.ready", { issuer: issuer.metadata.issuer });
      return cached;
    } finally {
      // Allow a later attempt to retry after a transient discovery failure.
      discovery = null;
    }
  })();

  return discovery;
}

/**
 * Namespace the provider's subject claim so two providers, or a provider that
 * was swapped out, cannot collide on the same account id.
 */
export function subjectId(sub: string): string {
  let host = "oidc";
  try {
    host = new URL(env.OIDC_ISSUER_URL).host;
  } catch {
    // A non-URL issuer is already rejected at discovery; fall back to a
    // constant rather than throwing while building an id.
  }
  return `${host}:${sub}`;
}

export { generators };
