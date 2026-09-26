import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { currentUser, requireAdmin } from "../auth/middleware";
import { getConfig } from "../services/config";
import { MAX_BATCH, VIA_PATTERN } from "../services/jobs-core";
import * as placement from "../services/placement";

/**
 * /api/placement: where each thing on a job goes, and whether it got there.
 * The whole set answers 404 while placement (or jobs, which it builds on) is
 * switched off, so a disabled feature is disabled for scripts too.
 */

export const placementRouter = Router();

placementRouter.use(
  asyncHandler(async (_req, _res, next) => {
    const { features } = await getConfig();
    if (!features.placement || !features.jobs) {
      throw new HttpError(
        404,
        "feature_disabled",
        features.jobs
          ? "Placement guidance is switched off. An administrator can turn it on in Settings."
          : "Placement guidance needs projects, jobs and shipments. An administrator can turn both on in Settings.",
      );
    }
    next();
  }),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A malformed id is a record that does not exist, not a database error.
for (const name of ["id", "locationId", "deviceId"]) {
  placementRouter.param(name, (_req, _res, next, value: string) => next(UUID.test(value) ? undefined : notFound("Not found")));
}

const who = (req: Request): placement.Who => {
  const user = currentUser(req);
  return { userOid: user.oid, name: user.name ?? null };
};

const q = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

function qId(req: Request, name: string): string | undefined {
  const v = q(req, name);
  if (v === undefined || UUID.test(v)) return v;
  throw badRequest(`${name} must be an id.`);
}

const qBool = (req: Request, name: string) => q(req, name) === "true";

const uuid = z.string().uuid();
const via = z.string().regex(VIA_PATTERN, "Use lower_snake_case, such as scan or sweep").optional();
const ids = z.array(uuid).min(1, "Pick at least one line").max(MAX_BATCH);
const code = z.string().trim().min(1, "Scan or type a code").max(512);

// --- Jobs and progress ----------------------------------------------------------------

placementRouter.get(
  "/jobs",
  asyncHandler(async (_req, res) => {
    res.json({ jobs: await placement.listPlacementJobs() });
  }),
);

placementRouter.get(
  "/jobs/:id/progress",
  asyncHandler(async (req, res) => {
    res.json(await placement.jobProgress(param(req, "id")));
  }),
);

placementRouter.get(
  "/jobs/:id/observations",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(q(req, "limit") ?? 100) || 100, 1), 1000);
    const tree = await placement.loadTree();
    res.json({ observations: await placement.listObservations(param(req, "id"), tree, limit) });
  }),
);

const colorsSchema = z.object({
  colors: z.record(
    z.string().trim().min(1).max(60),
    z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #1d4ed8"),
  ),
});

placementRouter.put(
  "/jobs/:id/floor-colors",
  asyncHandler(async (req, res) => {
    const { colors } = parse(colorsSchema, req.body);
    res.json({ colors: await placement.setFloorColors(param(req, "id"), colors) });
  }),
);

// --- Scanning ------------------------------------------------------------------------------

const lookupSchema = z.object({
  code,
  shipmentId: uuid.nullish(),
  /** False to only look: nothing is flagged or noted. */
  record: z.boolean().optional(),
});

// "Where does this go?" One label, one card.
placementRouter.post(
  "/jobs/:id/lookup",
  asyncHandler(async (req, res) => {
    const body = parse(lookupSchema, req.body);
    res.json(await placement.lookup(param(req, "id"), body.code, { ...body, who: who(req) }));
  }),
);

const placeSchema = z.object({ jobItemIds: ids, code: z.string().max(512).nullish(), via });

placementRouter.post(
  "/jobs/:id/place",
  asyncHandler(async (req, res) => {
    const body = parse(placeSchema, req.body);
    res.json(await placement.placeLines(param(req, "id"), body.jobItemIds, { ...body, who: who(req) }));
  }),
);

const missingSchema = z.object({ jobItemIds: ids, note: z.string().max(500).nullish() });

placementRouter.post(
  "/jobs/:id/mark-missing",
  asyncHandler(async (req, res) => {
    const body = parse(missingSchema, req.body);
    res.json(await placement.markMissing(param(req, "id"), body.jobItemIds, who(req), body.note));
  }),
);

const sweepSchema = z.object({
  locationId: uuid,
  codes: z.array(z.string().max(512)).min(1, "Read at least one tag").max(MAX_BATCH),
  nested: z.boolean().optional(),
  via,
});

placementRouter.post(
  "/jobs/:id/sweep",
  asyncHandler(async (req, res) => {
    const body = parse(sweepSchema, req.body);
    res.json(await placement.sweep(param(req, "id"), { ...body, who: who(req) }));
  }),
);

placementRouter.get(
  "/jobs/:id/rooms/:locationId",
  asyncHandler(async (req, res) => {
    res.json(
      await placement.roomStatus(param(req, "id"), param(req, "locationId"), { nested: qBool(req, "nested") }),
    );
  }),
);

placementRouter.get(
  "/jobs/:id/kiosk",
  asyncHandler(async (req, res) => {
    const since = q(req, "since");
    if (since !== undefined && !/^\d+$/.test(since)) throw badRequest("since must be the cursor from the last answer.");
    res.json(
      await placement.kioskFeed(param(req, "id"), {
        deviceId: qId(req, "deviceId"),
        locationId: qId(req, "locationId"),
        since: since === undefined ? undefined : Number(since),
      }),
    );
  }),
);

// --- Destination rules ---------------------------------------------------------------------

const rootsSchema = {
  overwrite: z.boolean().optional(),
  originRootId: uuid.nullish(),
  destinationRootId: uuid.nullish(),
};

placementRouter.get(
  "/jobs/:id/proposals",
  asyncHandler(async (req, res) => {
    // An empty parameter means "no root"; a missing one means "the job's own".
    const root = (name: string) => (name in req.query ? (qId(req, name) ?? null) : undefined);
    res.json(
      await placement.proposals(param(req, "id"), {
        overwrite: qBool(req, "overwrite"),
        originRootId: root("originRootId"),
        destinationRootId: root("destinationRootId"),
      }),
    );
  }),
);

placementRouter.post(
  "/jobs/:id/proposals/apply",
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ ...rootsSchema, jobItemIds: z.array(uuid).max(20_000).optional() }), req.body);
    res.json(await placement.applyProposals(param(req, "id"), body));
  }),
);

placementRouter.get(
  "/jobs/:id/room-map",
  asyncHandler(async (req, res) => {
    res.json({ rows: await placement.getRoomMap(param(req, "id")) });
  }),
);

const roomMapSchema = z.object({
  rows: z.array(z.object({ originLocationId: uuid, destinationLocationId: uuid })).max(2000),
});

placementRouter.put(
  "/jobs/:id/room-map",
  asyncHandler(async (req, res) => {
    const { rows } = parse(roomMapSchema, req.body);
    res.json({ rows: await placement.setRoomMap(param(req, "id"), rows) });
  }),
);

// --- Readers ---------------------------------------------------------------------------------

placementRouter.get(
  "/readers",
  asyncHandler(async (_req, res) => {
    res.json(await placement.readersStatus());
  }),
);

// Which readers confirm placement is instance configuration, like the devices themselves.
placementRouter.patch(
  "/readers/:deviceId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ confirm: z.boolean().optional(), nested: z.boolean().optional() }), req.body);
    await placement.setReaderPlacement(param(req, "deviceId"), body);
    res.json(await placement.readersStatus());
  }),
);
