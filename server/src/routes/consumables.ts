import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler, parse, param } from "../lib/http";
import { badRequest } from "../lib/errors";
import { currentUser, requireAdmin } from "../auth/middleware";
import { getConfig } from "../services/config";
import { STOCK_REASONS } from "../services/consumables/ledger";
import { describeCodes } from "../services/consumables/resolve";
import {
  checkIntegrity,
  getConsumableDetail,
  listCatalog,
  listMovements,
  locationStock,
  recordCount,
  recordMovement,
  removeConsumable,
  setConsumable,
  type Actor,
} from "../services/consumables/stock";
import {
  createKit,
  getKit,
  listKits,
  listOverdue,
  returnEquipment,
  type KitStatus,
} from "../services/consumables/kits";
import { holderDetail, listHolders } from "../services/consumables/holders";
import { listLowStock } from "../services/consumables/lowstock";
import { usageReport, usageWorkbook } from "../services/consumables/reports";

const uuid = z.string().uuid();
const qty = z.number().finite();
const text = (max: number) => z.string().max(max).nullish();

const settingsSchema = z.object({
  unit: z.string().max(24).nullish(),
  reorderPoint: qty.nonnegative().nullish(),
  reorderQty: qty.nonnegative().nullish(),
  supplier: text(200),
});

const movementSchema = z.object({
  reason: z.enum(STOCK_REASONS),
  itemId: uuid,
  qty: qty.nullish(),
  delta: qty.nullish(),
  countedQty: qty.nullish(),
  locationId: uuid.nullish(),
  toLocationId: uuid.nullish(),
  holderId: uuid.nullish(),
  jobRef: text(120),
  note: text(1000),
});

const countSchema = z.object({
  locationId: uuid,
  lines: z.array(z.object({ itemId: uuid, countedQty: qty })).min(1).max(1000),
  note: text(1000),
});

const lineSchema = z.object({ itemId: uuid, unitId: uuid.nullish() });

const kitSchema = z.object({
  holderId: uuid,
  expectedReturnAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date")
    .nullish(),
  jobRef: text(120),
  note: text(1000),
  lines: z.array(lineSchema).min(1).max(500),
});

const returnSchema = z.object({
  holderId: uuid.nullish(),
  lines: z.array(lineSchema).min(1).max(500),
});

const resolveSchema = z.object({ codes: z.array(z.string().max(512)).min(1).max(1000) });

/**
 * Administrators are the session users with the admin role. An API key never
 * is, the same rule requireAdmin applies to instance-wide changes.
 */
function actorOf(req: Request): Actor {
  const user = currentUser(req);
  return { oid: user.oid, admin: !req.apiKeyUser && req.session.user?.role === "admin" };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function dateParam(v: unknown, name: string): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw badRequest(`${name} is not a date. Use a form such as 2026-09-01.`);
  return d;
}

function idParam(v: unknown, name: string): string | undefined {
  const s = str(v);
  if (s && !uuid.safeParse(s).success) throw badRequest(`${name} has to be an id.`);
  return s;
}

/** Start of today on the server, the default for "since" on the end-of-day screen. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** A report range from query parameters; the end date is inclusive of its whole day. */
function rangeOf(req: Request): { from: Date; to: Date } {
  const from = dateParam(req.query.from, "from");
  const toRaw = str(req.query.to);
  let to = dateParam(req.query.to, "to");
  if (to && toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw)) to = new Date(to.getTime() + 86_400_000);
  const end = to ?? new Date();
  return { from: from ?? new Date(end.getTime() - 30 * 86_400_000), to: end };
}

export const consumablesRouter = Router();

// ---- Catalog and settings ----------------------------------------------------

consumablesRouter.get(
  "/catalog",
  asyncHandler(async (req, res) => {
    res.json(await listCatalog({ q: str(req.query.q) }));
  }),
);

consumablesRouter.get(
  "/items/:itemId",
  asyncHandler(async (req, res) => {
    res.json(await getConsumableDetail(param(req, "itemId")));
  }),
);

consumablesRouter.put(
  "/items/:itemId",
  asyncHandler(async (req, res) => {
    await setConsumable(param(req, "itemId"), parse(settingsSchema, req.body));
    res.json(await getConsumableDetail(param(req, "itemId")));
  }),
);

consumablesRouter.delete(
  "/items/:itemId",
  asyncHandler(async (req, res) => {
    await removeConsumable(param(req, "itemId"));
    res.status(204).end();
  }),
);

// ---- Scanning -----------------------------------------------------------------

// Resolve many scanned codes at once, for the kit and return scan sessions.
consumablesRouter.post(
  "/resolve",
  asyncHandler(async (req, res) => {
    const { codes } = parse(resolveSchema, req.body);
    res.json(await describeCodes(codes));
  }),
);

