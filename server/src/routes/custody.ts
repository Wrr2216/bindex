import { Router, raw, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { currentUser, requireAdmin } from "../auth/middleware";
import { env } from "../env";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { asyncHandler, param, parse } from "../lib/http";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";
import { getConfig } from "../services/config";
import * as custody from "../services/custody";
import { OUTCOMES, PARTY_KINDS, purposeList, type Actor } from "../services/custody";
import { getAttachmentStream } from "../services/media-ai-core";

/**
 * /api/custody for signed-in people and API keys, and the one-time signing
 * link (/custody-sign/:token and /api/custody-public/:token) for a party with
 * no account, mounted before the session guard. Both answer 404 while the
 * "custody" feature is switched off.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().uuid();

const actor = (req: Request): Actor => {
  const user = currentUser(req);
  return { userOid: user.oid, name: user.name };
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

/** A malformed id is a record that does not exist, not a database error. */
function uuidParams(router: Router, ...names: string[]) {
  for (const name of names) {
    router.param(name, (_req, _res, next, value: string) => next(UUID.test(value) ? undefined : notFound("Not found")));
  }
  return router;
}

const requireCustody: RequestHandler = (_req, _res, next) => {
  getConfig()
    .then((config) =>
      next(
        config.features.custody
          ? undefined
          : new HttpError(404, "feature_disabled", "Chain of custody is switched off. An administrator can turn it on in Settings."),
      ),
    )
    .catch(next);
};

// --- Schemas ---------------------------------------------------------------------

const party = z.object({
  kind: z.enum(PARTY_KINDS),
  entityId: uuid.nullish(),
  userOid: z.string().max(200).nullish(),
  name: z.string().max(200).nullish(),
  org: z.string().max(200).nullish(),
});

const placement = {
  locationId: uuid.nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  accuracyM: z.number().min(0).max(1e6).nullish(),
};

const transferFields = z.object({
  purpose: z.string().min(1).max(32),
  from: party,
  to: party,
  ...placement,
  jobId: uuid.nullish(),
  shipmentId: uuid.nullish(),
  sealNumbers: z.array(z.string().max(80)).max(50).optional(),
  conditionNote: z.string().max(2000).nullish(),
  notes: z.string().max(5000).nullish(),
});

const outcomes = z
  .array(
    z.object({
      lineId: uuid,
      outcome: z.enum(OUTCOMES),
      note: z.string().max(500).nullish(),
    }),
  )
  .max(custody.MAX_LINES);

const signer = {
  signerName: z.string().trim().min(1, "Enter the signer's name").max(200),
  signerEmail: z
    .string()
    .trim()
    .max(320)
    .nullish()
    .transform((v) => v || null),
  // The signature pad's PNG, as a data URL or bare base64.
  image: z.string().min(1, "Draw the signature before saving").max(800_000),
};

function decodeImage(value: string): Buffer {
  const bytes = Buffer.from(value.replace(/^data:[^;,]+;base64,/, ""), "base64");
  if (!bytes.length) throw badRequest("The signature image could not be read. Sign again.");
  return bytes;
}

// --- Signed-in routes ---------------------------------------------------------------

const router = uuidParams(Router(), "id", "itemId");

router.get("/meta", (_req, res) => {
  res.json({ purposes: purposeList(), outcomes: OUTCOMES, partyKinds: PARTY_KINDS });
});

router.get(
  "/controls/:itemId",
  asyncHandler(async (req, res) => {
    res.json(await custody.getControl(param(req, "itemId")));
  }),
);

const controlSchema = z.object({ controlled: z.boolean(), reason: z.string().max(500).nullish() });
const requireAdminToRelease: RequestHandler = (req, res, next) =>
  // Anyone may put an item under control; lifting it weakens the policy, so
  // that is an administrator's call.
  req.body?.controlled === false ? requireAdmin(req, res, next) : next();

router.put(
  "/controls/:itemId",
  requireAdminToRelease,
  asyncHandler(async (req, res) => {
    const { controlled, reason } = parse(controlSchema, req.body);
    res.json(await custody.setControl(param(req, "itemId"), controlled, reason ?? null, actor(req)));
  }),
);

router.get(
  "/items/:itemId/chain",
  asyncHandler(async (req, res) => {
    res.json(await custody.itemChain(param(req, "itemId")));
  }),
);

router.get(
  "/transfers",
  asyncHandler(async (req, res) => {
    res.json(
      await custody.listTransfers({
        status: q(req, "status"),
        purpose: q(req, "purpose"),
        jobId: qId(req, "jobId"),
        shipmentId: qId(req, "shipmentId"),
        q: q(req, "q"),
        limit: Number(q(req, "limit") ?? 50) || 50,
      }),
    );
  }),
);

router.post(
  "/transfers",
  asyncHandler(async (req, res) => {
    const created = await custody.createTransfer(parse(transferFields, req.body), actor(req));
    res.status(201).json(await custody.getTransfer(created.id));
  }),
);

router.get(
  "/transfers/:id",
  asyncHandler(async (req, res) => {
    res.json(await custody.getTransfer(param(req, "id")));
  }),
);

router.patch(
  "/transfers/:id",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    await custody.updateTransfer(id, parse(transferFields.partial(), req.body), actor(req));
    res.json(await custody.getTransfer(id));
  }),
);

