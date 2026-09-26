import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { currentUser, requireAdmin } from "../auth/middleware";
import { env } from "../env";
import { getConfig } from "../services/config";
import { AdapterError } from "../services/tracking/adapters";
import { presentedToken, requireDevice } from "../services/tracking";
import {
  SPEED_UNITS,
  createGeofence,
  createLink,
  deleteGeofence,
  dismissPrompt,
  endLink,
  firstDeviceKey,
  getGeofence,
  ingestPayload,
  getTracker,
  itemTrail,
  listGeofenceEvents,
  listGeofences,
  listLinks,
  listTrackers,
  openShipments,
  parseGpsBatch,
  parseOsmAnd,
  parseTraccarForward,
  setTrackerStatus,
  shipmentMap,
  trackerForKey,
  trackerTrail,
  updateGeofence,
  updateTrackerSettings,
  type Actor,
  type GpsPayload,
} from "../services/gps";

/**
 * GPS tracking. Two routers:
 *
 * - gpsDeviceRouter, mounted at /api/device/gps before the session guard:
 *   what trackers post, authenticated with device tokens like every reader.
 * - gpsRouter, mounted at /api/gps behind it: maps, trails, geofences,
 *   trackers and shipment links for people and API keys.
 *
 * Both are gone while the feature (or the tracking core it builds on) is off.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const actor = (req: Request): Actor => {
  const user = currentUser(req);
  return { userOid: user.oid, name: user.name };
};

// --- Hardware ---------------------------------------------------------------------

export const gpsDeviceRouter = Router();

/** 503 while switched off, before any device is looked at. */
const requireGpsOn: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (!config.features.tracking) {
        res.status(503).json({
          error:
            "Tracking is switched off on this instance. Turn on Readers, beacons and trackers in Settings, Features.",
          code: "tracking_disabled",
        });
        return;
      }
      if (!config.features.gps) {
        res.status(503).json({
          error: "GPS tracking is switched off on this instance. Turn on GPS tracking in Settings, Features.",
          code: "gps_disabled",
        });
        return;
      }
      next();
    })
    .catch(next);
};

/**
 * One tracker endpoint for one payload format. The payload is parsed once and
 * shared by the device lookup (a post made with the shared INGEST_TOKEN is
 * matched to a tracker by the id in it) and the handler.
 */
function trackerEndpoint(parser: (req: Request) => GpsPayload, mode: "own" | "forward"): RequestHandler[] {
  const payloadOf = (req: Request, res: Response): GpsPayload => {
    if (!res.locals.gpsPayload) {
      try {
        res.locals.gpsPayload = parser(req);
      } catch (err) {
        if (err instanceof AdapterError) throw badRequest(err.message);
        throw err;
      }
    }
    return res.locals.gpsPayload as GpsPayload;
  };

  // With INGEST_TOKEN the tracking core registers an unknown sender as an RFID
  // reader. A tracker should be registered as a tracker, so do that first.
  const registerIngestTracker: RequestHandler = (req, res, next) => {
    const token = presentedToken(req);
    if (!token || !env.ingestTokens.includes(token)) return next();
    void (async () => {
      const key = firstDeviceKey(payloadOf(req, res));
      if (!key) {
        throw badRequest("A post made with INGEST_TOKEN must name its tracker (id, device_id or device.uniqueId).");
      }
      const first = payloadOf(req, res).reports.find((r) => r.deviceKey === key);
      await trackerForKey(key, { name: first?.deviceName, register: true });
    })().then(() => next(), next);
  };

  return [
    requireGpsOn,
    registerIngestTracker,
    requireDevice(["gps_tracker"], { readerId: (req, res) => firstDeviceKey(payloadOf(req, res)) }),
    asyncHandler(async (req, res) => {
      const device = req.trackingDevice!;
      const result = await ingestPayload(device, req.trackingAuth ?? "device", payloadOf(req, res), mode);
      if (result.refused && !result.trackers) {
        throw forbidden(
          `${device.name} may only report its own position. To forward positions for other trackers, turn on ` +
            "“Relays other trackers” in its GPS settings.",
        );
      }
      res.json({ ok: true, ...result });
    }),
  ];
}

const flatQuery = (req: Request) => req.query as Record<string, unknown>;