// One scanned code, with the consumable's levels when it is one.
consumablesRouter.get(
  "/lookup",
  asyncHandler(async (req, res) => {
    const code = str(req.query.code)?.trim();
    if (!code) throw badRequest("Scan or type a code to look up.");
    const [match] = await describeCodes([code]);
    const consumable =
      match?.kind === "item" && match.consumable
        ? ((await listCatalog({ itemIds: [match.itemId!] }))[0] ?? null)
        : null;
    res.json({ match: match ?? null, consumable });
  }),
);

// ---- Stock movements ------------------------------------------------------------

consumablesRouter.post(
  "/movements",
  asyncHandler(async (req, res) => {
    const body = parse(movementSchema, req.body);
    res.status(201).json(await recordMovement(body, actorOf(req)));
  }),
);

consumablesRouter.get(
  "/movements",
  asyncHandler(async (req, res) => {
    const reason = str(req.query.reason);
    if (reason && !STOCK_REASONS.includes(reason as never)) {
      throw badRequest(`reason has to be one of ${STOCK_REASONS.join(", ")}.`);
    }
    res.json(
      await listMovements({
        itemId: idParam(req.query.itemId, "itemId"),
        holderId: idParam(req.query.holderId, "holderId"),
        locationId: idParam(req.query.locationId, "locationId"),
        reason: reason as (typeof STOCK_REASONS)[number] | undefined,
        from: dateParam(req.query.from, "from"),
        to: dateParam(req.query.to, "to"),
        limit: Math.min(Number(req.query.limit) || 50, 500),
        offset: Math.max(Number(req.query.offset) || 0, 0),
      }),
    );
  }),
);

consumablesRouter.post(
  "/counts",
  asyncHandler(async (req, res) => {
    const { locationId, lines, note } = parse(countSchema, req.body);
    res.status(201).json(await recordCount(locationId, lines, actorOf(req), note));
  }),
);

consumablesRouter.get(
  "/locations/:id",
  asyncHandler(async (req, res) => {
    res.json(await locationStock(param(req, "id")));
  }),
);

consumablesRouter.get(
  "/low-stock",
  asyncHandler(async (_req, res) => {
    res.json(await listLowStock());
  }),
);

// Levels against the movement history. Empty means they agree.
consumablesRouter.get(
  "/integrity",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const mismatches = await checkIntegrity();
    res.json({ ok: mismatches.length === 0, mismatches });
  }),
);

// ---- Holders --------------------------------------------------------------------

consumablesRouter.get(
  "/holders",
  asyncHandler(async (_req, res) => {
    res.json(await listHolders());
  }),
);

consumablesRouter.get(
  "/holders/:id",
  asyncHandler(async (req, res) => {
    const since = dateParam(req.query.since, "since") ?? startOfToday();
    res.json(await holderDetail(param(req, "id"), since));
  }),
);

// ---- Equipment kits ---------------------------------------------------------------

const KIT_STATUSES: KitStatus[] = ["open", "closed", "overdue", "all"];

consumablesRouter.post(
  "/kits",
  asyncHandler(async (req, res) => {
    const body = parse(kitSchema, req.body);
    const result = await createKit(
      { ...body, expectedReturnAt: body.expectedReturnAt ? new Date(body.expectedReturnAt) : null },
      actorOf(req),
    );
    res.status(201).json(result);
  }),
);

consumablesRouter.get(
  "/kits",
  asyncHandler(async (req, res) => {
    const status = (str(req.query.status) ?? "open") as KitStatus;
    if (!KIT_STATUSES.includes(status)) {
      throw badRequest(`status has to be one of ${KIT_STATUSES.join(", ")}.`);
    }
    res.json(await listKits({ status, holderId: idParam(req.query.holderId, "holderId") }));
  }),
);

consumablesRouter.get(
  "/kits/overdue",
  asyncHandler(async (_req, res) => {
    res.json(await listOverdue());
  }),
);

consumablesRouter.get(
  "/kits/:id",
  asyncHandler(async (req, res) => {
    res.json(await getKit(param(req, "id")));
  }),
);

consumablesRouter.post(
  "/returns",
  asyncHandler(async (req, res) => {
    res.json(await returnEquipment(parse(returnSchema, req.body), actorOf(req)));
  }),
);

// ---- Reports ------------------------------------------------------------------------

consumablesRouter.get(
  "/reports/usage",
  asyncHandler(async (req, res) => {
    res.json(await usageReport(rangeOf(req)));
  }),
);

consumablesRouter.get(
  "/reports/usage.xlsx",
  asyncHandler(async (req, res) => {
    const range = rangeOf(req);
    const xlsx = await usageWorkbook(range, (await getConfig()).currency);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="supplies-usage-${day(range.from)}-to-${day(new Date(range.to.getTime() - 1))}.xlsx"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(xlsx);
  }),
);
