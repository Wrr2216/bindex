import { env } from "../../env";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { thumbnail } from "../media-ai-core";
import { getClaim, getEvidence, type ClaimDetail } from "./claims";
import type { EvidenceAttachment, EvidencePack, LineEvidence } from "./evidence";
import { INCIDENT_CATEGORIES, RESOLUTION_LABELS, STATUS_LABELS, TYPE_INFO } from "./model";
import { renderClaimPdf, type ClaimDoc, type DocEvidence, type DocPhoto } from "./pdf";
import { renderClaimXlsx, type ClaimSheet } from "./xlsx";

/**
 * The adjuster's copy: gathers a claim and its evidence pack and hands them to
 * the PDF and spreadsheet renderers.
 */

const baseUrl = () => env.APP_BASE_URL.replace(/\/+$/, "");

/** Photos per line: enough to show the before and the after, not the whole camera roll. */
const PER_PHASE = 4;
const OTHER_PER_LINE = 2;
/** A cap on the whole document, so a claim with hundreds of photos still prints. */
const MAX_PHOTOS = 60;
const PHOTO_WIDTH = 640;

type Fmt = {
  at: (iso: string | Date | null | undefined) => string;
  money: (cents: number | null | undefined) => string;
};

function formatters(timeZone: string, locale: string, currency: string): Fmt {
  let dateFmt: Intl.DateTimeFormat;
  try {
    dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone });
  } catch {
    dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  }
  let moneyFmt: Intl.NumberFormat;
  try {
    moneyFmt = new Intl.NumberFormat(locale, { style: "currency", currency });
  } catch {
    moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  }
  return {
    at: (v) => (v ? dateFmt.format(new Date(v)) : ""),
    money: (c) => (c === null || c === undefined ? "Not set" : moneyFmt.format(c / 100)),
  };
}

const isPrintable = (a: EvidenceAttachment) => a.kind === "photo" && a.mime.startsWith("image/");

const phaseWord = { before: "Before", during: "In transit", after: "After", unknown: "Undated" } as const;

function photoLabel(a: EvidenceAttachment, fmt: Fmt): string {
  return [phaseWord[a.phase], a.stage, fmt.at(a.createdAt), a.caption].filter(Boolean).join("  ·  ");
}

function tripText(e: LineEvidence, fmt: Fmt): string | null {
  const t = e.trip;
  if (!t) return e.jobItemId ? null : "Not on a job manifest, so there is no trip history.";
  const steps = [
    t.packedAt && `Packed ${fmt.at(t.packedAt)}`,
    t.loadedAt && `Loaded ${fmt.at(t.loadedAt)}`,
    t.deliveredAt && `Delivered ${fmt.at(t.deliveredAt)}`,
    t.placedAt && `Placed ${fmt.at(t.placedAt)}`,
    ...t.exceptions.map((x) => `${x.stage.replace(/_/g, " ")} ${fmt.at(x.at)}`),
  ].filter(Boolean);
  const job = e.jobCode ?? "A job since deleted (history from the audit log)";
  return [`${job}${e.shipmentCode ? ` / ${e.shipmentCode}` : ""}:`, steps.join("  ·  ") || "no stage changes yet"].join(" ");
}

const NOTE_SOURCE = {
  stage: "stage note",
  line: "manifest note",
  condition_report: "condition report",
  pack_list: "pack list",
  photo: "photo caption",
  custody: "custody",
} as const;

