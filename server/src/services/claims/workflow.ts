import type { ClaimStatus, ClaimType } from "../../db/schema";
import { DECIDED_STATUSES, STATUS_LABELS, isMoneyType } from "./model";
import type { ClaimTotals } from "./totals";

/**
 * Where a claim may go next, what each move needs, and what it stamps. Pure,
 * so the rules are tested without a database and a screen can grey out a move
 * before trying it.
 */

export type Transition = {
  from: ClaimStatus;
  to: ClaimStatus;
  /** The button's words. */
  action: string;
  /** Moves that change the outcome or undo one need a written reason. */
  note: "required" | "optional";
  /** Approving, denying and paying are for the assigned reviewer or an administrator. */
  decision: boolean;
  /** Only claims that ask for money make this move. */
  money: boolean;
};

const t = (
  from: ClaimStatus,
  to: ClaimStatus,
  action: string,
  note: Transition["note"],
  opts: { decision?: boolean; money?: boolean } = {},
): Transition => ({ from, to, action, note, decision: opts.decision ?? false, money: opts.money ?? false });

export const TRANSITIONS: readonly Transition[] = [
  t("draft", "submitted", "Submit", "optional"),
  t("draft", "closed", "Withdraw", "required"),
  t("submitted", "under_review", "Start review", "optional"),
  t("submitted", "draft", "Return to reporter", "required"),
  t("submitted", "closed", "Close", "required"),
  t("under_review", "approved", "Approve", "required", { decision: true, money: true }),
  t("under_review", "denied", "Deny", "required", { decision: true, money: true }),
  t("under_review", "draft", "Return to reporter", "required"),
  t("under_review", "closed", "Close", "required"),
  t("approved", "paid", "Mark paid", "required", { decision: true, money: true }),
  t("approved", "under_review", "Reopen", "required", { decision: true }),
  t("approved", "closed", "Close", "required"),
  t("denied", "under_review", "Reopen", "required", { decision: true }),
  t("denied", "closed", "Close", "optional"),
  t("paid", "closed", "Close", "optional"),
  t("closed", "under_review", "Reopen", "required", { decision: true }),
];

/** The moves open to a claim of this type in this status. */
export function transitionsFrom(type: ClaimType, status: ClaimStatus): Transition[] {
  const money = isMoneyType(type);
  return TRANSITIONS.filter((tr) => tr.from === status && (money || !tr.money));
}

export function findTransition(from: ClaimStatus, to: ClaimStatus): Transition | null {
  return TRANSITIONS.find((tr) => tr.from === from && tr.to === to) ?? null;
}

export type TransitionInput = {
  type: ClaimType;
  status: ClaimStatus;
  to: ClaimStatus;
  note: string | null | undefined;
  totals: ClaimTotals;
};

export type TransitionCheck =
  | { ok: true; transition: Transition }
  | {
      ok: false;
      code:
        | "same_status"
        | "not_allowed"
        | "incident_no_money"
        | "note_required"
        | "lines_required"
        | "lines_undecided"
        | "amount_required"
        | "nothing_to_pay";
      message: string;
    };

const label = (s: ClaimStatus) => STATUS_LABELS[s].toLowerCase();

/** Types that are about specific things, so they cannot be submitted without them. */
const NEEDS_LINES: readonly ClaimType[] = ["loss", "damage"];