const scanSchema = z.object({
  codes: z.array(z.string().max(500)).min(1).max(custody.MAX_LINES),
  via: z.enum(["scan", "manual"]).optional(),
});

router.post(
  "/transfers/:id/scan",
  asyncHandler(async (req, res) => {
    const { codes, via } = parse(scanSchema, req.body);
    res.json(await custody.scanIntoTransfer(param(req, "id"), codes, via));
  }),
);

router.post(
  "/transfers/:id/lines/remove",
  asyncHandler(async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(uuid).min(1).max(custody.MAX_LINES) }), req.body);
    res.json(await custody.removeLines(param(req, "id"), ids));
  }),
);

router.post(
  "/transfers/:id/outcomes",
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ outcomes }), req.body);
    res.json(await custody.setOutcomes(param(req, "id"), body.outcomes));
  }),
);

router.post(
  "/transfers/:id/lock",
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ expectedCount: z.number().int().min(0), outcomes: outcomes.optional() }), req.body);
    const id = param(req, "id");
    await custody.lockTransfer(id, body);
    res.json(await custody.getTransfer(id));
  }),
);

/** Finish a completed transfer; a failure here is reported, not thrown, since the signature already stands. */
async function afterSigning(id: string, completed: boolean, who: Actor | null) {
  if (!completed) return null;
  try {
    return await custody.finalizeTransfer(id, who);
  } catch (err) {
    logger.error("custody.finalize.failed", { id, err: String(err) });
    return { error: "The transfer is signed, but its receipt could not be finished. Open it and choose Finish." };
  }
}

router.post(
  "/transfers/:id/sign",
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        party: z.enum(["from", "to"]),
        ...signer,
        signerRole: z.string().max(120).nullish(),
        expectedCount: z.number().int().min(0).optional(),
        outcomes: outcomes.optional(),
      }),
      req.body,
    );
    const id = param(req, "id");
    const who = actor(req);
    const result = await custody.signTransfer(
      id,
      body.party,
      { signerName: body.signerName, signerEmail: body.signerEmail, signerRole: body.signerRole ?? null, image: decodeImage(body.image) },
      {
        via: "device",
        capturedBy: who.userOid,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        expectedCount: body.expectedCount,
        outcomes: body.outcomes,
      },
    );
    const finalized = await afterSigning(id, result.completed, who);
    res.json({ completed: result.completed, finalized, transfer: await custody.getTransfer(id) });
  }),
);

router.post(
  "/transfers/:id/link",
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ party: z.enum(["from", "to"]), hours: z.number().int().min(1).max(24 * 30).optional() }), req.body);
    const id = param(req, "id");
    const { token, expiresAt } = await custody.issueLink(id, body.party, body.hours, actor(req));
    res.status(201).json({
      url: `${env.APP_BASE_URL.replace(/\/+$/, "")}/custody-sign/${token}`,
      path: `/custody-sign/${token}`,
      expiresAt,
      transfer: await custody.getTransfer(id),
    });
  }),
);

router.delete(
  "/transfers/:id/link",
  asyncHandler(async (req, res) => {
    await custody.revokeLink(param(req, "id"));
    res.status(204).end();
  }),
);

router.post(
  "/transfers/:id/void",
  asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().max(1000).nullish() }), req.body ?? {});
    const id = param(req, "id");
    await custody.voidTransfer(id, reason ?? null, actor(req));
    res.json(await custody.getTransfer(id));
  }),
);

router.post(
  "/transfers/:id/finalize",
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const t = await custody.loadTransfer(id);
    if (t.status !== "completed") throw badRequest(`${t.code} is not complete yet; it is finished when the last party signs.`);
    res.json({ finalized: await custody.finalizeTransfer(id, actor(req)), transfer: await custody.getTransfer(id) });
  }),
);

