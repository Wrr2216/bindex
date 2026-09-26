import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// Load a .env from the server directory or the repo root when one exists. In a
// container the variables are already in the environment and no file is found.
const loadEnvFile = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
if (loadEnvFile) {
  for (const candidate of [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../.env"),
  ]) {
    if (existsSync(candidate)) {
      try {
        loadEnvFile(candidate);
      } catch {
        // A malformed or locked file should not stop the process from starting.
      }
      break;
    }
  }
}

const bool = (fallback = false) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v === "true" || v === "1"));

const list = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Cap on Postgres connections held by this process. Keep it well under the
  // max_connections of the server: every replica opens its own pool, and a
  // shared Postgres that runs out answers new connections with "too many
  // clients".
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(8),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 chars"),

  // ---- Authentication ----------------------------------------------------
  // local    email + password accounts managed in this app (default)
  // oidc     any OpenID Connect provider (Entra, Google, Keycloak, Authentik)
  // trusted  no sign-in at all; every request is the same user. Only safe when
  //          something in front of the app already authenticates the caller.
  AUTH_MODE: z.enum(["local", "oidc", "trusted"]).default("local"),
  // Both can run at once: AUTH_MODE=oidc with LOCAL_LOGIN_ENABLED=true keeps a
  // break-glass password account alongside SSO.
  LOCAL_LOGIN_ENABLED: bool(false),
  // Bootstrap account created on first boot when no users exist yet. Leave the
  // password blank to use the in-app setup screen instead.
  ADMIN_EMAIL: z.string().default(""),
  ADMIN_PASSWORD: z.string().default(""),
  ADMIN_NAME: z.string().default("Administrator"),

  OIDC_ISSUER_URL: z.string().default(""),
  OIDC_CLIENT_ID: z.string().default(""),
  OIDC_CLIENT_SECRET: z.string().default(""),
  OIDC_REDIRECT_URI: z.string().default(""),
  OIDC_SCOPES: z.string().default("openid profile email"),
  OIDC_BUTTON_LABEL: z.string().default("Sign in with SSO"),
  // Create an account for any successful SSO login. Turn off to require that an
  // administrator adds the person first.
  OIDC_AUTO_PROVISION: bool(true),
  // Optional comma-separated allowlist applied to every sign-in method.
  ALLOWED_EMAILS: z.string().default(""),
  // Identity requests run as under AUTH_MODE=trusted.
  TRUSTED_USER_EMAIL: z.string().default("owner@localhost"),
  TRUSTED_USER_NAME: z.string().default("Owner"),

  // ---- Defaults for first boot -------------------------------------------
  // These seed the editable settings the first time the database comes up.
  // Afterwards the stored values win and changing these has no effect.
  APP_NAME: z.string().default("Bindex"),
  ORG_NAME: z.string().default(""),
  ASSET_CODE_PREFIX: z.string().default("INV"),

  // ---- Product lookup ----------------------------------------------------
  // Barcode lookup provider. The trial endpoint works without a key at a low
  // rate limit; supplying a key switches to the paid endpoint.
  UPC_API_PROVIDER: z.string().default("upcitemdb"),
  UPC_API_KEY: z.string().default(""),
  // Optional web search, used for product photos and street prices.
  BRAVE_API_KEY: z.string().default(""),
  // Optional language-model provider, used to summarize a product from search
  // results and to turn a typed question into a search filter. Any
  // OpenAI-compatible chat endpoint works.
  LLM_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("deepseek/deepseek-chat"),

  // ---- Device management sync (NinjaOne) ---------------------------------
  NINJAONE_ENABLED: bool(false),
  NINJAONE_BASE_URL: z.string().default("https://us2.ninjarmm.com"),
  NINJAONE_CLIENT_ID: z.string().default(""),
  NINJAONE_CLIENT_SECRET: z.string().default(""),
  // Authorization-code grant. offline_access is required to receive a refresh
  // token, without which unattended sync stops working after the first hour.
  NINJAONE_SCOPES: z.string().default("monitoring management offline_access"),
  NINJAONE_REDIRECT_URI: z.string().default(""),
  NINJAONE_ASSET_ID_FIELD: z.string().default("assetId"),
  NINJAONE_SYNC_INTERVAL_MIN: z.coerce.number().int().nonnegative().default(720),

  // ---- Domain registrar sync ---------------------------------------------
  CLOUDFLARE_API_TOKEN: z.string().default(""),
  PORKBUN_API_KEY: z.string().default(""),
  PORKBUN_SECRET_KEY: z.string().default(""),
  REGISTRAR_SYNC_INTERVAL_MIN: z.coerce.number().int().nonnegative().default(1440),
  // Window for the expiry digest; 0 disables it.
  DOMAIN_EXPIRY_ALERT_DAYS: z.coerce.number().int().nonnegative().default(30),

  // ---- Label printing ----------------------------------------------------
  // Printed label size in mm (width across the tape by feed length). The
  // default matches a 62 mm continuous roll cut to one inch.
  LABEL_WIDTH_MM: z.coerce.number().positive().default(62),
  LABEL_HEIGHT_MM: z.coerce.number().positive().default(25.4),
  // Escape hatch for drivers that rotate the page (0/90/180/270).
  LABEL_ROTATE_DEG: z.coerce.number().int().default(0),

  // ---- Reader bridge ingest ----------------------------------------------
  // Comma-separated tokens a reader bridge sends as an Authorization bearer
  // header. Empty disables the ingest endpoint.
  INGEST_TOKEN: z.string().default(""),

  // ---- Logging and notifications -----------------------------------------
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_FORMAT: z.enum(["text", "json"]).default("text"),
  // Independent Pushover and Wazuh destinations for background alerts.
  PUSHOVER_TOKEN: z.string().default(""),
  PUSHOVER_USER: z.string().default(""),
  WAZUH_HOST: z.string().default(""),

  // ---- T04: audit log and webhooks ----------------------------------------
  // Let webhooks reach private, loopback and link-local addresses, for a
  // warehouse system on the local network. Off by default so an endpoint
  // cannot be used to probe the network the server sits on.
  WEBHOOK_ALLOW_PRIVATE: bool(false),
  // Signs the daily audit-log checkpoints. Defaults to a key derived from
  // SESSION_SECRET; set it so that rotating the session secret does not leave
  // existing checkpoints unverifiable.
  AUDIT_SIGNING_KEY: z.string().default(""),
  // ---- T01: tracking core (readers, beacons and trackers) -----------------
  // Days of sightings to keep; older ones are pruned daily. 0 keeps them all.
  SIGHTINGS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),
  // A repeat of the same code on the same device within this many seconds is
  // not stored again. Devices can override it in their settings.
  TRACKING_DEDUP_SECONDS: z.coerce.number().nonnegative().default(5),
  // Largest request body a reader may post to /api/device.
  DEVICE_INGEST_MAX_MB: z.coerce.number().positive().default(16),
  // ---- T02: attachments, AI vision and transcription ---------------------
  // Files larger than ATTACHMENT_DB_MAX_MB (video, mostly) are written here.
  // In a container, mount a volume at this path.
  DATA_DIR: z.string().default("./data"),
  ATTACHMENT_DB_MAX_MB: z.coerce.number().positive().default(8),
  ATTACHMENT_MAX_MB: z.coerce.number().positive().default(512),
  // A model that accepts images. Blank uses LLM_MODEL, which then has to.
  LLM_VISION_MODEL: z.string().default(""),
  // OpenAI-compatible /audio/transcriptions. Blank reuses the LLM provider.
  STT_BASE_URL: z.string().default(""),
  STT_API_KEY: z.string().default(""),
  STT_MODEL: z.string().default("whisper-1"),
  // ---- T06: consumables and equipment ------------------------------------
  // Hour of the day (server time, 0-23) after which the daily low-stock
  // digest is sent through the notification destinations above. -1 turns it off.
  CONSUMABLES_DIGEST_HOUR: z.coerce.number().int().min(-1).max(23).default(7),
  // ---- T08: offline field mode --------------------------------------------
  // Most items one "Make available offline" may copy to a device. Guards a
  // phone against a whole large instance; pick a location to go smaller.
  OFFLINE_SNAPSHOT_MAX_ITEMS: z.coerce.number().int().positive().default(10000),
  // ---- T18: crew check-in and credentials --------------------------------
  // Optional external verifier asked about every badge scanned at check-in.
  // Blank turns it off; check-ins then go on the credentials stored here.
  CREDENTIAL_VERIFY_URL: z.string().default(""),
  CREDENTIAL_VERIFY_TOKEN: z.string().default(""),
  CREDENTIAL_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Window for the daily digest of expiring crew credentials; 0 disables it.
  CREW_EXPIRY_ALERT_DAYS: z.coerce.number().int().nonnegative().default(30),
  // The digest goes out at the first hourly check at or after this UTC hour.
  CREW_DIGEST_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(13),
  // ---- T20: teardown guides ---------------------------------------------
  // ffmpeg pulls the narration out of teardown videos and grabs a still per
  // step. Optional: without it on PATH (or at this path) those steps are
  // skipped and the guide is written by hand.
  FFMPEG_PATH: z.string().default("ffmpeg"),
  // ---- T10: GPS trackers, maps and geofences -----------------------------
  // Map tiles. OpenStreetMap's own servers are for light use only; point these
  // at a self-hosted or commercial tile service for a fleet. {s}, {z}, {x}, {y}
  // are Leaflet placeholders.
  MAP_TILE_URL: z.string().default("https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
  MAP_ATTRIBUTION: z
    .string()
    .default('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
  MAP_MAX_ZOOM: z.coerce.number().int().min(1).max(24).default(19),
  // A fix that would need more than this speed (metres per second) to reach
  // from the last one is a jump and is not believed. 70 m/s is 250 km/h.
  GPS_MAX_SPEED_MPS: z.coerce.number().positive().default(70),
  // Warn when a tracker's battery is at or below this percentage.
  GPS_BATTERY_LOW_PCT: z.coerce.number().int().min(0).max(100).default(20),
  // ---- T15: external portal ------------------------------------------------
  // Outgoing mail for portal codes, links and milestone emails, as a URL:
  // smtp://user:pass@mail.example.com:587 or smtps://…:465. Blank turns email
  // off: links cannot require a code and nobody is notified.
  SMTP_URL: z.string().default(""),
  // The From address, such as "Bindex <inventory@example.com>".
  SMTP_FROM: z.string().default(""),
  // Items worth at least this much, in the instance currency, are flagged as
  // high value on portal pages (the amount itself only shows where allowed).
  PORTAL_HIGH_VALUE: z.coerce.number().nonnegative().default(1000),
  // Minimum minutes between two milestone emails to the same person; the
  // milestones in between go out together.
  PORTAL_NOTIFY_INTERVAL_MIN: z.coerce.number().nonnegative().default(15),
  // ---- T22: operations insights ------------------------------------------
  // Minutes between scheduled runs of the anomaly rules while the feature is
  // on. 0 stops the schedule; runs can still be started from the Insights page.
  OPS_INTEL_INTERVAL_MIN: z.coerce.number().int().nonnegative().default(15),
  // ---- T09: Bluetooth beacons, gateways and room-level presence -----------
  // Seconds of signal readings kept per gateway for each tag.
  BLE_WINDOW_SECONDS: z.coerce.number().positive().default(20),
  // How those readings are smoothed: median (robust to spikes) or ewma.
  BLE_SMOOTHING: z.enum(["median", "ewma"]).default("median"),
  // A room must beat the tag's current room by this many dB...
  BLE_HYSTERESIS_DB: z.coerce.number().nonnegative().default(6),
  // ...for this many seconds before the tag is moved there.
  BLE_DWELL_SECONDS: z.coerce.number().nonnegative().default(10),
  // Readings a gateway needs inside the window before it counts.
  BLE_MIN_SAMPLES: z.coerce.number().int().positive().default(1),
  // A tag not heard for this long is marked missing. Tags can override it.
  BLE_MISSING_MINUTES: z.coerce.number().positive().default(10),
  // A tag that stays put is stored as a sighting at most this often.
  BLE_STORE_SECONDS: z.coerce.number().nonnegative().default(60),
  // How long a phone's room (from the room beacons it heard) stays current.
  BLE_PHONE_ROOM_SECONDS: z.coerce.number().positive().default(300),
  // Battery level at or below which a tag, beacon or gateway is reported.
  BLE_BATTERY_LOW_PCT: z.coerce.number().min(0).max(100).default(20),
  // Working hours, e.g. "Mon-Fri 07:00-19:00; Sat 08:00-12:00". A tag that
  // changes room outside them raises an alert. Blank turns that alert off.
  BLE_WORK_HOURS: z.string().default(""),
  // IANA time zone for BLE_WORK_HOURS. Blank uses the server's.
  BLE_TIMEZONE: z.string().default(""),
  // Minutes between alert digests sent through Pushover or Wazuh. 0 stops them.
  BLE_ALERT_DIGEST_MINUTES: z.coerce.number().nonnegative().default(15),
  // Optional MQTT broker that gateways publish to, e.g. mqtt://broker:1883.
  BLE_MQTT_URL: z.string().default(""),
  // Topics to subscribe to, comma-separated. A + segment names the gateway.
  BLE_MQTT_TOPIC: z.string().default("bindex/ble/+"),
  BLE_MQTT_USERNAME: z.string().default(""),
  BLE_MQTT_PASSWORD: z.string().default(""),
  // Payload format on those topics: auto, generic, minew, ingics, kontakt or teltonika.
  BLE_MQTT_FORMAT: z.enum(["auto", "generic", "minew", "ingics", "kontakt", "teltonika"]).default("auto"),
  // ---- T11: placement guidance ------------------------------------------------
  // How often reads from room readers are checked against where each line is
  // going, in seconds. 0 stops readers from placing anything; sweeps and the
  // placement card keep working.
  PLACEMENT_READER_POLL_SECONDS: z.coerce.number().nonnegative().default(2),
  // ---- T16: claims and incidents ------------------------------------------
  // Hours from submission until a decision is due. A claim past it undecided
  // is flagged overdue and announced once as claim.sla_breached.
  CLAIMS_SLA_HOURS: z.coerce.number().positive().default(240),
  INCIDENT_SLA_HOURS: z.coerce.number().positive().default(72),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === "production",

  oidcConfigured: Boolean(
    raw.OIDC_ISSUER_URL && raw.OIDC_CLIENT_ID && raw.OIDC_CLIENT_SECRET,
  ),
  oidcRedirectUri: raw.OIDC_REDIRECT_URI || `${raw.APP_BASE_URL}/auth/callback`,
  oidcScopes: raw.OIDC_SCOPES.trim() || "openid profile email",
  // Password sign-in is implied by AUTH_MODE=local and can also be added to an
  // SSO deployment as a break-glass path.
  localLoginEnabled: raw.AUTH_MODE === "local" || raw.LOCAL_LOGIN_ENABLED,
  trustedAuth: raw.AUTH_MODE === "trusted",
  allowedEmails: list(raw.ALLOWED_EMAILS).map((e) => e.toLowerCase()),
  ingestTokens: list(raw.INGEST_TOKEN),

  ninjaoneConfigured: Boolean(
    raw.NINJAONE_ENABLED && raw.NINJAONE_CLIENT_ID && raw.NINJAONE_CLIENT_SECRET,
  ),
  ninjaoneRedirectUri:
    raw.NINJAONE_REDIRECT_URI || `${raw.APP_BASE_URL}/api/ninjaone/callback`,
  ninjaoneAssetUrl: (assetId: string) =>
    `${raw.NINJAONE_BASE_URL.replace(/\/+$/, "")}/#/assetManagement/search?assetId=${encodeURIComponent(assetId)}`,

  cloudflareConfigured: Boolean(raw.CLOUDFLARE_API_TOKEN),
  porkbunConfigured: Boolean(raw.PORKBUN_API_KEY && raw.PORKBUN_SECRET_KEY),
  registrarsConfigured: Boolean(
    raw.CLOUDFLARE_API_TOKEN || (raw.PORKBUN_API_KEY && raw.PORKBUN_SECRET_KEY),
  ),

  llmConfigured: Boolean(raw.LLM_API_KEY),
  webSearchConfigured: Boolean(raw.BRAVE_API_KEY),
  pushoverConfigured: Boolean(raw.PUSHOVER_TOKEN && raw.PUSHOVER_USER),
  wazuhConfigured: Boolean(raw.WAZUH_HOST),

  // T02
  dataDir: path.resolve(process.cwd(), raw.DATA_DIR),
  llmVisionModel: raw.LLM_VISION_MODEL.trim() || raw.LLM_MODEL,
  llmVisionConfigured: Boolean(raw.LLM_API_KEY && (raw.LLM_VISION_MODEL.trim() || raw.LLM_MODEL)),
  sttBaseUrl: raw.STT_BASE_URL.trim() || raw.LLM_BASE_URL,
  sttApiKey: raw.STT_API_KEY || raw.LLM_API_KEY,
  sttConfigured: Boolean(raw.STT_API_KEY || raw.LLM_API_KEY),

  // T15
  smtpConfigured: Boolean(raw.SMTP_URL.trim()),
  // T09
  bleMqttConfigured: Boolean(raw.BLE_MQTT_URL.trim()),
};

export type Env = typeof env;
