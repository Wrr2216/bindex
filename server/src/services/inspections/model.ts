import type { FindingArea, FindingSeverity, InspectionKind, InspectionStatus } from "../../db/schema";

/**
 * The vocabulary of inspections. Pure, so the pairing logic, the report and
 * the client can all share it without touching the database.
 */

export const INSPECTION_KINDS = ["pre", "post", "adhoc"] as const satisfies readonly InspectionKind[];
export const INSPECTION_STATUSES = ["draft", "completed", "signed"] as const satisfies readonly InspectionStatus[];
export const AREAS = ["inside", "outside"] as const satisfies readonly FindingArea[];
export const SEVERITIES = ["minor", "moderate", "major"] as const satisfies readonly FindingSeverity[];

/**
 * Where on a building damage is. The residential list (wall, baseboard, trim,
 * door) plus what a commercial site adds: dock doors, elevators, stairs.
 */
export const SPOTS = [
  "wall",
  "floor",
  "baseboard",
  "trim",
  "door",
  "frame",
  "ceiling",
  "window",
  "elevator",
  "dock",
  "stairs",
  "fixture",
  "other",
] as const;
export type Spot = (typeof SPOTS)[number];

export const KIND_LABEL: Record<InspectionKind, string> = {
  pre: "Pre-move inspection",
  post: "Post-move inspection",
  adhoc: "Site inspection",
};

export const STATUS_LABEL: Record<InspectionStatus, string> = {
  draft: "Draft",
  completed: "Completed",
  signed: "Signed",
};

export const SPOT_LABEL: Record<Spot, string> = {
  wall: "Wall",
  floor: "Floor",
  baseboard: "Baseboard",
  trim: "Trim",
  door: "Door",
  frame: "Door or window frame",
  ceiling: "Ceiling",
  window: "Window",
  elevator: "Elevator",
  dock: "Dock or dock door",
  stairs: "Stairs",
  fixture: "Fixture",
  other: "Other",
};

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  minor: "Minor",
  moderate: "Moderate",
  major: "Major",
};

export const AREA_LABEL: Record<FindingArea, string> = { inside: "Inside", outside: "Outside" };

/** Hex colours shared by the PDF, the share page and the client. */
export const SEVERITY_COLOR: Record<FindingSeverity, string> = {
  minor: "#ca8a04",
  moderate: "#ea580c",
  major: "#dc2626",
};

export const severityRank = (s: FindingSeverity): number => SEVERITIES.indexOf(s) + 1;

export const isSpot = (s: string): s is Spot => (SPOTS as readonly string[]).includes(s);
export const spotLabel = (s: string): string => (isSpot(s) ? SPOT_LABEL[s] : s.replace(/_/g, " "));

/** The job task a completed inspection closes. An ad hoc inspection closes none. */
export const TASK_KIND_FOR: Record<InspectionKind, string | null> = {
  pre: "pre_inspection",
  post: "post_inspection",
  adhoc: null,
};

/** The two sign-offs a report asks for. */
export const SIGNOFF_ROLES = ["facility_contact", "crew_lead"] as const;
export type SignoffRole = (typeof SIGNOFF_ROLES)[number];
export const SIGNOFF_LABEL: Record<SignoffRole, string> = {
  facility_contact: "Facility contact",
  crew_lead: "Crew lead",
};

/**
 * The words a signer agrees to. Stored verbatim with each signature, so the
 * wording can change here without affecting what earlier signers saw.
 */
export function signStatement(kind: InspectionKind, siteName: string, role: SignoffRole): string {
  const what =
    kind === "pre"
      ? "before the move"
      : kind === "post"
        ? "after the move, and the comparison with the pre-move inspection"
        : "at the time of inspection";
  const as = role === "facility_contact" ? "for the facility" : "for the crew";
  return (
    `I have reviewed this ${KIND_LABEL[kind].toLowerCase()} of ${siteName}. ` +
    `Signing ${as}, I agree that it records the condition of the site ${what}, including every finding and photo listed.`
  );
}