router.get(
  "/transfers/:id/receipt.pdf",
  asyncHandler(async (req, res) => {
    const t = await custody.loadTransfer(param(req, "id"));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${t.code}-receipt.pdf"`);
    res.setHeader("Cache-Control", "no-store");
    if (t.receiptAttachmentId) {
      // The stored receipt, byte for byte: the one the audit log fingerprints.
      const opened = await getAttachmentStream(t.receiptAttachmentId);
      if (opened.status === 200) {
        res.setHeader("Content-Length", String(opened.size));
        opened.stream.pipe(res);
        return;
      }
    }
    // Not complete yet: a preview, drawn now, that nothing fingerprints.
    res.send(await custody.renderReceipt(t));
  }),
);

router.get(
  "/transfers/:id/verify",
  asyncHandler(async (req, res) => {
    res.json(await custody.verifyTransfer(param(req, "id")));
  }),
);

// The receipt PDF itself as the body: which transfer it belongs to, and whether it still holds.
router.post(
  "/verify-receipt",
  raw({ type: () => true, limit: "25mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      throw badRequest("Send the receipt PDF as the request body, with Content-Type application/pdf.");
    }
    res.json(await custody.verifyReceiptBytes(req.body));
  }),
);

router.get(
  "/shipments/awaiting",
  asyncHandler(async (_req, res) => {
    res.json((await getConfig()).features.jobs ? await custody.awaitingSignOff() : []);
  }),
);

const requireJobs: RequestHandler = (_req, _res, next) => {
  getConfig()
    .then((c) =>
      next(c.features.jobs ? undefined : new HttpError(404, "feature_disabled", "Delivery sign-off needs Projects, jobs and shipments switched on.")),
    )
    .catch(next);
};

router.get(
  "/shipments/:id/review",
  requireJobs,
  asyncHandler(async (req, res) => {
    res.json(await custody.shipmentReview(param(req, "id")));
  }),
);

router.post(
  "/shipments/:id/sign-off",
  requireJobs,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        to: party,
        from: party.optional(),
        ...placement,
        sealNumbers: z.array(z.string().max(80)).max(50).optional(),
        conditionNote: z.string().max(2000).nullish(),
      }),
      req.body,
    );
    res.status(201).json(await custody.startSignOff(param(req, "id"), body, actor(req)));
  }),
);

export const custodyRouter = Router();
custodyRouter.use("/custody", requireCustody, router);

// --- The one-time signing link (no account) ----------------------------------------------

const publicReads = rateLimit({ windowMs: 60_000, max: 120, key: (req) => `custody-link:${req.ip}` });
// A long shipment shows several photos a line, all fetched at once.
const publicPhotos = rateLimit({ windowMs: 60_000, max: 1200, key: (req) => `custody-photo:${req.ip}` });
const publicSigns = rateLimit({ windowMs: 15 * 60_000, max: 20, key: (req) => `custody-sign:${req.ip}` });

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
};

export const custodyPublicRouter = Router();

custodyPublicRouter.get("/custody-sign/assets/sign.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(custody.SIGN_PAGE_SCRIPT);
});

custodyPublicRouter.get(
  "/custody-sign/:token",
  publicReads,
  noStore,
  requireCustody,
  asyncHandler(async (_req, res) => {
    const config = await getConfig();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(custody.signPageHtml(config.appName, config.accentColor));
  }),
);

custodyPublicRouter.get(
  "/api/custody-public/:token",
  publicReads,
  noStore,
  requireCustody,
  asyncHandler(async (req, res) => {
    res.json(await custody.publicView(param(req, "token")));
  }),
);

custodyPublicRouter.get(
  "/api/custody-public/:token/photos/:attachmentId",
  publicPhotos,
  requireCustody,
  asyncHandler(async (req, res) => {
    const attachmentId = param(req, "attachmentId");
    if (!UUID.test(attachmentId)) throw notFound("Photo not found.");
    const bytes = await custody.publicPhoto(param(req, "token"), attachmentId);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=600");
    res.send(bytes);
  }),
);

custodyPublicRouter.post(
  "/api/custody-public/:token/sign",
  publicSigns,
  noStore,
  requireCustody,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ ...signer, outcomes: outcomes.optional() }), req.body);
    const t = await custody.transferForToken(param(req, "token"));
    const result = await custody.signByLink(
      t.linkTokenHash!,
      { signerName: body.signerName, signerEmail: body.signerEmail, image: decodeImage(body.image) },
      { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null, outcomes: body.outcomes },
    );
    await afterSigning(t.id, result.completed, null);
    res.json({ ok: true, code: result.transfer.code, completed: result.completed });
  }),
);
