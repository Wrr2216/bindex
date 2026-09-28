import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../env";
import { logger } from "../../lib/logger";

/**
 * The service worker, stamped with the build it belongs to.
 *
 * The worker keeps a copy of the built app so it opens without a connection.
 * The browser only installs a new worker when the worker's own bytes change,
 * so the server writes the build's id and file list into it: every deploy
 * changes the worker, the browser installs it alongside the running one, and
 * the app can offer "update available" instead of switching versions under
 * someone mid-task. The Vite dev server serves the file untouched, and the
 * worker copes with the placeholders left in.
 */

const BUILD_PLACEHOLDER = '"__BINDEX_BUILD_ID__"';
const PRECACHE_PLACEHOLDER = '"__BINDEX_PRECACHE__"';

/** A short id that changes whenever the built files do. Pure, for tests. */
export function buildIdFor(indexHtml: string, assets: string[]): string {
  return createHash("sha256")
    .update(indexHtml)
    .update("\n")
    .update([...assets].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/** Fill in the placeholders. Pure, for tests. */
export function renderServiceWorker(template: string, buildId: string, precache: string[]): string {
  return template
    .split(BUILD_PLACEHOLDER)
    .join(JSON.stringify(buildId))
    .split(PRECACHE_PLACEHOLDER)
    .join(JSON.stringify(precache));
}

/** Where the built client lives. Mirrors the static handler in index.ts. */
function clientDist(): string {
  return (
    process.env.CLIENT_DIST ||
    (env.isProd
      ? path.resolve(process.cwd(), "client-dist")
      : path.resolve(process.cwd(), "../client/dist"))
  );
}

let cached: { body: string; buildId: string } | null | undefined;

/**
 * The stamped worker, or null when there is no built client to describe (the
 * dev server serves its own copy). Built once: the files cannot change under a
 * running process.
 */
export function loadServiceWorker(): { body: string; buildId: string } | null {
  if (cached !== undefined) return cached;
  const dist = clientDist();
  try {
    const template = fs.readFileSync(path.join(dist, "sw.js"), "utf8");
    const indexHtml = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    const assetsDir = path.join(dist, "assets");
    const assets = fs.existsSync(assetsDir)
      ? fs
          .readdirSync(assetsDir, { withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => `/assets/${d.name}`)
      : [];
    const buildId = buildIdFor(indexHtml, assets);
    cached = { body: renderServiceWorker(template, buildId, assets.sort()), buildId };
    logger.info("offline.sw.ready", { buildId, precache: assets.length });
  } catch (err) {
    logger.info("offline.sw.unavailable", { dist, err: String(err) });
    cached = null;
  }
  return cached;
}
