import type { Request, RequestHandler, Response } from "express";
import { env } from "../../env";
import { HttpError, describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { anyDeviceTokens, findDeviceByToken, findOrCreateIngestDevice } from "./devices";
import type { TrackingDevice, TrackingDeviceKind } from "./types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The device a hardware request authenticated as; set by requireDevice. */
      trackingDevice?: TrackingDevice;
      /** "device" for a per-device token, "ingest" for the shared INGEST_TOKEN. */
      trackingAuth?: "device" | "ingest";
    }
  }
}

export type RequireDeviceOptions = {
  /**
   * The reader's name for itself in this request, used to find or create the
   * device behind a post made with the shared INGEST_TOKEN. Defaults to the
   * `reader` query parameter, then `reader` or `device` in the JSON body, then
   * the x-reader-id header, then "default".
   */
  readerId?: (req: Request, res: Response) => string | undefined;
};

/**
 * The token a device sent. Bearer and x-device-token are the documented
 * ways. Basic auth (the token as the password) and a `token` query parameter
 * exist for readers whose firmware cannot set a header; a query string can end
 * up in proxy logs, so prefer a header when there is a choice.
 */
export function presentedToken(req: Request): string {
  const header = req.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return (colon >= 0 ? decoded.slice(colon + 1) : decoded).trim();
  }
  const custom = req.get("x-device-token");
  if (custom) return custom.trim();
  return typeof req.query.token === "string" ? req.query.token.trim() : "";
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function defaultReaderId(req: Request): string | undefined {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return (
    str(req.query.reader) ??
    (typeof body === "object" ? (str(body.reader) ?? str(body.device)) : undefined) ??
    str(req.get("x-reader-id"))
  );
}

/**
 * Authenticate a hardware request and put its device on `req.trackingDevice`.
 *
 * A per-device token (issued in Settings, stored hashed) identifies the device
 * directly. The shared INGEST_TOKEN still works, so an existing reader bridge
 * keeps working unchanged: the device is looked up by the reader id in the
 * request, and registered as an rfid_reader the first time it is seen.
 *
 * `kinds` limits which kinds of device may use the route; a device of another
 * kind gets a 403 saying so. Disabled devices get a 403 too.
 *
 * Mount routes using this before the session guard (see routes/device.ts),
 * and parse the body before it when the reader id comes from the body.
 */
export function requireDevice(
  kinds?: readonly TrackingDeviceKind[],
  opts: RequireDeviceOptions = {},
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const token = presentedToken(req);
      let device: TrackingDevice | null = null;

      if (token) {
        device = await findDeviceByToken(token);
        if (device) req.trackingAuth = "device";
      }
      if (!device && token && env.ingestTokens.includes(token)) {
        const readerId = (opts.readerId ? opts.readerId(req, res) : undefined) ?? defaultReaderId(req) ?? "default";
        device = await findOrCreateIngestDevice(readerId, kinds ?? []);
        req.trackingAuth = "ingest";
      }

      if (!device) {
        // With no shared token and no device tokens there is nothing a caller
        // could send, so say that ingest is off rather than that the token is wrong.
        if (env.ingestTokens.length === 0 && !(await anyDeviceTokens())) {
          res.status(503).json({
            error:
              "Device ingest is not configured. Register a device in Settings, Readers and devices, or set INGEST_TOKEN.",
            code: "ingest_disabled",
          });
          return;
        }
        res.status(401).json({
          error: "Invalid device token. Send the device's token as Authorization: Bearer <token>.",
          code: "unauthorized",
        });
        return;
      }
      if (device.disabled) {
        res.status(403).json({ error: `Device "${device.name}" is disabled.`, code: "device_disabled" });
        return;
      }
      if (kinds?.length && !kinds.includes(device.kind)) {
        res.status(403).json({
          error: `A ${device.kind} cannot post here. This endpoint accepts: ${kinds.join(", ")}.`,
          code: "wrong_device_kind",
        });
        return;
      }
      req.trackingDevice = device;
      next();
    })().catch((err) => {
      // A 400 from reading the reader id out of a bad payload is the caller's
      // problem, not ours.
      if (!(err instanceof HttpError)) {
        logger.error("tracking.auth.failed", { err: describeError(err), path: req.path });
      }
      next(err);
    });
  };
}
