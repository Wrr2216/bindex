/**
 * Milestones: the timeline a portal shows and the events that email people.
 * Pure, fed by the jobs core's stage history and shipment dates and by the
 * audit log's events, so the arithmetic is tested without a database.
 */

export type MilestoneKey = "created" | "packed" | "loaded" | "in_transit" | "arrived" | "delivered" | "placed";
export type MilestoneState = "done" | "current" | "upcoming";

export type Milestone = {
  key: MilestoneKey;
  label: string;
  state: MilestoneState;
  /** When it was reached, or when it started for one in progress. */
  at: string | null;
  /** "12 of 40", "2 of 3 shipments", "At Depot North". */
  detail: string | null;
};

type Step = "packed" | "loaded" | "delivered" | "placed";

/** The parts of a rollup this needs (see jobs-core rollups.ts). */
export type ProgressLike = {
  total: number;
  exceptions: number;
  reached: Record<Step, number>;
};

export type TimelineInput = {
  createdAt: Date;
  progress: ProgressLike;
  /**
   * For each step, when the first line in scope reached it (or passed it) and
   * when the last one did, from the stage history.
   */
  stepTimes: Partial<Record<Step, { first: Date | null; last: Date | null }>>;
  /** The shipments in scope. None means there is no transport leg to show. */
  shipments: { departedAt: Date | null; arrivedAt: Date | null }[];
  /** The most recent arrival at a key location, when a GPS feature reports one. */
  lastArrival?: { at: Date; label: string } | null;
};

const LABELS: Record<MilestoneKey, string> = {
  created: "Created",
  packed: "Packed",
  loaded: "Loaded",
  in_transit: "In transit",
  arrived: "Arrived",
  delivered: "Delivered",
  placed: "Placed",
};

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

