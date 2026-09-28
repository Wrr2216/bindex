import { Router } from "express";
import { z } from "zod";
import { asyncHandler, param, parse } from "../lib/http";
import { currentUser, requireAdmin } from "../auth/middleware";
import { getTagSettings, updateTagSettings } from "../services/tag-commissioning/settings";
import { bindTag, getItemTags, lookupCode, summarize } from "../services/tag-commissioning/tags";
import {
  createFromLegacySticker,
  nextLegacyNumber,
  removeItemLegacyTag,
  setItemLegacyTag,
} from "../services/tag-commissioning/legacy";
import { buildEncodeFile, MAX_ENCODE } from "../services/tag-commissioning/encode";
import { ZPL_DPIS } from "../services/tag-commissioning/zpl";
import { tierReport } from "../services/tag-commissioning/report";
import { parseLegacyTag } from "../services/tag-commissioning/normalize";
import {
  createSession,
  finishSession,
  getSession,
  listSessions,
  recordRead,
  skipEntry,
  undoLast,
} from "../services/tag-commissioning/sessions";

export const tagCommissioningRouter = Router();

const uuid = z.string().uuid();
const tagType = z.enum(["rfid", "nfc"]);

// ---- Settings -------------------------------------------------------------

tagCommissioningRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json(await getTagSettings());
  }),
);

const settingsSchema = z.object({
  gs1CompanyPrefix: z
    .string()
    .trim()
    .regex(/^(\d{6,12})?$/, "A GS1 company prefix is 6 to 12 digits. Leave it empty to use the private scheme.")
    .optional(),
  palette: z
    .array(
      z.object({
        name: z.string().trim().regex(/^[A-Za-z]{1,20}$/, "A colour name is one word of letters, such as RED."),
        hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #dc2626."),
      }),
    )
    .min(1, "Keep at least one colour.")
    .max(32)
    .refine(
      (list) => new Set(list.map((c) => c.name.toUpperCase())).size === list.length,
      "Each colour name can appear once.",
    )
    .optional(),
});

tagCommissioningRouter.put(
  "/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await updateTagSettings(parse(settingsSchema, req.body)));
  }),
);

// ---- Looking things up ----------------------------------------------------

// What a code would open, without recording a scan. The phone's tap lookup
// uses it to choose between opening a record and offering to bind.
tagCommissioningRouter.get(
  "/resolve",
  asyncHandler(async (req, res) => {
    const code = parse(z.string().min(1).max(512), req.query.code);
    res.json(await lookupCode(code));
  }),
);

const summarySchema = z.object({ itemIds: z.array(uuid).max(500) });

// Tier and sticker for a page of items, for list rows and cards.
tagCommissioningRouter.post(
  "/summary",
  asyncHandler(async (req, res) => {
    const { itemIds } = parse(summarySchema, req.body);
    res.json(await summarize(itemIds));
  }),
);

tagCommissioningRouter.get(
  "/items/:id",
  asyncHandler(async (req, res) => {
    res.json(await getItemTags(parse(uuid, param(req, "id"))));
  }),
);

const bindSchema = z.object({
  type: tagType,
  value: z.string().trim().min(1).max(512),
  unitId: uuid.nullish(),
});

tagCommissioningRouter.post(
  "/items/:id/bind",
  asyncHandler(async (req, res) => {
    const itemId = parse(uuid, param(req, "id"));
    const body = parse(bindSchema, req.body);
    const result = await bindTag(itemId, body, currentUser(req).oid);
    res.status(result.created ? 201 : 200).json(result);
  }),
);

// ---- Legacy stickers ------------------------------------------------------

const legacySchema = z.object({
  color: z.string().trim().min(1).max(20),
  lot: z.string().trim().max(20).nullish(),
  number: z.number().int().nonnegative().max(999_999_999_999_999),
});

tagCommissioningRouter.put(
  "/items/:id/legacy",
  asyncHandler(async (req, res) => {
    const itemId = parse(uuid, param(req, "id"));
    res.json(await setItemLegacyTag(itemId, parse(legacySchema, req.body), currentUser(req).oid));
  }),
);

tagCommissioningRouter.delete(
  "/items/:id/legacy",
  asyncHandler(async (req, res) => {
    await removeItemLegacyTag(parse(uuid, param(req, "id")), currentUser(req).oid);
    res.status(204).end();
  }),
);

// Preview how a typed sticker will be stored, for the entry forms.
tagCommissioningRouter.get(
  "/legacy/parse",
  asyncHandler(async (req, res) => {
    const text = parse(z.string().max(100), req.query.text ?? "");
    res.json({ tag: parseLegacyTag(text) });
  }),
);

