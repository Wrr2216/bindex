import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { badRequest, notFound } from "../lib/errors";
import { env } from "../env";
import { currentUser, requireAdmin } from "../auth/middleware";
import { getConfig } from "../services/config";
import { getDeviceRow, presentedToken, requireDevice } from "../services/tracking";
import { deviceBody } from "./device";
import {
  AdapterError,
  parseBleGeneric,
  parseIngics,
  parseKontakt,
  parseMinew,
  parsePhone,
  parseTeltonika,
  type GatewayPayload,
} from "../services/ble/adapters";
import { calibrations, engine, processGatewayReport } from "../services/ble/ingest";
import { processPhoneReport, roomForUser } from "../services/ble/phones";
import { createBleDevice, findOrCreateGateway, updateBleDevice } from "../services/ble/devices";
import {
  heardList,
  itemPresence,
  listBleDevices,
  lowBatteries,
  notSeen,
  occupancy,
} from "../services/ble/queries";
import { listAlerts } from "../services/ble/state";
import { mqttStatus } from "../services/ble/mqtt";
import { bleSettings, presenceConfig, workSchedule } from "../services/ble/config";
import { summarizeCalibration } from "../services/ble/calibrate";
import { pool } from "../db/client";

// ---------------------------------------------------------------------------
// Hardware: /api/device/ble (token auth, before the session guard)
// ---------------------------------------------------------------------------

/**
 * Where BLE gateways and phones post. Mounted in index.ts under /api/device/ble,
 * next to the tracking core's device router and before the session guard.
 * Posting BLE reads to the tracking core's /api/device/reads also works, but
 * each read then takes the gateway's own zone, with no smoothing between
 * gateways; these endpoints run the presence engine.
 */
export const bleDeviceRouter = Router();
bleDeviceRouter.use(deviceBody);

const requireBleOn: RequestHandler = (_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.ble) return next();
      res.status(503).json({
        error: "Bluetooth beacons are switched off on this instance. Turn them on in Settings, Features.",
        code: "ble_disabled",
      });
    })
    .catch(next);
};

const isIngestToken = (req: Request) => {
  const token = presentedToken(req);
  return Boolean(token) && env.ingestTokens.includes(token);
};

function gatewayEndpoint(adapter: (body: unknown) => GatewayPayload): RequestHandler[] {
  const payloadOf = (req: Request, res: Response): GatewayPayload => {
    if (!res.locals.blePayload) {
      try {
        res.locals.blePayload = adapter(req.body);
      } catch (err) {
        if (err instanceof AdapterError) throw badRequest(err.message);
        throw err;
      }
    }
    return res.locals.blePayload as GatewayPayload;
  };

  // A post made with the shared INGEST_TOKEN names its gateway in the payload
  // (or ?reader=); find it, or register it on its first post, before the
  // tracking core's device check looks it up by that id.
  const ingestGateway: RequestHandler = asyncHandler(async (req, res, next) => {
    if (!isIngestToken(req)) return next();
    const reader = typeof req.query.reader === "string" && req.query.reader.trim() ? req.query.reader : undefined;
    const id = payloadOf(req, res).gatewayId ?? reader;
    if (!id) {
      throw badRequest(
        "With INGEST_TOKEN, name the gateway: its id in the payload, or ?reader=<serial or MAC>. Or send the gateway's own token.",
      );
    }
    res.locals.bleGatewayExternalId = (await findOrCreateGateway(id)).externalId;
    next();
  });

  return [
    requireBleOn,
    ingestGateway,
    requireDevice(["ble_gateway"], { readerId: (_req, res) => res.locals.bleGatewayExternalId as string | undefined }),
    asyncHandler(async (req, res) => {
      const device = req.trackingDevice!;
      const result = await processGatewayReport(device, payloadOf(req, res));
      res.json({ ok: true, deviceId: device.id, ...result });
    }),
  ];
}

// Bindex's own format, a superset of /api/device/reads. The reference gateway posts here.
bleDeviceRouter.post("/reads", gatewayEndpoint(parseBleGeneric));
// Minew G1 / MG3 JSON upload format.
bleDeviceRouter.post("/minew", gatewayEndpoint(parseMinew));
// Ingics iGS report lines ($GPRP,...).
bleDeviceRouter.post("/ingics", gatewayEndpoint(parseIngics));
// Kontakt.io-style presence and telemetry events.
bleDeviceRouter.post("/kontakt", gatewayEndpoint(parseKontakt));
// Teltonika trackers' beacon records, decoded to JSON by a forwarder.
bleDeviceRouter.post("/teltonika", gatewayEndpoint(parseTeltonika));

