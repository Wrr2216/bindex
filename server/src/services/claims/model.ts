import type { ClaimResolution, ClaimStatus, ClaimType } from "../../db/schema";

/**
 * The vocabulary of claims and incident reports. Pure: safe to import from
 * anywhere, including tests that have no database.
 */

export const CLAIM_TYPES = ["loss", "damage", "property_damage", "delay", "other", "incident"] as const satisfies readonly ClaimType[];

/** Types that ask for money. An incident records what happened and nothing more. */
export const MONEY_TYPES = ["loss", "damage", "property_damage", "delay", "other"] as const satisfies readonly ClaimType[];

export const CLAIM_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "approved",
  "denied",
  "paid",
  "closed",
] as const satisfies readonly ClaimStatus[];

/** Still being worked on: the SLA clock runs for the last two. */
export const OPEN_STATUSES = ["draft", "submitted", "under_review"] as const satisfies readonly ClaimStatus[];

/** A decision has been made; the SLA clock has stopped. */
export const DECIDED_STATUSES = ["approved", "denied", "paid", "closed"] as const satisfies readonly ClaimStatus[];

export const RESOLUTIONS = ["repair", "replace", "cash", "deny"] as const satisfies readonly ClaimResolution[];

export type TypeInfo = { type: ClaimType; label: string; money: boolean; description: string };

export const TYPE_INFO: Record<ClaimType, TypeInfo> = {
  loss: { type: "loss", label: "Loss", money: true, description: "Something did not arrive or cannot be found." },
  damage: { type: "damage", label: "Damage", money: true, description: "Something arrived damaged." },
  property_damage: {
    type: "property_damage",
    label: "Property damage",
    money: true,
    description: "A building, floor, wall or fixture was damaged during the work.",
  },
  delay: { type: "delay", label: "Delay", money: true, description: "A delivery was late and it cost money." },
  other: { type: "other", label: "Other", money: true, description: "Anything else that asks for money back." },
  incident: {
    type: "incident",
    label: "Incident",
    money: false,
    description: "Something went wrong and has to be recorded: a near miss, site damage, equipment failure.",
  },
};

/** Incident categories. Stored as plain text, so a later version can add more without a migration. */
export const INCIDENT_CATEGORIES = [
  { name: "near_miss", label: "Near miss" },
  { name: "site_damage", label: "Site damage" },
  { name: "equipment_failure", label: "Equipment failure" },
  { name: "vehicle", label: "Vehicle" },
  { name: "injury", label: "Injury" },
  { name: "security", label: "Security or theft" },
  { name: "other", label: "Other" },
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number]["name"];

export const RESOLUTION_LABELS: Record<ClaimResolution, string> = {
  repair: "Repair",
  replace: "Replace",
  cash: "Cash settlement",
  deny: "Deny",
};

export const STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  under_review: "Under review",
  approved: "Approved",
  denied: "Denied",
  paid: "Paid",
  closed: "Closed",
};

export const isClaimType = (v: string): v is ClaimType => (CLAIM_TYPES as readonly string[]).includes(v);
export const isMoneyType = (t: ClaimType): boolean => TYPE_INFO[t].money;
export const isIncidentCategory = (v: string): v is IncidentCategory => INCIDENT_CATEGORIES.some((c) => c.name === v);
export const isOpen = (s: ClaimStatus): boolean => (OPEN_STATUSES as readonly string[]).includes(s);

/**
 * Printed codes: CLM-7F3K2A for a claim, INC-7F3K2A for an incident report,
 * in the same Crockford alphabet as asset and job codes so one read off a
 * form over the phone cannot turn into another.
 */
export const codePrefix = (type: ClaimType): "CLM" | "INC" => (type === "incident" ? "INC" : "CLM");
