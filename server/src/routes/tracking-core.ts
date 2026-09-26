import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { requireAdmin } from "../auth/middleware";
import { getConfig } from "../services/config";
import { TRACKING_DEVICE_KINDS } from "../db/schema";
import {
  createDevice,
  deleteDevice,
  getDevice,
  getFeed,
  getItemPositions,
  listDevices,
  listItemSightings,
  listPresent,
  revokeDeviceToken,
  rotateDeviceToken,
  updateDevice,
  type TrackingDeviceKind,
} from "../services/tracking";

/**
 * Session routes for the tracking core: the device registry, and the read
 * side (positions, sightings, presence, live feed). Hardware posts to
 * /api/device instead; see routes/device.ts.
 */
export const trackingRouter = Router();

// The feature switch removes the API along with the screens.
const requireTrackingFeature: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.tracking) return next();
      res.status(404).json({
        error: "Readers, beacons and trackers are switched off on this instance.",
        code: "feature_disabled",
      });
    })
    .catch(next);
};
trackingRouter.use(requireTrackingFeature);

const antennaPort = z.string().regex(/^\d{1,3}$/, "Antenna ports are numbers, such as 1 or 4");

// Known keys are checked; unknown ones pass through, because other features
// (BLE, GPS) keep their own device settings in the same object.
const settingsSchema = z
  .object({
    rssiFloor: z.number().min(-150).max(50).nullable().optional(),
    dedupSeconds: z.number().min(0).max(86_400).nullable().optional(),
    antennaZones: z.record(antennaPort, z.string().uuid()).optional(),
    portal: z
      .object({
        sides: z.record(antennaPort, z.enum(["inside", "outside"])),
        windowSeconds: z.number().min(0.1).max(3600).optional(),
        inLocationId: z.string().uuid().nullable().optional(),
        outLocationId: z.string().uuid().nullable().optional(),
      })
      .optional(),
  })
  .passthrough();

const deviceFields = {
  kind: z.enum(TRACKING_DEVICE_KINDS),
  name: z.string().trim().min(1, "Give the device a name").max(120),
  externalId: z.string().trim().max(200).nullish(),
  locationId: z.string().uuid().nullish(),
  itemId: z.string().uuid().nullish(),
  unitId: z.string().uuid().nullish(),
  updatesLocation: z.boolean().optional(),
  settings: settingsSchema.optional(),
  disabled: z.boolean().optional(),
};
const createSchema = z.object({ ...deviceFields, issueToken: z.boolean().optional() });
const updateSchema = z.object(deviceFields).partial();

const kindList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter((k): k is TrackingDeviceKind => (TRACKING_DEVICE_KINDS as readonly string[]).includes(k)),
  );

// Listing is open to every signed-in person: the audit screen's reader picker
// needs it. Tokens are never included, only whether one is set.
trackingRouter.get(
  "/devices",
  asyncHandler(async (req, res) => {
    const kinds = kindList.parse(typeof req.query.kind === "string" ? req.query.kind : undefined);
    res.json({ devices: await listDevices({ kinds }) });
  }),
);

trackingRouter.get(
  "/devices/:id",
  asyncHandler(async (req, res) => {
    res.json(await getDevice(param(req, "id")));
  }),
);

// Returns the ingest token in the clear: the only time it is shown.
trackingRouter.post(
  "/devices",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { issueToken, ...input } = parse(createSchema, req.body);
    res.status(201).json(await createDevice(input, { issueToken }));
  }),
);

trackingRouter.patch(
  "/devices/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await updateDevice(param(req, "id"), parse(updateSchema, req.body)));
  }),
);

trackingRouter.delete(
  "/devices/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await deleteDevice(param(req, "id"));
    res.status(204).end();
  }),
);

trackingRouter.post(
  "/devices/:id/rotate-token",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await rotateDeviceToken(param(req, "id")));
  }),
);

trackingRouter.delete(
  "/devices/:id/token",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await revokeDeviceToken(param(req, "id")));
  }),
);

trackingRouter.get(
  "/items/:id/positions",
  asyncHandler(async (req, res) => {
    res.json({ positions: await getItemPositions(param(req, "id")) });
  }),
);

const pageSchema = z.object({
  before: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

trackingRouter.get(
  "/items/:id/sightings",
  asyncHandler(async (req, res) => {
    const { before, limit } = parse(pageSchema, req.query);
    res.json(await listItemSightings(param(req, "id"), { before, limit }));
  }),
);

const presentSchema = z.object({
  within: z.coerce.number().int().min(1).max(525_600).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

trackingRouter.get(
  "/locations/:id/present",
  asyncHandler(async (req, res) => {
    const { within, limit } = parse(presentSchema, req.query);
    res.json({ present: await listPresent(param(req, "id"), { withinMinutes: within, limit }) });
  }),
);

const feedSchema = z.object({
  since: z.coerce.number().int().min(0).optional(),
  deviceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

trackingRouter.get(
  "/feed",
  asyncHandler(async (req, res) => {
    res.json(await getFeed(parse(feedSchema, req.query)));
  }),
);
