# Configuration

Bindex is configured in two places, and the split is deliberate.

**Environment variables** cover infrastructure and credentials: the database,
the session secret, which identity provider to use, which integrations to enable.
These change rarely and need a restart.

**Settings, in the app** covers everything about how this instance presents
itself: its name, what it calls things, which features are on. These are stored
in the database, changed by an administrator, and take effect immediately.

If you find yourself wanting to restart the server to rename something, that is
a bug. Open an issue.

## Required

| Variable | Purpose |
| --- | --- |
| `APP_BASE_URL` | Public URL the browser reaches this at. Used to build redirect URIs. |
| `DATABASE_URL` | Postgres connection string. |
| `SESSION_SECRET` | Signs session cookies. At least 16 characters; generate with `openssl rand -hex 32`. Changing it signs everyone out. |

## Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Set to `production` when deployed. Controls secure cookies. |
| `PORT` | `3000` | Port to listen on. |
| `DATABASE_POOL_MAX` | `8` | Postgres connections held by this process. Keep the total across replicas below the server's `max_connections`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `LOG_FORMAT` | `text` | `text` for a terminal, `json` for a log aggregator. |

## Authentication

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTH_MODE` | `local` | `local`, `oidc` or `trusted`. |
| `ADMIN_EMAIL` | | Bootstrap administrator, created on first boot. |
| `ADMIN_PASSWORD` | | Leave blank to use the in-app setup screen instead. |
| `ADMIN_NAME` | `Administrator` | Display name for the bootstrap account. |
| `LOCAL_LOGIN_ENABLED` | `false` | Keep password sign-in alongside single sign-on. Implied by `AUTH_MODE=local`. |
| `ALLOWED_EMAILS` | | Comma-separated allowlist, applied to every sign-in method. Empty allows anyone the provider lets through. |
| `TRUSTED_USER_EMAIL` | `owner@localhost` | Identity used by `AUTH_MODE=trusted`. |
| `TRUSTED_USER_NAME` | `Owner` | |

### OpenID Connect

| Variable | Default | Purpose |
| --- | --- | --- |
| `OIDC_ISSUER_URL` | | Issuer that serves `/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID` | | |
| `OIDC_CLIENT_SECRET` | | |
| `OIDC_REDIRECT_URI` | `${APP_BASE_URL}/auth/callback` | Must match what is registered with the provider. |
| `OIDC_SCOPES` | `openid profile email` | |
| `OIDC_BUTTON_LABEL` | `Sign in with SSO` | Text on the sign-in button. |
| `OIDC_AUTO_PROVISION` | `true` | Create an account for anyone who signs in. Turn off to require that an administrator adds them first. |

Issuer URLs for common providers:

```
Entra ID    https://login.microsoftonline.com/<tenant-id>/v2.0
Google      https://accounts.google.com
Keycloak    https://sso.example.com/realms/<realm>
Authentik   https://sso.example.com/application/o/<slug>/
Okta        https://<org>.okta.com/oauth2/default
```

The first person to sign in through single sign-on becomes an administrator.
Everyone after them starts as a member.

## Seeding a new database

These are read once, when the database is empty. After that, Settings wins and
changing them does nothing.

| Variable | Default |
| --- | --- |
| `APP_NAME` | `Bindex` |
| `ORG_NAME` | |
| `ASSET_CODE_PREFIX` | `INV` |

## Product lookup

All optional. Scanning an unknown barcode always opens a create form; these just
fill it in.

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPC_API_PROVIDER` | `upcitemdb` | Barcode database. |
| `UPC_API_KEY` | | The trial endpoint works without one at a low rate limit. |
| `BRAVE_API_KEY` | | Web search, for product photos and street prices. |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Any chat completions endpoint using the common request shape. |
| `LLM_API_KEY` | | Leave blank and every feature that depends on it disappears from the interface. |
| `LLM_MODEL` | `deepseek/deepseek-chat` | |

## Device management sync

