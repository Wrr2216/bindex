import type { MergeContext } from "./merge";

/**
 * A made-up job for previewing a template before any real job exists. Every
 * merge field in the catalog has a value here, so a placeholder the preview
 * reports as unknown is a typo, not a missing sample.
 */
export function sampleContext(org: { orgName: string; appName: string }): MergeContext {
  return {
    job: {
      id: "00000000-0000-4000-8000-000000000000",
      code: "JOB-SAMPLE",
      name: "Floor 3 to Level 5 relocation",
      type: "IT relocation",
      status: "in_progress",
      origin: "Floor 3",
      destination: "Level 5",
      originPath: "Old HQ / Floor 3",
      destinationPath: "New HQ / Level 5",
      scheduledStart: "2026-10-02T13:00:00.000Z",
      scheduledEnd: "2026-10-04T22:00:00.000Z",
      startedAt: "2026-10-02T13:12:00.000Z",
      completedAt: null,
      notes: "Loading dock B, freight lift booked 7am to 3pm.",
      metadata: { ticket: "CHG-10442", costCentre: "4100" },
    },
    project: {
      code: "PRJ-SAMPLE",
      name: "Head office consolidation",
      status: "active",
      client: "Northwind Holdings",
      startsOn: "2026-09-28",
      endsOn: "2026-11-30",
    },
    phase: { name: "Phase 2: Floor 3", startsOn: "2026-10-02", endsOn: "2026-10-04" },
    manifest: { count: 59, floors: "5", departments: "Finance, Legal", packed: 42, loaded: 30, delivered: 0, placed: 0 },
    shipments: { count: 2, codes: "SHP-4Q2M9T, SHP-8T1W3E" },
    tasks: { count: 3, done: 1 },
    org: { name: org.orgName || org.appName },
    app: { name: org.appName },
  };
}