// OsmAnd protocol, as Traccar Client and OsmAnd send it: GET or POST.
gpsDeviceRouter.all("/osmand", trackerEndpoint((req) => parseOsmAnd(flatQuery(req), req.body), "own"));
// Traccar server position and event forwarding.
gpsDeviceRouter.post("/traccar", trackerEndpoint((req) => parseTraccarForward(req.body), "forward"));
// Bindex's own batch format.
gpsDeviceRouter.post("/", trackerEndpoint((req) => parseGpsBatch(req.body), "own"));

// --- Session API -----------------------------------------------------------------

export const gpsRouter = Router();

gpsRouter.use((_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.gps && config.features.tracking) return next();
      res.status(404).json({ error: "GPS tracking is switched off on this instance.", code: "feature_disabled" });
    })
    .catch(next);
});

// A malformed id is a record that does not exist, not a database error.
gpsRouter.param("id", (_req, _res, next, value: string) => next(UUID.test(value) ? undefined : notFound("Not found")));

/** Shipment screens need jobs switched on as well. */
const requireJobs: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.jobs) return next();
      res.status(404).json({
        error: "Projects, jobs and shipments are switched off. An administrator can turn them on in Settings.",
        code: "feature_disabled",
      });
    })
    .catch(next);
};

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Use an ISO 8601 date and time");
const time = (s: string | undefined) => (s ? new Date(s) : undefined);
const uuid = z.string().uuid();

gpsRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    const base = env.APP_BASE_URL.replace(/\/+$/, "");
    res.json({
      tileUrl: env.MAP_TILE_URL,
      attribution: env.MAP_ATTRIBUTION,
      maxZoom: env.MAP_MAX_ZOOM,
      maxSpeedMps: env.GPS_MAX_SPEED_MPS,
      batteryLowPct: env.GPS_BATTERY_LOW_PCT,
      jobs: (await getConfig()).features.jobs,
      endpoints: {
        osmand: `${base}/api/device/gps/osmand`,
        traccar: `${base}/api/device/gps/traccar`,
        batch: `${base}/api/device/gps`,
      },
    });
  }),
);

// --- Trackers

gpsRouter.get(
  "/trackers",
  asyncHandler(async (_req, res) => {
    res.json({ trackers: await listTrackers() });
  }),
);

gpsRouter.get(
  "/trackers/:id",
  asyncHandler(async (req, res) => {
    res.json(await getTracker(param(req, "id")));
  }),
);

const trackerSettingsSchema = z.object({
  maxSpeedMps: z.number().positive().max(400).nullable().optional(),
  singleUse: z.boolean().optional(),
  speedUnit: z.enum(SPEED_UNITS as [string, ...string[]]).nullable().optional(),
  relay: z.boolean().optional(),
  batteryLowPct: z.number().int().min(0).max(100).nullable().optional(),
});

// Changes how the instance judges what a tracker reports, so administrators only.
gpsRouter.patch(
  "/trackers/:id/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const patch = parse(trackerSettingsSchema, req.body) as Parameters<typeof updateTrackerSettings>[1];
    res.json(await updateTrackerSettings(param(req, "id"), patch));
  }),
);

const statusSchema = z.object({ status: z.enum(["available", "disposed"]), note: z.string().max(500).nullish() });

gpsRouter.post(
  "/trackers/:id/status",
  asyncHandler(async (req, res) => {
    const { status, note } = parse(statusSchema, req.body);
    res.json(await setTrackerStatus(param(req, "id"), status, actor(req), note));
  }),
);

const trailSchema = z.object({
  from: isoTime.optional(),
  to: isoTime.optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  rejected: z.enum(["true", "false"]).optional(),
});

const DAY = 24 * 60 * 60_000;

gpsRouter.get(
  "/trackers/:id/trail",
  asyncHandler(async (req, res) => {
    const q = parse(trailSchema, req.query);
    const tracker = await getTracker(param(req, "id"));
    const to = time(q.to);
    const from = time(q.from) ?? new Date((to?.getTime() ?? Date.now()) - DAY);
    res.json({
      tracker: { id: tracker.id, name: tracker.name, itemId: tracker.itemId, itemName: tracker.itemName },
      ...(await trackerTrail(tracker.id, { from, to, limit: q.limit, includeRejected: q.rejected === "true" })),
    });
  }),
);

