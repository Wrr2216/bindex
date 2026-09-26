import path from "node:path";
import fs from "node:fs";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import compression from "compression";
import { env } from "./env";
import { logger } from "./lib/logger";
import { runMigrations } from "./db/migrate";
import { sessionMiddleware } from "./auth/session";
import { attachTrustedUser } from "./auth/middleware";
import { authRouter } from "./auth/routes";
import { getOidcClient } from "./auth/oidc";
import { apiRouter } from "./routes/api";
import { configRouter } from "./routes/config";
import { deviceRouter } from "./routes/device";
import { manifestRouter } from "./routes/manifest";
import { offlineFieldPublicRouter } from "./routes/offline-field";
import { seedConfig } from "./services/config";
import { ensureBootstrapAdmin } from "./services/users";
import { runNinjaSync } from "./services/ninjaone/sync";
import { runRegistrarSync } from "./services/registrars/sync";
import { sendExpiryDigest } from "./services/registrars/alerts";
import { startSightingsPrune } from "./services/tracking/prune";
import { startAttachmentSweeper } from "./services/media-ai-core";
import { wireJobEvents } from "./services/integration/jobEvents";
import { HttpError, describeError } from "./lib/errors";
import { startEventBackbone } from "./services/event-backbone";
import { startLowStockDigest } from "./services/consumables/lowstock";

const app = express();
// One proxy hop, which is what a container behind a reverse proxy sees. Needed
// for secure cookies and for the client IP in logs.
app.set("trust proxy", 1);

// Liveness probe: no auth, no session, no database.
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", "blob:"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(compression());

// 1mb of JSON is plenty for every route except the backup import, which parses
// its own larger body inside the handler, and hardware ingest under
// /api/device, which parses its own (see routes/device.ts).
const jsonParser = express.json({ limit: "1mb" });
app.use((req, res, next) => {
  if (req.path === "/api/backup/import" || req.path.startsWith("/api/device/")) return next();
  jsonParser(req, res, next);
});
app.use(sessionMiddleware);
app.use(attachTrustedUser);

app.use("/auth", authRouter);
// The sign-in screen needs the instance name and colours, so configuration is
// readable before authentication.
app.use("/api/config", configRouter);
// Reader-bridge ingest is token-authed and mounted before the session guard so
// hardware can post without a browser cookie.
app.use("/api/device", deviceRouter);
// Built from the configuration, so it has to come before the static handler.
app.use(manifestRouter);
// The service worker is stamped with the build, so it too comes before them.
app.use(offlineFieldPublicRouter);
app.use("/api", apiRouter);

// Unmatched API routes answer with JSON rather than the single-page shell.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found", code: "not_found" });
});

// Serve the built client, with the single-page fallback.
const clientDist =
  process.env.CLIENT_DIST ||
  (env.isProd
    ? path.resolve(process.cwd(), "client-dist")
    : path.resolve(process.cwd(), "../client/dist"));

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/auth")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
  logger.info("server.client.static", { clientDist });
} else {
  logger.warn("server.client.missing", {
    clientDist,
    hint: "run `pnpm build`, or use the Vite dev server",
  });
}

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }
  // describeError unwraps `cause` chains: driver errors keep the constraint
  // name and the Postgres error code down there, not in the wrapper message.
  logger.error("http.unhandled", { err: describeError(err), path: req.path });
  res.status(500).json({ error: "Internal server error", code: "internal" });
};
app.use(errorHandler);

async function main(): Promise<void> {
  await runMigrations();
  // Load configuration before serving: asset-code generation reads the prefixes
  // synchronously and would otherwise use the defaults on the first requests.
  await seedConfig();
  await ensureBootstrapAdmin();
  wireJobEvents();

  // Warm the identity provider client. A provider that is slow or briefly down
  // should not stop the server from starting.
  getOidcClient().catch((err) => logger.warn("auth.oidc.init_failed", { err: String(err) }));

  app.listen(env.PORT, () => {
    logger.info("server.listening", {
      port: env.PORT,
      env: env.NODE_ENV,
      authMode: env.AUTH_MODE,
    });
    if (env.trustedAuth) {
      logger.warn("server.auth_disabled", {
        hint: "AUTH_MODE=trusted: every request is treated as the owner",
      });
    }
    if (env.AUTH_MODE === "oidc" && !env.oidcConfigured) {
      logger.warn("server.sso_not_configured", { hint: "set OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET" });
    }
    startNinjaSync();
    startRegistrarSync();
    startEventBackbone();
    startSightingsPrune();
    startAttachmentSweeper();
    startLowStockDigest();
  });
}

/** Periodic device-management pull, plus one on boot. Off unless configured. */
function startNinjaSync(): void {
  if (!env.ninjaoneConfigured || env.NINJAONE_SYNC_INTERVAL_MIN <= 0) return;
  const run = () =>
    runNinjaSync(null).catch((err) => logger.warn("ninjaone.autosync.failed", { err: String(err) }));
  run();
  setInterval(run, env.NINJAONE_SYNC_INTERVAL_MIN * 60_000).unref();
  logger.info("ninjaone.autosync.enabled", { intervalMinutes: env.NINJAONE_SYNC_INTERVAL_MIN });
}

/** Periodic registrar pull, plus the daily expiry digest. Off unless configured. */
function startRegistrarSync(): void {
  if (!env.registrarsConfigured) return;
  if (env.REGISTRAR_SYNC_INTERVAL_MIN > 0) {
    const run = () =>
      runRegistrarSync(null).catch((err) =>
        logger.warn("registrars.autosync.failed", { err: String(err) }),
      );
    run();
    setInterval(run, env.REGISTRAR_SYNC_INTERVAL_MIN * 60_000).unref();
  }
  const alert = () =>
    sendExpiryDigest().catch((err) =>
      logger.warn("registrars.expiry_digest.failed", { err: String(err) }),
    );
  // The first check waits for the boot sync to land.
  setTimeout(alert, 5 * 60_000).unref();
  setInterval(alert, 24 * 60 * 60_000).unref();
  logger.info("registrars.autosync.enabled", {
    intervalMinutes: env.REGISTRAR_SYNC_INTERVAL_MIN,
    alertDays: env.DOMAIN_EXPIRY_ALERT_DAYS,
  });
}

main().catch((err) => {
  logger.error("server.boot_failed", { err: describeError(err) });
  process.exit(1);
});
