import express, { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { asyncHandler, parse } from "../lib/http";
import { badRequest, describeError } from "../lib/errors";
import { env } from "../env";
import { logger } from "../lib/logger";
import { pushCodes } from "../services/livefeed";
import { getConfig } from "../services/config";
import { TRACKING_DEVICE_KINDS } from "../db/schema";
import {
  AdapterError,
  parseGeneric,
  parseImpinj,
  parseSpeedwayConnect,
  parseZebra,
  type ParsedPayload,
} from "../services/tracking/adapters";
import {
  channelOf,
  DEFAULT_TECH,
  normalizeCode,
  recordSightings,
  requireDevice,
  RFID_KINDS,
  type TrackingDeviceKind,
} from "../services/tracking";

/**
 * Hardware endpoints. Readers, gateways and trackers run outside any browser
 * session, so they authenticate with a token (see requireDevice) and this
 * router is mounted before the session guard.
 */

const limit = `${env.DEVICE_INGEST_MAX_MB}mb`;

/**
 * Body parsing for everything under /api/device. index.ts leaves these paths
 * to parse their own bodies so a reader can post a batch larger than the 1 MB
 * the rest of the API allows, and in whatever its firmware sends: JSON,
 * newline-delimited JSON, a form, or plain text. Mounted on the router, so a
 * later router mounted under /api/device finds the body already parsed.
 */
export const deviceBody: RequestHandler[] = [
  express.json({ limit, type: ["application/json", "application/*+json"] }),
  express.urlencoded({ extended: false, limit }),
  express.text({ limit, type: ["text/*", "application/x-ndjson", "application/jsonl"] }),
];

export const deviceRouter = Router();
deviceRouter.use(deviceBody);

const scanSchema = z.object({
  epcs: z.array(z.string()),
  reader: z.string().max(64).optional(),
});

// A batch of tag reads from one reader, pushed into that reader's channel for
// the Building Audit screen. Unchanged for existing bridges; with tracking on,
// the reads are also stored as sightings.
deviceRouter.post(
  "/scan",
  // Validating while reading the reader id means a malformed post made with
  // INGEST_TOKEN is refused before it can register a device.
  requireDevice(RFID_KINDS, { readerId: (req) => parse(scanSchema, req.body).reader }),
  asyncHandler(async (req, res) => {
    const { epcs, reader } = parse(scanSchema, req.body);
    const device = req.trackingDevice!;
    const accepted = pushCodes(reader || channelOf(device), epcs);
    if ((await getConfig()).features.tracking) {
      // The audit feed must keep working even if storing fails.
      await recordSightings(
        device,
        epcs.map((code) => ({ code })),
      ).catch((err) =>
        logger.warn("tracking.scan.record_failed", { deviceId: device.id, err: describeError(err) }),
      );
    }
    res.json({ ok: true, accepted });
  }),
);

/** 503 while the feature is switched off, before any device is touched. */
const requireTrackingOn: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.tracking) return next();
      res.status(503).json({
        error:
          "Tracking is switched off on this instance. Turn on Readers, beacons and trackers in Settings, Features.",
        code: "tracking_disabled",
      });
    })
    .catch(next);
};

// Techs whose reads also feed the in-memory channel the audit screen polls.
const LIVE_TECHS = new Set(["rfid", "nfc", "barcode"]);

/**
 * One ingest endpoint for one payload format. The payload is parsed once and
 * shared between the device lookup (which needs the reader id when the shared
 * INGEST_TOKEN was used) and the handler.
 */
function readsEndpoint(
  kinds: readonly TrackingDeviceKind[],
  adapter: (body: unknown) => ParsedPayload,
): RequestHandler[] {
  const payloadOf = (req: Request, res: Response): ParsedPayload => {
    if (!res.locals.trackingPayload) {
      try {
        res.locals.trackingPayload = adapter(req.body);
      } catch (err) {
        if (err instanceof AdapterError) throw badRequest(err.message);
        throw err;
      }
    }
    return res.locals.trackingPayload as ParsedPayload;
  };

  return [
    requireTrackingOn,
    requireDevice(kinds, { readerId: (req, res) => payloadOf(req, res).readerId }),
    asyncHandler(async (req, res) => {
      const payload = payloadOf(req, res);
      const device = req.trackingDevice!;
      const result = await recordSightings(device, payload.reads, { batteryPct: payload.batteryPct });

      const live: string[] = [];
      for (const r of payload.reads) {
        if (r.code && LIVE_TECHS.has(r.tech ?? DEFAULT_TECH[device.kind])) live.push(normalizeCode(r.code));
      }
      if (live.length) pushCodes(channelOf(device), live);

      res.json({ ok: true, deviceId: device.id, ...result, skipped: payload.skipped });
    }),
  ];
}

// Bindex's own format: { device?, battery?, reads: [{ code, ts?, rssi?, antenna?, tech?, lat?, lng? }] }.
deviceRouter.post("/reads", readsEndpoint(TRACKING_DEVICE_KINDS, parseGeneric));
// Zebra FX / ATR readers through the IoT Connector's HTTP POST endpoint.
deviceRouter.post("/reads/zebra", readsEndpoint(RFID_KINDS, parseZebra));
// Impinj R700 IoT device interface webhook (or its stream, relayed).
deviceRouter.post("/reads/impinj", readsEndpoint(RFID_KINDS, parseImpinj));
// Impinj Speedway Connect in HTTP POST mode.
deviceRouter.post("/reads/speedway-connect", readsEndpoint(RFID_KINDS, parseSpeedwayConnect));