// A phone reporting the room beacons it hears. It must use its own token:
// the shared INGEST_TOKEN cannot say whose phone it is.
bleDeviceRouter.post(
  "/phone",
  requireBleOn,
  (req, res, next) => {
    if (!isIngestToken(req)) return next();
    res.status(403).json({
      error: "A phone posts with its own token, so Bindex knows whose room it is. Register it on the Bluetooth page.",
      code: "device_token_required",
    });
  },
  requireDevice(["mobile"]),
  asyncHandler(async (req, res) => {
    let payload: GatewayPayload;
    try {
      payload = parsePhone(req.body);
    } catch (err) {
      if (err instanceof AdapterError) throw badRequest(err.message);
      throw err;
    }
    const device = req.trackingDevice!;
    res.json({ ok: true, deviceId: device.id, ...(await processPhoneReport(device, payload)) });
  }),
);

// ---------------------------------------------------------------------------
// Session API: /api/ble
// ---------------------------------------------------------------------------

export const bleRouter = Router();

// The feature switch removes the API along with the screens.
bleRouter.use((_req, res, next) => {
  getConfig()
    .then((config) => {
      if (config.features.ble) return next();
      res.status(404).json({ error: "Bluetooth beacons are switched off on this instance.", code: "feature_disabled" });
    })
    .catch(next);
});

bleRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query<{ kind: string; n: string }>(
      `SELECT kind, count(*) AS n FROM tracking_devices
        WHERE kind IN ('ble_gateway', 'ble_beacon', 'ble_tag', 'mobile') GROUP BY kind`,
    );
    const count = (k: string) => Number(rows.find((r) => r.kind === k)?.n ?? 0);
    const hours = workSchedule();
    const p = presenceConfig();
    res.json({
      presence: {
        windowSeconds: p.windowMs / 1000,
        smoothing: p.smoothing,
        hysteresisDb: p.hysteresisDb,
        dwellSeconds: p.dwellMs / 1000,
        minSamples: p.minSamples,
      },
      missingMinutes: env.BLE_MISSING_MINUTES,
      storeSeconds: env.BLE_STORE_SECONDS,
      phoneRoomSeconds: env.BLE_PHONE_ROOM_SECONDS,
      batteryLowPct: env.BLE_BATTERY_LOW_PCT,
      workHours: {
        configured: Boolean(hours.parsed),
        text: env.BLE_WORK_HOURS.trim() || null,
        error: hours.error,
        timeZone: hours.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      mqtt: mqttStatus(),
      counts: { gateways: count("ble_gateway"), beacons: count("ble_beacon"), tags: count("ble_tag"), phones: count("mobile") },
      engine: { tags: engine.size },
    });
  }),
);

const flag = z.enum(["true", "false", "1", "0"]).optional();
const isOn = (v: string | undefined) => v === "true" || v === "1";

bleRouter.get(
  "/occupancy",
  asyncHandler(async (_req, res) => {
    res.json({ zones: await occupancy() });
  }),
);

bleRouter.get(
  "/not-seen",
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ hours: z.coerce.number().positive().max(24 * 365).optional() }), req.query);
    const hours = q.hours ?? 24;
    res.json({ hours, tags: await notSeen(hours) });
  }),
);

bleRouter.get(
  "/battery",
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ below: z.coerce.number().min(0).max(100).optional() }), req.query);
    const below = q.below ?? env.BLE_BATTERY_LOW_PCT;
    res.json({ below, devices: await lowBatteries(below) });
  }),
);

bleRouter.get(
  "/alerts",
  asyncHandler(async (req, res) => {
    const q = parse(
      z.object({
        open: flag,
        limit: z.coerce.number().int().min(1).max(500).optional(),
        before: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const alerts = await listAlerts({ ...q, open: isOn(q.open) });
    res.json({ alerts, next: alerts.length === (q.limit ?? 100) ? alerts[alerts.length - 1]!.id : null });
  }),
);

bleRouter.get(
  "/items/:id/presence",
  asyncHandler(async (req, res) => {
    res.json(await itemPresence(param(req, "id")));
  }),
);

// Where the signed-in person's phone last placed them, for prefilling a location.
bleRouter.get(
  "/me/room",
  asyncHandler(async (req, res) => {
    res.json({ room: await roomForUser(currentUser(req).oid) });
  }),
);

// Everything below is the device registry and calibration, for administrators.

bleRouter.get(
  "/devices",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ devices: await listBleDevices() });
  }),
);

const BLE_KINDS = ["ble_gateway", "ble_beacon", "ble_tag", "mobile"] as const;