export function buildDoc(
  claim: ClaimDetail,
  pack: EvidencePack,
  fmt: Fmt,
): { doc: ClaimDoc; photoIds: string[] } {
  const money = TYPE_INFO[claim.type].money;
  const photoIds: string[] = [];
  const take = (list: EvidenceAttachment[], n: number): DocPhoto[] => {
    const out: DocPhoto[] = [];
    for (const a of list) {
      if (out.length >= n || photoIds.length >= MAX_PHOTOS) break;
      photoIds.push(a.id);
      out.push({ id: a.id, label: photoLabel(a, fmt) });
    }
    return out;
  };

  const evidence: DocEvidence[] = pack.lines.map((e, i) => {
    const photos = e.attachments.filter(isPrintable);
    const before = take(photos.filter((a) => a.phase === "before"), PER_PHASE);
    const after = take(photos.filter((a) => a.phase === "after"), PER_PHASE);
    const other = take(photos.filter((a) => a.phase === "during" || a.phase === "unknown"), OTHER_PER_LINE);
    return {
      heading: `Line ${i + 1}  ·  ${e.itemName ?? "Item"}${e.assetCode ? `  ·  ${e.assetCode}` : ""}`,
      trip: tripText(e, fmt),
      notes: e.conditionNotes.map((n) => ({
        at: n.at ? fmt.at(n.at) : "On the manifest",
        source: `${NOTE_SOURCE[n.source]}${n.stage ? ` (${n.stage.replace(/_/g, " ")})` : ""}${n.by ? `, ${n.by}` : ""}`,
        text: n.text,
      })),
      reports: e.conditionReports.map((r) => ({
        at: fmt.at(r.createdAt),
        text: [
          r.stage && `${r.stage}:`,
          r.rating,
          r.defects.length ? `${r.defects.length} defect${r.defects.length === 1 ? "" : "s"}` : null,
          r.handlingNote && `handling: ${r.handlingNote}`,
        ]
          .filter(Boolean)
          .join(" "),
      })),
      custody: e.custody.map((h) => ({
        at: fmt.at(h.at),
        text: [
          `${h.from ?? "?"} to ${h.to ?? "?"}`,
          h.sealNumbers.length ? `seals ${h.sealNumbers.join(", ")}` : null,
          h.signatures.length ? `signed by ${h.signatures.map((s) => s.signerName).join(" and ")}` : null,
          h.contentHash ? `list hash ${h.contentHash.slice(0, 16)}` : null,
          h.auditLogId ? `audit #${h.auditLogId}` : null,
        ]
          .filter(Boolean)
          .join("  ·  "),
      })),
      before,
      after,
      other,
      morePhotos: photos.length - before.length - after.length - other.length,
      history: e.stageHistory.map((h) => ({
        at: fmt.at(h.at),
        stage: h.label,
        detail: [h.via && `via ${h.via}`, h.actor && `by ${h.actor}`, h.deviceId && `device ${h.deviceId}`, h.shipmentCode, h.note]
          .filter(Boolean)
          .join("  ·  "),
      })),
      audit: e.audit.length
        ? `Audit log: ${e.audit
            .slice(0, 24)
            .map((a) => `#${a.id} ${a.type} ${a.hash.slice(0, 12)}`)
            .join(";  ")}${e.audit.length > 24 ? `; and ${e.audit.length - 24} more` : ""}`
        : null,
    };
  });

  const category = claim.category ? INCIDENT_CATEGORIES.find((c) => c.name === claim.category)?.label ?? claim.category : null;
  const facts: [string, string][] = [
    ["Type", [TYPE_INFO[claim.type].label, category].filter(Boolean).join(": ")],
    ["Status", STATUS_LABELS[claim.status]],
    ["Job", claim.jobCode ? `${claim.jobCode} ${claim.jobName ?? ""}`.trim() : "None"],
    ["Shipment", claim.shipmentCode ? `${claim.shipmentCode} ${claim.shipmentName ?? ""}`.trim() : "None"],
    ["Occurred", fmt.at(claim.occurredAt) || "Not given"],
    ["Where", claim.locationName ?? "Not given"],
    ["Reported by", `${claim.reporterName ?? "Unknown"}${claim.reporterGrantId ? " (portal)" : ""}`],
    ["Opened", fmt.at(claim.createdAt)],
    ["Reviewer", claim.assigneeName ?? "Unassigned"],
    ["Submitted", fmt.at(claim.submittedAt) || "Not yet"],
    [
      "Decision due",
      claim.sla.dueAt ? `${fmt.at(claim.sla.dueAt)} (${claim.sla.state.replace(/_/g, " ")})` : "Starts on submission",
    ],
    ["Decided", fmt.at(claim.decidedAt) || "Not yet"],
  ];
  if (claim.carrierReference) facts.push(["Carrier ref.", claim.carrierReference]);
  if (claim.insurerReference) facts.push(["Insurer ref.", claim.insurerReference]);
  if (claim.paymentReference) facts.push(["Payment ref.", claim.paymentReference]);
  if (claim.reporterEmail) facts.push(["Contact", claim.reporterEmail]);

  const frozen = pack.frozen
    ? ` At submission (${fmt.at(pack.frozen.at)}) it was ${pack.frozen.hash}: ${
        pack.unchangedSinceSubmission ? "unchanged since" : "records have been added or removed since"
      }.`
    : "";

  const doc: ClaimDoc = {
    kicker: money ? "CLAIM  ·  ADJUSTER PACK" : "INCIDENT REPORT",
    title: claim.title,
    code: claim.code,
    subtitle: `${TYPE_INFO[claim.type].label}  ·  ${STATUS_LABELS[claim.status]}  ·  ${claim.lines.length} line${claim.lines.length === 1 ? "" : "s"}`,
    facts,
    totals: money
      ? [
          ["Estimated", fmt.money(claim.totals.estimatedTotalCents)],
          ["Approved", fmt.money(claim.totals.approvedTotalCents)],
          ["Paid", claim.paidTotalCents === null ? "Not yet" : fmt.money(claim.paidTotalCents)],
        ]
      : null,
    description: claim.description,
    fingerprint: `Evidence fingerprint (sha256) as printed: ${pack.hash}.${frozen}`,
    lines: claim.lines.map((l, i) => ({
      index: i + 1,
      name: l.itemName ?? l.currentItemName ?? "Item",
      code: [l.assetCode, l.description].filter(Boolean).join("  ·  "),
      damage: l.damageDescription,
      stage: l.stageLabel,
      resolution: l.resolution ? RESOLUTION_LABELS[l.resolution] : null,
      estimated: fmt.money(l.estimatedCents),
      approved: l.resolution === "deny" ? fmt.money(0) : fmt.money(l.approvedCents),
    })),
    money,
    evidence,
    claimPhotos: take(pack.claim.attachments.filter(isPrintable), 9),
    signatures: pack.claim.signatures.map(
      (s) =>
        `${fmt.at(s.signedAt)}  ·  ${s.signerName}${s.signerRole ? ` (${s.signerRole})` : ""} signed the ${s.ownerType}: "${s.statement}"  ·  content hash ${s.contentHash.slice(0, 16)}`,
    ),
    timeline: pack.timeline.map((t) => ({ at: fmt.at(t.at), label: t.label, detail: t.detail })),
    sources: [
      "Evidence gathered from the manifest's stage history, photos on the items and units, and the tamper-evident audit log.",
      `Condition reports and pack lists: ${pack.sources.conditionReports ? "included" : "not installed"}.`,
      `Chain of custody: ${pack.sources.custody ? "included" : "not installed"}.`,
    ].join(" "),
    url: `${baseUrl()}/claims/${claim.id}`,
  };
  return { doc, photoIds };
}

async function photoBytes(ids: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  // A few at a time: each decodes a full-size photo.
  for (let i = 0; i < ids.length; i += 4) {
    await Promise.all(
      ids.slice(i, i + 4).map(async (id) => {
        try {
          const t = await thumbnail(id, PHOTO_WIDTH);
          if (t) out.set(id, t.bytes);
        } catch (err) {
          logger.warn("claims.pdf.photo_failed", { attachmentId: id, err: String(err) });
        }
      }),
    );
  }
  return out;
}

export async function claimPdf(id: string, timeZone: string): Promise<{ code: string; pdf: Buffer }> {
  const [claim, pack, config] = await Promise.all([getClaim(id), getEvidence(id), getConfig()]);
  const fmt = formatters(timeZone, config.locale, claim.currency);
  const { doc, photoIds } = buildDoc(claim, pack, fmt);
  const pdf = await renderClaimPdf(doc, await photoBytes(photoIds), new Date(), timeZone, config.appName);
  return { code: claim.code, pdf };
}

export function buildSheet(claim: ClaimDetail, pack: EvidencePack, fmt: Fmt): ClaimSheet {
  const byLine = new Map(pack.lines.map((l) => [l.lineId, l]));
  const lineName = (l: LineEvidence) => `${l.position}. ${l.itemName ?? "Item"}`;
  const base = baseUrl();
  return {
    title: `${claim.code}  ${claim.title}`,
    subtitle: `${TYPE_INFO[claim.type].label} · ${STATUS_LABELS[claim.status]} · exported ${fmt.at(new Date())}`,
    currency: claim.currency,
    summary: [
      ["Code", claim.code],
      ["Type", TYPE_INFO[claim.type].label],
      ["Category", claim.category],
      ["Status", STATUS_LABELS[claim.status]],
      ["Title", claim.title],
      ["What happened", claim.description],
      ["Job", claim.jobCode ? `${claim.jobCode} ${claim.jobName ?? ""}`.trim() : null],
      ["Shipment", claim.shipmentCode],
      ["Occurred", fmt.at(claim.occurredAt)],
      ["Where", claim.locationName],
      ["Reported by", claim.reporterName],
      ["Contact", claim.reporterEmail],
      ["Opened", fmt.at(claim.createdAt)],
      ["Submitted", fmt.at(claim.submittedAt)],
      ["Reviewer", claim.assigneeName],
      ["Decision due", fmt.at(claim.sla.dueAt)],
      ["SLA", claim.sla.state.replace(/_/g, " ")],
      ["Decided", fmt.at(claim.decidedAt)],
      ["Carrier reference", claim.carrierReference],
      ["Insurer reference", claim.insurerReference],
      ["Payment reference", claim.paymentReference],
      [`Estimated total (${claim.currency})`, claim.totals.estimatedTotalCents === null ? null : claim.totals.estimatedTotalCents / 100],
      [`Approved total (${claim.currency})`, claim.totals.approvedTotalCents === null ? null : claim.totals.approvedTotalCents / 100],
      [`Paid (${claim.currency})`, claim.paidTotalCents === null ? null : claim.paidTotalCents / 100],
      ["Evidence fingerprint", pack.hash],
      ["Fingerprint at submission", pack.frozen?.hash ?? null],
      ["Link", `${base}/claims/${claim.id}`],
    ],
    lines: claim.lines.map((l, i) => {
      const e = byLine.get(l.id);
      return {
        index: i + 1,
        item: l.itemName ?? l.currentItemName ?? "Item",
        code: l.assetCode ?? "",
        description: l.description,
        damage: l.damageDescription,
        stage: l.stageLabel,
        resolution: l.resolution ? RESOLUTION_LABELS[l.resolution] : null,
        declaredCents: l.declaredValueCents,
        estimatedCents: l.estimatedCents,
        approvedCents: l.resolution === "deny" ? 0 : l.approvedCents,
        photos: l.photoCount,
        packedAt: fmt.at(e?.trip?.packedAt) || null,
        deliveredAt: fmt.at(e?.trip?.deliveredAt) || null,
        conditionNotes: e?.conditionNotes.map((n) => `${n.at ? fmt.at(n.at) : "Manifest"}: ${n.text}`).join("\n") || null,
      };
    }),
    evidence: pack.lines.flatMap((e) => [
      ...e.attachments.map((a) => ({
        line: lineName(e),
        kind: a.kind,
        at: fmt.at(a.createdAt),
        phase: phaseWord[a.phase],
        detail: [a.stage, a.caption].filter(Boolean).join(": ") || a.mime,
        url: `${base}${a.url}`,
      })),
      ...e.conditionNotes.map((n) => ({
        line: lineName(e),
        kind: NOTE_SOURCE[n.source],
        at: n.at ? fmt.at(n.at) : null,
        phase: null,
        detail: n.text,
        url: null,
      })),
      ...e.custody.map((h) => ({
        line: lineName(e),
        kind: "custody",
        at: fmt.at(h.at),
        phase: null,
        detail: `${h.from ?? "?"} to ${h.to ?? "?"}${h.sealNumbers.length ? `, seals ${h.sealNumbers.join(", ")}` : ""}`,
        url: null,
      })),
    ]),
    timeline: pack.timeline.map((t) => ({ at: fmt.at(t.at), what: t.label, detail: t.detail })),
    audit: [
      ...pack.lines.flatMap((e) => e.audit.map((a) => ({ line: lineName(e), id: a.id, type: a.type, at: fmt.at(a.occurredAt), hash: a.hash }))),
      ...pack.claim.audit.map((a) => ({ line: "Claim", id: a.id, type: a.type, at: fmt.at(a.occurredAt), hash: a.hash })),
    ],
  };
}

export async function claimXlsx(id: string, timeZone: string): Promise<{ code: string; xlsx: Buffer }> {
  const [claim, pack, config] = await Promise.all([getClaim(id), getEvidence(id), getConfig()]);
  const fmt = formatters(timeZone, config.locale, claim.currency);
  return { code: claim.code, xlsx: await renderClaimXlsx(buildSheet(claim, pack, fmt)) };
}

export { formatters };