const latest = (dates: (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

function lineStep(key: Step, input: TimelineInput): Milestone {
  const { total, exceptions, reached } = input.progress;
  const n = reached[key];
  const times = input.stepTimes[key];
  const detail = total > 0 ? `${n} of ${total}` : null;
  // Exception lines (missing, damaged) never reach a step; they do not hold
  // the milestone back, the same way they do not hold a shipment back.
  if (total > 0 && n > 0 && n + exceptions >= total) {
    return { key, label: LABELS[key], state: "done", at: iso(times?.last ?? times?.first ?? null), detail };
  }
  if (n > 0) return { key, label: LABELS[key], state: "current", at: iso(times?.first ?? null), detail };
  return { key, label: LABELS[key], state: "upcoming", at: null, detail };
}

function transportStep(key: "in_transit" | "arrived", input: TimelineInput): Milestone {
  const dates = input.shipments.map((s) => (key === "in_transit" ? s.departedAt : s.arrivedAt));
  const done = dates.filter(Boolean).length;
  const count = input.shipments.length;
  const detail = count > 1 ? `${done} of ${count} shipments` : null;
  if (done === count) return { key, label: LABELS[key], state: "done", at: iso(latest(dates)), detail };
  if (key === "arrived" && input.lastArrival) {
    return {
      key,
      label: LABELS[key],
      state: "current",
      at: iso(input.lastArrival.at),
      detail: `At ${input.lastArrival.label}`,
    };
  }
  if (done > 0) return { key, label: LABELS[key], state: "current", at: iso(latest(dates)), detail };
  return { key, label: LABELS[key], state: "upcoming", at: null, detail };
}

/**
 * Created, packed, loaded, in transit, arrived, delivered, placed. The two
 * transport steps are left out when nothing in scope travels on a shipment.
 * A step the work went straight past (lines scanned to delivered without ever
 * being marked loaded) counts as done, with no time.
 */
export function buildMilestones(input: TimelineInput): Milestone[] {
  const steps: Milestone[] = [
    { key: "created", label: LABELS.created, state: "done", at: iso(input.createdAt), detail: null },
    lineStep("packed", input),
    lineStep("loaded", input),
  ];
  if (input.shipments.length > 0) steps.push(transportStep("in_transit", input), transportStep("arrived", input));
  steps.push(lineStep("delivered", input), lineStep("placed", input));

  let lastDone = -1;
  steps.forEach((s, i) => {
    if (s.state === "done") lastDone = i;
  });
  for (let i = 0; i < lastDone; i++) {
    if (steps[i]!.state !== "done") steps[i] = { ...steps[i]!, state: "done" };
  }
  return steps;
}

// ---- Notifications ----------------------------------------------------------

/** An audit-log event as the notifier reads it. */
export type NotifyEvent = {
  id: number;
  type: string;
  occurredAt: Date;
  subject: { type: string; id: string } | null;
  data: Record<string, unknown>;
};

/** What an event means to the people following it, before routing to grants. */
export type MilestoneNotice = {
  /** Unique per grant: the same milestone never emails the same person twice. */
  key: string;
  title: string;
  shipmentId: string | null;
  jobId: string | null;
  /** Only an item id (a tracker on one item); the notifier finds its job. */
  itemId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);

function nested(data: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = data[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function shipmentName(data: Record<string, unknown>): string {
  const code = text(data.code);
  const name = text(data.name);
  if (code && name) return `${name} (${code})`;
  return name ?? code ?? "Your shipment";
}

/**
 * Geofence events come from the GPS feature, which may not be installed; the
 * names are read loosely so a reasonable payload works without changes here.
 * `entered`/`arrived` means arriving at a key location, `exited`/`left`/
 * `departed` means leaving one.
 */
function geofenceNotice(ev: NotifyEvent): MilestoneNotice | null {
  const verb = ev.type.split(".").pop() ?? "";
  const arriving = /^(entered|enter|arrived|arrival)$/.test(verb);
  const leaving = /^(exited|exit|left|departed|departure)$/.test(verb);
  if (!arriving && !leaving) return null;
  const d = ev.data;
  const fence = nested(d, "geofence") ?? nested(d, "fence");
  const label =
    text(d.geofenceName) ?? text(d.fenceName) ?? text(fence?.name) ?? text(d.locationName) ?? text(d.name) ?? "a key location";
  const fenceId = uuidOrNull(d.geofenceId) ?? uuidOrNull(fence?.id) ?? uuidOrNull(d.locationId) ?? label.toLowerCase();
  const shipmentId = uuidOrNull(d.shipmentId) ?? (ev.subject?.type === "shipment" ? uuidOrNull(ev.subject.id) : null);
  const jobId = uuidOrNull(d.jobId) ?? (ev.subject?.type === "job" ? uuidOrNull(ev.subject.id) : null);
  const itemId = uuidOrNull(d.itemId) ?? (ev.subject?.type === "item" ? uuidOrNull(ev.subject.id) : null);
  const target = shipmentId ?? jobId ?? itemId;
  if (!target) return null;
  const who = shipmentId || itemId ? shipmentName(d) : text(d.jobName) ?? "Your delivery";
  return {
    key: `geofence:${fenceId}:${target}:${arriving ? "arrived" : "left"}`,
    title: arriving ? `${who} arrived at ${label}` : `${who} left ${label}`,
    shipmentId,
    jobId,
    itemId: shipmentId || jobId ? null : itemId,
  };
}

/**
 * The milestone an event announces, or null for events nobody is emailed
 * about: a shipment leaving (in transit), a shipment delivered, a job
 * completed, and arrivals at or departures from key locations.
 */
export function noticeFromEvent(ev: NotifyEvent): MilestoneNotice | null {
  if (ev.type === "shipment.status_changed") {
    const id = ev.subject?.type === "shipment" ? uuidOrNull(ev.subject.id) : null;
    if (!id) return null;
    const jobId = uuidOrNull(ev.data.jobId);
    const to = ev.data.to;
    if (to === "in_transit") {
      return { key: `shipment:${id}:departed`, title: `${shipmentName(ev.data)} is on its way`, shipmentId: id, jobId, itemId: null };
    }
    if (to === "delivered") {
      return { key: `shipment:${id}:delivered`, title: `${shipmentName(ev.data)} was delivered`, shipmentId: id, jobId, itemId: null };
    }
    return null;
  }
  if (ev.type === "job.updated") {
    const id = ev.subject?.type === "job" ? uuidOrNull(ev.subject.id) : null;
    if (!id || ev.data.status !== "completed" || ev.data.previousStatus === "completed") return null;
    const code = text(ev.data.code);
    const name = text(ev.data.name);
    const who = name && code ? `${name} (${code})` : name ?? code ?? "Your job";
    return { key: `job:${id}:completed`, title: `${who} is complete`, shipmentId: null, jobId: id, itemId: null };
  }
  if (ev.type.startsWith("geofence.")) return geofenceNotice(ev);
  return null;
}

/** Event types the notifier reads, as SQL LIKE patterns. */
export const NOTIFY_TYPE_LIKE = ["shipment.status_changed", "job.updated", "geofence.%"];

/** Whether a person last emailed at `lastSentAt` may be emailed again now. */
export function dueToSend(lastSentAt: Date | null, now: Date, intervalMinutes: number): boolean {
  if (!lastSentAt) return true;
  return now.getTime() - lastSentAt.getTime() >= intervalMinutes * 60_000;
}

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** No line breaks in a header, whatever a shipment happens to be called. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function composeMilestoneEmail(input: {
  appName: string;
  orgName: string;
  granteeName: string;
  scopeLabel: string;
  milestones: { title: string; occurredAt: Date }[];
}): { subject: string; text: string } {
  const sender = input.orgName || input.appName;
  const ordered = [...input.milestones].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const subject =
    ordered.length === 1 ? `${sender}: ${ordered[0]!.title}` : `${sender}: ${ordered.length} updates on ${input.scopeLabel}`;
  const lines = [
    `Hello ${oneLine(input.granteeName)},`,
    "",
    `Here is the latest on ${oneLine(input.scopeLabel)}:`,
    "",
    ...ordered.map((m) => `  - ${oneLine(m.title)} (${stamp(m.occurredAt)})`),
    "",
    "Open the portal link you were given for the details.",
    "",
    "You get these emails because milestone updates are switched on for your link.",
    "You can switch them off on the portal page.",
    "",
    `-- ${sender}`,
  ];
  return { subject: oneLine(subject).slice(0, 250), text: lines.join("\n") };
}

export function composeCodeEmail(input: { appName: string; orgName: string; code: string }): {
  subject: string;
  text: string;
} {
  const sender = input.orgName || input.appName;
  return {
    subject: oneLine(`${sender}: your portal code ${input.code}`),
    text: [
      `Your code is ${input.code}.`,
      "",
      "Enter it on the portal page within 10 minutes. If you did not ask for it, you can ignore this email.",
      "",
      `-- ${sender}`,
    ].join("\n"),
  };
}

export function composeLinkEmail(input: {
  appName: string;
  orgName: string;
  granteeName: string;
  scopeLabel: string;
  url: string;
  role: "viewer" | "contributor";
  expiresAt: Date;
}): { subject: string; text: string } {
  const sender = input.orgName || input.appName;
  const what = input.role === "contributor" ? "record your work on" : "follow";
  return {
    subject: oneLine(`${sender}: your link to ${input.scopeLabel}`).slice(0, 250),
    text: [
      `Hello ${oneLine(input.granteeName)},`,
      "",
      `${sender} has shared a link for you to ${what} ${oneLine(input.scopeLabel)}:`,
      "",
      input.url,
      "",
      `The link works until ${stamp(input.expiresAt)}. Anyone with it can open the page, so keep it to yourself.`,
      "",
      `-- ${sender}`,
    ].join("\n"),
  };
}