gpsRouter.get(
  "/items/:id/trail",
  asyncHandler(async (req, res) => {
    const q = parse(trailSchema, req.query);
    const to = time(q.to);
    const from = time(q.from) ?? new Date((to?.getTime() ?? Date.now()) - 7 * DAY);
    res.json(await itemTrail(param(req, "id"), { from, to, limit: q.limit }));
  }),
);

// --- Geofences

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #0284c7");
const geofenceSchema = z.object({
  name: z.string().trim().min(1, "Give the geofence a name").max(120),
  kind: z.enum(["circle", "polygon"]),
  // Checked in depth by the service, which says exactly what is wrong.
  geometry: z.object({ type: z.enum(["Point", "Polygon"]), coordinates: z.unknown() }),
  radiusM: z.number().positive().nullish(),
  locationId: uuid.nullish(),
  active: z.boolean().optional(),
  dwellSeconds: z.number().int().min(0).max(86_400).optional(),
  color: hex.nullish(),
  notes: z.string().max(2000).nullish(),
});

gpsRouter.get(
  "/geofences",
  asyncHandler(async (req, res) => {
    res.json({ geofences: await listGeofences({ includeInactive: req.query.all === "true" }) });
  }),
);

gpsRouter.get(
  "/geofences/:id",
  asyncHandler(async (req, res) => {
    res.json(await getGeofence(param(req, "id")));
  }),
);

// A fence can move shipments and items on its own, so drawing one is an
// instance setting.
gpsRouter.post(
  "/geofences",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await createGeofence(parse(geofenceSchema, req.body), actor(req)));
  }),
);

gpsRouter.patch(
  "/geofences/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await updateGeofence(param(req, "id"), parse(geofenceSchema.partial(), req.body), actor(req)));
  }),
);

gpsRouter.delete(
  "/geofences/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await deleteGeofence(param(req, "id"), actor(req));
    res.status(204).end();
  }),
);

const eventsSchema = z.object({
  geofenceId: uuid.optional(),
  deviceId: uuid.optional(),
  shipmentId: uuid.optional(),
  itemId: uuid.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

gpsRouter.get(
  "/events",
  asyncHandler(async (req, res) => {
    res.json(await listGeofenceEvents(parse(eventsSchema, req.query)));
  }),
);

// --- Links: trackers on shipments and vehicles

const linksQuery = z.object({
  deviceId: uuid.optional(),
  shipmentId: uuid.optional(),
  vehicleLocationId: uuid.optional(),
  active: z.enum(["true", "false"]).optional(),
});

gpsRouter.get(
  "/links",
  asyncHandler(async (req, res) => {
    const q = parse(linksQuery, req.query);
    res.json({
      links: await listLinks({
        deviceIds: q.deviceId ? [q.deviceId] : undefined,
        shipmentId: q.shipmentId,
        vehicleLocationId: q.vehicleLocationId,
        active: q.active === "true",
      }),
    });
  }),
);

const linkSchema = z.object({
  deviceId: uuid,
  shipmentId: uuid.nullish(),
  vehicleLocationId: uuid.nullish(),
  originGeofenceId: uuid.nullish(),
  destinationGeofenceId: uuid.nullish(),
});

gpsRouter.post(
  "/links",
  asyncHandler(async (req, res, next) => {
    const input = parse(linkSchema, req.body);
    // Links follow shipments, which only exist with jobs on.
    if (input.shipmentId && !(await getConfig()).features.jobs) {
      next(notFound("Projects, jobs and shipments are switched off."));
      return;
    }
    res.status(201).json(await createLink(input, actor(req)));
  }),
);

gpsRouter.post(
  "/links/:id/end",
  asyncHandler(async (req, res) => {
    res.json(await endLink(param(req, "id"), actor(req)));
  }),
);

// --- Shipments

gpsRouter.get(
  "/shipments/open",
  requireJobs,
  asyncHandler(async (_req, res) => {
    res.json({ shipments: await openShipments() });
  }),
);

gpsRouter.get(
  "/shipments/:id",
  requireJobs,
  asyncHandler(async (req, res) => {
    res.json(await shipmentMap(param(req, "id")));
  }),
);

gpsRouter.post(
  "/shipments/:id/dismiss-prompt",
  requireJobs,
  asyncHandler(async (req, res) => {
    res.json(await dismissPrompt(param(req, "id")));
  }),
);