const bleOptions = z
  .object({
    rssiOffset: z.number().min(-40).max(40).nullable().optional(),
    txPower: z.number().min(-120).max(20).nullable().optional(),
    bleMac: z.string().trim().max(40).nullable().optional(),
    missingMinutes: z.number().min(0).max(525_600).nullable().optional(),
    afterHoursAlert: z.boolean().nullable().optional(),
    batteryFullMv: z.number().int().min(500).max(20_000).nullable().optional(),
    batteryEmptyMv: z.number().int().min(0).max(20_000).nullable().optional(),
    userOid: z.string().trim().max(300).nullable().optional(),
    userName: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

const deviceFields = {
  kind: z.enum(BLE_KINDS),
  name: z.string().trim().min(1, "Give the device a name").max(120),
  externalId: z.string().trim().max(200).nullish(),
  locationId: z.string().uuid().nullish(),
  itemId: z.string().uuid().nullish(),
  unitId: z.string().uuid().nullish(),
  updatesLocation: z.boolean().optional(),
  disabled: z.boolean().optional(),
  ble: bleOptions.optional(),
};

// Returns a gateway's or phone's ingest token in the clear: the only time it is shown.
bleRouter.post(
  "/devices",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await createBleDevice(parse(z.object(deviceFields), req.body)));
  }),
);

bleRouter.patch(
  "/devices/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const existing = await getDeviceRow(id);
    if (!(BLE_KINDS as readonly string[]).includes(existing.kind)) {
      throw badRequest("That device is not a Bluetooth device. Edit it in Settings, Readers and devices.");
    }
    res.json(await updateBleDevice(id, parse(z.object(deviceFields).partial(), req.body)));
  }),
);

bleRouter.get(
  "/heard",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ gatewayId: z.string().uuid().optional(), all: flag }), req.query);
    res.json({ heard: heardList({ gatewayId: q.gatewayId, beaconsOnly: !isOn(q.all) }) });
  }),
);

const calibrationStart = z.object({
  tagId: z.string().uuid(),
  locationId: z.string().uuid(),
  seconds: z.number().int().min(10).max(600).optional(),
});

bleRouter.post(
  "/calibrations",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = parse(calibrationStart, req.body);
    const tag = await getDeviceRow(input.tagId);
    if (tag.kind !== "ble_tag") throw badRequest("Calibrate with a Bluetooth tag: pick one registered as a tag.");
    const { rows } = await pool.query("SELECT 1 FROM locations WHERE id = $1", [input.locationId]);
    if (!rows.length) throw badRequest("That room no longer exists. Pick it again.");
    const session = calibrations.start({
      tagKey: tag.id,
      tagName: tag.name,
      locationId: input.locationId,
      durationMs: (input.seconds ?? 60) * 1000,
    });
    res.status(201).json(await calibrationView(session.id));
  }),
);

async function calibrationView(id: string) {
  const session = calibrations.get(id);
  if (!session) throw notFound("That calibration has finished and been forgotten. Start another.");
  const { rows } = await pool.query(
    `SELECT id, name, location_id, settings FROM tracking_devices WHERE kind = 'ble_gateway'`,
  );
  const gateways = rows.map((g) => ({
    id: g.id as string,
    name: g.name as string,
    zoneId: (g.location_id as string) ?? null,
    offset: bleSettings(g.settings).rssiOffset,
  }));
  const { rows: loc } = await pool.query<{ name: string }>("SELECT name FROM locations WHERE id = $1", [
    session.locationId,
  ]);
  const now = Date.now();
  return {
    id: session.id,
    tagId: session.tagKey,
    tagName: session.tagName,
    locationId: session.locationId,
    locationName: loc[0]?.name ?? null,
    startedAt: new Date(session.startedAt).toISOString(),
    endsAt: new Date(session.endsAt).toISOString(),
    done: now >= session.endsAt,
    readings: [...session.samples.values()].reduce((n, s) => n + s.length, 0),
    summary: summarizeCalibration(session.samples, gateways, session.locationId, presenceConfig().hysteresisDb),
  };
}

bleRouter.get(
  "/calibrations/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await calibrationView(param(req, "id")));
  }),
);

bleRouter.post(
  "/calibrations/:id/stop",
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!calibrations.stop(param(req, "id"))) throw notFound("That calibration has finished and been forgotten.");
    res.json(await calibrationView(param(req, "id")));
  }),
);

bleRouter.delete(
  "/calibrations/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    calibrations.cancel(param(req, "id"));
    res.status(204).end();
  }),
);