tagCommissioningRouter.get(
  "/legacy/next",
  asyncHandler(async (req, res) => {
    const q = parse(
      z.object({
        color: z.string().trim().min(1).max(20),
        lot: z.string().trim().max(20).optional(),
        after: z.coerce.number().int().min(-1).optional(),
      }),
      req.query,
    );
    const after = q.after ?? 0;
    const tag = parseLegacyTag([q.color, q.lot, "0"].filter(Boolean).join(" "));
    if (!tag) {
      res.json({ number: after + 1 });
      return;
    }
    res.json({ number: await nextLegacyNumber(tag.color, tag.lot, after) });
  }),
);

const legacyEntrySchema = legacySchema.extend({
  name: z.string().trim().min(1).max(200),
  locationId: uuid.nullish(),
  parentItemId: uuid.nullish(),
  category: z.string().trim().max(120).nullish(),
});

// Fast entry: one item per sticker, answering with the next number to offer.
tagCommissioningRouter.post(
  "/legacy/items",
  asyncHandler(async (req, res) => {
    const body = parse(legacyEntrySchema, req.body);
    res.status(201).json(await createFromLegacySticker(body, currentUser(req).oid));
  }),
);

// ---- RFID encoding --------------------------------------------------------

const encodeSchema = z
  .object({
    itemIds: z.array(uuid).max(MAX_ENCODE).optional(),
    unitIds: z.array(uuid).max(MAX_ENCODE).optional(),
    format: z.enum(["zpl", "csv"]).optional(),
    dpi: z.coerce
      .number()
      .refine((d) => (ZPL_DPIS as readonly number[]).includes(d), "Printer resolution is 203, 300 or 600 dpi.")
      .optional(),
    bind: z.boolean().optional(),
    sample: z.boolean().optional(),
  })
  .refine((b) => b.sample || (b.itemIds?.length ?? 0) + (b.unitIds?.length ?? 0) > 0, {
    message: "Choose at least one record to encode.",
  });

// A file download, so it answers with the file rather than JSON.
tagCommissioningRouter.post(
  "/encode",
  asyncHandler(async (req, res) => {
    const body = parse(encodeSchema, req.body);
    const file = await buildEncodeFile({
      ...body,
      format: body.format ?? "zpl",
      dpi: body.dpi ?? 203,
      bind: body.bind ?? true,
    });
    res.setHeader("Content-Type", `${file.contentType}; charset=utf-8`);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Label-Count", String(file.count));
    res.setHeader("X-Tags-Bound", String(file.bound));
    res.send(file.body);
  }),
);

// ---- Coverage -------------------------------------------------------------

tagCommissioningRouter.get(
  "/report/tiers",
  asyncHandler(async (req, res) => {
    const locationId = req.query.locationId ? parse(uuid, req.query.locationId) : undefined;
    res.json(await tierReport(locationId));
  }),
);

// ---- Bulk binding sessions -------------------------------------------------

const createSessionSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    tagType,
    locationId: uuid.optional(),
    includeSubLocations: z.boolean().optional(),
    itemIds: z.array(uuid).max(5000).optional(),
    onlyUntagged: z.boolean().optional(),
    includeUnits: z.boolean().optional(),
  })
  .refine((b) => b.locationId || b.itemIds?.length, {
    message: "Choose a location or a list of items to bind.",
  });

tagCommissioningRouter.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const status = req.query.status === "finished" ? "finished" : "active";
    res.json(await listSessions(status));
  }),
);

tagCommissioningRouter.post(
  "/sessions",
  asyncHandler(async (req, res) => {
    const body = parse(createSessionSchema, req.body);
    res.status(201).json(await createSession(body, currentUser(req).oid));
  }),
);

tagCommissioningRouter.get(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    res.json(await getSession(parse(uuid, param(req, "id"))));
  }),
);

tagCommissioningRouter.post(
  "/sessions/:id/read",
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().max(512) }), req.body);
    res.json(await recordRead(parse(uuid, param(req, "id")), code, currentUser(req).oid));
  }),
);

tagCommissioningRouter.post(
  "/sessions/:id/skip",
  asyncHandler(async (req, res) => {
    res.json(await skipEntry(parse(uuid, param(req, "id"))));
  }),
);

tagCommissioningRouter.post(
  "/sessions/:id/undo",
  asyncHandler(async (req, res) => {
    res.json(await undoLast(parse(uuid, param(req, "id")), currentUser(req).oid));
  }),
);

tagCommissioningRouter.post(
  "/sessions/:id/finish",
  asyncHandler(async (req, res) => {
    res.json(await finishSession(parse(uuid, param(req, "id"))));
  }),
);