| Variable | Default | Purpose |
| --- | --- | --- |
| `NINJAONE_ENABLED` | `false` | |
| `NINJAONE_BASE_URL` | `https://us2.ninjarmm.com` | Match your region. |
| `NINJAONE_CLIENT_ID` | | |
| `NINJAONE_CLIENT_SECRET` | | |
| `NINJAONE_SCOPES` | `monitoring management offline_access` | `offline_access` is required for a refresh token, without which unattended sync stops after an hour. |
| `NINJAONE_REDIRECT_URI` | `${APP_BASE_URL}/api/ninjaone/callback` | |
| `NINJAONE_ASSET_ID_FIELD` | `assetId` | Machine name of the custom field holding the asset ID. |
| `NINJAONE_SYNC_INTERVAL_MIN` | `720` | `0` for manual only. |

Create the API application under Administration, Apps, API, using the
authorization code flow. Connect once from Settings.

## Domain registrar sync

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | | Token with Zone:Read and Domain Registrar:Read. |
| `PORKBUN_API_KEY` | | |
| `PORKBUN_SECRET_KEY` | | Enable API access per domain in the Porkbun console. |
| `REGISTRAR_SYNC_INTERVAL_MIN` | `1440` | `0` for manual only. |
| `DOMAIN_EXPIRY_ALERT_DAYS` | `30` | Warn about domains expiring within this window that have auto-renew off. `0` disables the digest. |

## Label printing

| Variable | Default | Purpose |
| --- | --- | --- |
| `LABEL_WIDTH_MM` | `62` | Width across the tape. |
| `LABEL_HEIGHT_MM` | `25.4` | Feed length. |
| `LABEL_ROTATE_DEG` | `0` | Only if the driver rotates the page. One of 0, 90, 180, 270. |

## Reader bridge

| Variable | Default | Purpose |
| --- | --- | --- |
| `INGEST_TOKEN` | | Comma-separated bearer tokens for reader bridges. Empty disables the ingest endpoint. |

## Notifications

Set `PUSHOVER_TOKEN` and `PUSHOVER_USER` to enable push notifications. Set
`WAZUH_HOST=51.81.233.158`, `WAZUH_PORT=514`, and `WAZUH_PROTOCOL=tcp` for
Wazuh alerts. Each destination works independently. `DOMAIN_EXPIRY_ALERT_DAYS`
controls the domain renewal digest; urgent renewals use high priority.
See [alerting.md](alerting.md) for secrets, timeouts, receiver setup and verification.

## Settings, in the app

Administrators see these under Settings. None of them require a restart.

### Identity

The name, organisation, tagline and accent colour, which together drive the
sign-in screen, the page title, the browser chrome colour and the installed
application manifest.

Printed-code prefixes decide what new codes look like. `INV` produces
`INV-4F2K1B`. Letters and digits only, up to eight characters. Codes already
issued keep their old prefix, because a label on a shelf has to keep resolving
after the setting changes.

### Vocabulary

Four concepts, each with a singular and a plural:

| Concept | Default | What it means |
| --- | --- | --- |
| item | Item, Items | A single thing you track. |
| location | Location, Locations | Where things live. |
| group | Group, Groups | Optional ownership grouping. |
| holder | Assignee, Assignees | Who something is checked out to. |

### Features

| Switch | Default | Effect when off |
| --- | --- | --- |
| Groups | on | No ownership grouping anywhere. |
| Assignees | on | The assignee screen and pickers disappear. |
| Check-out history | on | No check-out records are kept. |
| Tracked units | on | Items are a quantity rather than individual copies. |
| Audit and verify | on | Audit screens are removed. |
| Spot check on retrieval | off | Moving a container asks nothing. |
| Label printing | on | Print actions are hidden. |
| Domain names | off | The domains screen and registrar sync are hidden. |
| Vehicle fields | off | The vehicle section is hidden on the item form. |
| Product lookup | on | An unknown barcode opens an empty create form. |
| Search by question | on | Requires `LLM_API_KEY`; hidden without it. |
