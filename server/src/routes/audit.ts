import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parse } from "../lib/http";
import { currentUser } from "../auth/middleware";
import { auditReconcile, applyAudit } from "../services/verify";
import { readSince, clearChannel } from "../services/livefeed";

const readerId = (v: unknown) => (typeof v === "string" && v ? v : "default");

const reconcileSchema = z.object({
  codes: z.array(z.string()),
  companyId: z.string().uuid().optional(),
});
const applySchema = z.object({
  seenIds: z.array(z.string().uuid()),
  missingIds: z.array(z.string().uuid()),
});

export const auditRouter = Router();

// Reconcile a rolling tag set against the whole building (or one company).
auditRouter.post(
  "/reconcile",
  asyncHandler(async (req, res) => {
    const { codes, companyId } = parse(reconcileSchema, req.body);
    res.json(await auditReconcile(codes, companyId));
  }),
);

// Commit the audit: mark seen items checked, optionally flag not-seen missing.
auditRouter.post(
  "/apply",
  asyncHandler(async (req, res) => {
    const { seenIds, missingIds } = parse(applySchema, req.body);
    const user = currentUser(req);
    await applyAudit(seenIds, missingIds, user.oid, user.name);
    res.json({ ok: true, checked: seenIds.length, flaggedMissing: missingIds.length });
  }),
);

// Live reader feed: the Building Audit screen polls this for tags the hardware
// bridge has pushed (codes added after `since`, with the cursor to poll next).
auditRouter.get(
  "/live",
  asyncHandler(async (req, res) => {
    const since = Number(req.query.since ?? 0) || 0;
    res.json(readSince(readerId(req.query.reader), since));
  }),
);

// Reset a reader channel (e.g. when starting a fresh walk).
auditRouter.post(
  "/live/clear",
  asyncHandler(async (req, res) => {
    clearChannel(readerId(req.query.reader));
    res.json({ ok: true });
  }),
);