export function checkTransition(input: TransitionInput): TransitionCheck {
  const { type, status, to, totals } = input;
  if (status === to) return { ok: false, code: "same_status", message: `It is already ${label(to)}.` };

  const tr = findTransition(status, to);
  if (tr && tr.money && !isMoneyType(type)) {
    return {
      ok: false,
      code: "incident_no_money",
      message: "Incident reports carry no money, so they are not approved, denied or paid. Close it instead.",
    };
  }
  if (!tr) {
    const options = transitionsFrom(type, status).map((o) => label(o.to));
    return {
      ok: false,
      code: "not_allowed",
      message: `A ${label(status)} ${type === "incident" ? "incident" : "claim"} cannot become ${label(to)}.${
        options.length ? ` From here it can become ${options.join(", ")}.` : ""
      }`,
    };
  }
  if (tr.note === "required" && !input.note?.trim()) {
    return { ok: false, code: "note_required", message: `Add a note saying why, to ${tr.action.toLowerCase()} it.` };
  }

  if (to === "submitted" && NEEDS_LINES.includes(type) && totals.lineCount === 0) {
    return {
      ok: false,
      code: "lines_required",
      message: `Add the ${type === "loss" ? "missing" : "damaged"} items before submitting.`,
    };
  }
  if (to === "approved") {
    if (totals.fromLines && totals.undecidedLines > 0) {
      const n = totals.undecidedLines;
      return {
        ok: false,
        code: "lines_undecided",
        message: `Decide every line first: ${n} line${n === 1 ? " has" : "s have"} no resolution or approved amount.`,
      };
    }
    if (!totals.fromLines && totals.approvedTotalCents === null) {
      return { ok: false, code: "amount_required", message: "Enter the approved amount before approving." };
    }
  }
  if (to === "paid" && !(totals.approvedTotalCents && totals.approvedTotalCents > 0)) {
    return {
      ok: false,
      code: "nothing_to_pay",
      message: "Nothing was approved, so there is nothing to pay. Close the claim instead.",
    };
  }
  return { ok: true, transition: tr };
}

// --- Timestamps and the SLA ---------------------------------------------------

export type ClaimClock = {
  status: ClaimStatus;
  submittedAt: Date | null;
  decidedAt: Date | null;
  paidAt: Date | null;
  closedAt: Date | null;
  slaDueAt: Date | null;
  slaBreachedAt: Date | null;
};

const HOUR = 60 * 60_000;

/**
 * The clock fields a move sets. Submitting starts the SLA; a decision (or, for
 * an incident or a withdrawn claim, closing) stops it; reopening starts a
 * fresh one; returning to the reporter clears it until it comes back.
 */
export function transitionStamps(
  from: ClaimClock,
  to: ClaimStatus,
  now: Date,
  slaHours: number,
): Partial<ClaimClock> {
  const fresh = { slaDueAt: new Date(now.getTime() + slaHours * HOUR), slaBreachedAt: null };
  switch (to) {
    case "draft":
      return { submittedAt: null, decidedAt: null, slaDueAt: null, slaBreachedAt: null };
    case "submitted":
      return { submittedAt: now, decidedAt: null, closedAt: null, ...fresh };
    case "under_review":
      // From submitted the clock is already running. From a decision it is a
      // reopening, which gets a review window of its own.
      if ((DECIDED_STATUSES as readonly string[]).includes(from.status)) {
        return { decidedAt: null, closedAt: null, paidAt: null, ...fresh };
      }
      return from.submittedAt ? {} : { submittedAt: now, ...fresh };
    case "approved":
    case "denied":
      return { decidedAt: now };
    case "paid":
      return { paidAt: now };
    case "closed":
      return { closedAt: now, decidedAt: from.decidedAt ?? now };
  }
}

export type SlaState = "none" | "running" | "due_soon" | "overdue" | "met" | "missed";

export type Sla = {
  state: SlaState;
  dueAt: Date | null;
  /** Until due (negative when overdue), for a running clock. */
  remainingMs: number | null;
};

/** A running clock counts as due soon inside its last day. */
export const DUE_SOON_MS = 24 * HOUR;

export function computeSla(clock: Pick<ClaimClock, "status" | "decidedAt" | "slaDueAt">, now: Date): Sla {
  const due = clock.slaDueAt;
  if (!due) return { state: "none", dueAt: null, remainingMs: null };
  if (clock.decidedAt || (DECIDED_STATUSES as readonly string[]).includes(clock.status)) {
    const at = clock.decidedAt ?? now;
    return { state: at.getTime() <= due.getTime() ? "met" : "missed", dueAt: due, remainingMs: null };
  }
  if (clock.status === "draft") return { state: "none", dueAt: null, remainingMs: null };
  const remaining = due.getTime() - now.getTime();
  const state: SlaState = remaining < 0 ? "overdue" : remaining <= DUE_SOON_MS ? "due_soon" : "running";
  return { state, dueAt: due, remainingMs: remaining };
}
