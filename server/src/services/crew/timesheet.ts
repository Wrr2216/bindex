import ExcelJS from "exceljs";
import { and, asc, eq, gte, lt, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { crewCheckins, crewWorkers, jobs, type ComplianceLight } from "../../db/schema";
import { badRequest } from "../../lib/errors";
import { addDays, daysBetween, isDateOnly, localDate, localParts, shiftMinutes, toHours, worstLight, zonedMidnight } from "./model";

/**
 * Hours on jobs: who was there, when, and for how long, per job and date range,
 * as JSON for the screen and as a workbook for payroll and client billing.
 *
 * A shift belongs to the day it started on, in the viewer's time zone, so a
 * night shift from 22:00 to 06:00 is one row on the first day. A shift still
 * open counts up to the moment the report is made and is marked open.
 */

export type TimesheetFilters = { jobId?: string; workerId?: string; from?: string; to?: string; tz?: string };

export type TimesheetRow = {
  checkinId: string;
  day: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  workerId: string;
  workerName: string;
  company: string | null;
  role: string | null;
  badgeCode: string;
  checkedInAt: Date;
  checkedOutAt: Date | null;
  breakMinutes: number;
  minutes: number;
  open: boolean;
  compliance: ComplianceLight;
  overrideReason: string | null;
  overriddenByName: string | null;
  checkedInByName: string | null;
  checkedOutByName: string | null;
  via: string;
  notes: string | null;
};

export type RosterRow = {
  jobId: string;
  jobCode: string;
  jobName: string;
  workerId: string;
  workerName: string;
  company: string | null;
  role: string | null;
  badgeCode: string;
  shifts: number;
  minutes: number;
  firstIn: Date;
  lastOut: Date | null;
  onSite: boolean;
  compliance: ComplianceLight;
  overrides: number;
};

// A workbook with a column per day stays readable up to about two months.
const MAX_DAY_COLUMNS = 62;
const MAX_ROWS = 50_000;

function checkRange(filters: TimesheetFilters): void {
  for (const [k, v] of [["from", filters.from], ["to", filters.to]] as const) {
    if (v && !isDateOnly(v)) throw badRequest(`${k} must be a date such as 2026-09-01.`);
  }
  if (filters.from && filters.to && filters.to < filters.from) throw badRequest("The range ends before it starts.");
}

export async function timesheetRows(filters: TimesheetFilters): Promise<TimesheetRow[]> {
  checkRange(filters);
  const conds: SQL[] = [];
  if (filters.jobId) conds.push(eq(crewCheckins.jobId, filters.jobId));
  if (filters.workerId) conds.push(eq(crewCheckins.workerId, filters.workerId));
  if (filters.from) conds.push(gte(crewCheckins.checkedInAt, zonedMidnight(filters.from, filters.tz)));
  if (filters.to) conds.push(lt(crewCheckins.checkedInAt, zonedMidnight(addDays(filters.to, 1), filters.tz)));
  const rows = await db
    .select({
      checkin: crewCheckins,
      jobCode: jobs.code,
      jobName: jobs.name,
      workerName: crewWorkers.name,
      company: crewWorkers.company,
      role: crewWorkers.role,
      badgeCode: crewWorkers.badgeCode,
    })
    .from(crewCheckins)
    .innerJoin(jobs, eq(jobs.id, crewCheckins.jobId))
    .innerJoin(crewWorkers, eq(crewWorkers.id, crewCheckins.workerId))
    .where(and(...conds))
    .orderBy(asc(crewCheckins.checkedInAt))
    .limit(MAX_ROWS);
  const now = new Date();
  return rows.map(({ checkin: c, ...r }) => ({
    checkinId: c.id,
    day: localDate(c.checkedInAt, filters.tz),
    jobId: c.jobId,
    jobCode: r.jobCode,
    jobName: r.jobName,
    workerId: c.workerId,
    workerName: r.workerName,
    company: r.company,
    role: r.role,
    badgeCode: r.badgeCode,
    checkedInAt: c.checkedInAt,
    checkedOutAt: c.checkedOutAt,
    breakMinutes: c.breakMinutes,
    minutes: shiftMinutes(c.checkedInAt, c.checkedOutAt, c.breakMinutes, now),
    open: c.checkedOutAt === null,
    compliance: c.compliance,
    overrideReason: c.overrideReason,
    overriddenByName: c.overriddenByName,
    checkedInByName: c.checkedInByName,
    checkedOutByName: c.checkedOutByName,
    via: c.via,
    notes: c.notes,
  }));
}

/** One line per worker per job: the roster, with totals. */
export function rosterFromRows(rows: TimesheetRow[]): RosterRow[] {
  const byKey = new Map<string, RosterRow>();
  for (const r of rows) {
    const key = `${r.jobId}:${r.workerId}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        jobId: r.jobId,
        jobCode: r.jobCode,
        jobName: r.jobName,
        workerId: r.workerId,
        workerName: r.workerName,
        company: r.company,
        role: r.role,
        badgeCode: r.badgeCode,
        shifts: 1,
        minutes: r.minutes,
        firstIn: r.checkedInAt,
        lastOut: r.checkedOutAt,
        onSite: r.open,
        compliance: r.compliance,
        overrides: r.overrideReason ? 1 : 0,
      });
      continue;
    }
    cur.shifts += 1;
    cur.minutes += r.minutes;
    if (r.checkedInAt < cur.firstIn) cur.firstIn = r.checkedInAt;
    if (r.checkedOutAt && (!cur.lastOut || r.checkedOutAt > cur.lastOut)) cur.lastOut = r.checkedOutAt;
    cur.onSite ||= r.open;
    cur.compliance = worstLight([cur.compliance, r.compliance]);
    if (r.overrideReason) cur.overrides += 1;
  }
  return [...byKey.values()].sort((a, b) => a.jobCode.localeCompare(b.jobCode) || a.workerName.localeCompare(b.workerName));
}

/** Hours per worker per day, for the day-by-day sheet. */
export function hoursByDay(rows: TimesheetRow[]): { days: string[]; workers: { name: string; company: string | null; byDay: Map<string, number>; minutes: number }[] } {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const workers = new Map<string, { name: string; company: string | null; byDay: Map<string, number>; minutes: number }>();
  for (const r of rows) {
    const w = workers.get(r.workerId) ?? { name: r.workerName, company: r.company, byDay: new Map<string, number>(), minutes: 0 };
    w.byDay.set(r.day, (w.byDay.get(r.day) ?? 0) + r.minutes);
    w.minutes += r.minutes;
    workers.set(r.workerId, w);
  }
  return { days, workers: [...workers.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

const LIGHT_WORD: Record<ComplianceLight, string> = { green: "OK", amber: "Expiring", red: "Not compliant" };
const LIGHT_FILL: Record<ComplianceLight, string> = { green: "FFD1FAE5", amber: "FFFEF3C7", red: "FFFEE2E2" };

export async function timesheetXlsx(filters: TimesheetFilters, title: string): Promise<Buffer> {
  const rows = await timesheetRows(filters);
  const tz = filters.tz || "UTC";
  // Excel has no time zones: write each time as the wall clock of the site.
  const wall = (d: Date | null) => {
    if (!d) return null;
    const p = localParts(d, tz);
    return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
  };
  const range =
    filters.from || filters.to ? `${filters.from ?? "the start"} to ${filters.to ?? localDate(new Date(), tz)}` : "all dates";
  const subtitle = `${range} · times in ${tz} · made ${localDate(new Date(), tz)}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Bindex";
  wb.created = new Date();

  const heading = (ws: ExcelJS.Worksheet, columns: number) => {
    ws.addRow([title]).font = { bold: true, size: 14 };
    ws.addRow([subtitle]).font = { italic: true, color: { argb: "FF64748B" } };
    ws.addRow([]);
    ws.mergeCells(1, 1, 1, Math.max(1, columns));
    ws.mergeCells(2, 1, 2, Math.max(1, columns));
  };
  const header = (ws: ExcelJS.Worksheet, labels: string[], widths: number[]) => {
    const row = ws.addRow(labels);
    row.font = { bold: true };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    labels.forEach((_, i) => (ws.getColumn(i + 1).width = widths[i] ?? 14));
    ws.views = [{ state: "frozen", ySplit: row.number }];
    ws.autoFilter = { from: { row: row.number, column: 1 }, to: { row: row.number, column: labels.length } };
  };

  // Roster: who was on each job, and for how long.
  const roster = wb.addWorksheet("Roster");
  const rosterCols = ["Job", "Job name", "Worker", "Company", "Role", "Badge", "Shifts", "First in", "Last out", "Hours", "Compliance at check-in", "Overrides"];
  heading(roster, rosterCols.length);
  header(roster, rosterCols, [12, 26, 24, 20, 16, 14, 8, 18, 18, 9, 22, 10]);
  for (const r of rosterFromRows(rows)) {
    const row = roster.addRow([
      r.jobCode,
      r.jobName,
      r.workerName,
      r.company,
      r.role,
      r.badgeCode,
      r.shifts,
      wall(r.firstIn),
      r.onSite ? "on site" : wall(r.lastOut),
      toHours(r.minutes),
      LIGHT_WORD[r.compliance],
      r.overrides,
    ]);
    row.getCell(8).numFmt = "yyyy-mm-dd hh:mm";
    row.getCell(9).numFmt = "yyyy-mm-dd hh:mm";
    row.getCell(10).numFmt = "0.00";
    row.getCell(11).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_FILL[r.compliance] } };
  }

  // Timesheet: every shift.
  const sheet = wb.addWorksheet("Timesheet");
  const sheetCols = [
    "Date",
    "Job",
    "Worker",
    "Company",
    "Badge",
    "In",
    "Out",
    "Break (min)",
    "Hours",
    "Compliance",
    "Override reason",
    "Overridden by",
    "Checked in by",
    "Checked out by",
    "Via",
    "Notes",
  ];
  heading(sheet, sheetCols.length);
  header(sheet, sheetCols, [11, 12, 24, 20, 14, 16, 16, 10, 8, 14, 30, 18, 18, 18, 8, 30]);
  for (const r of rows) {
    const row = sheet.addRow([
      r.day,
      r.jobCode,
      r.workerName,
      r.company,
      r.badgeCode,
      wall(r.checkedInAt),
      r.open ? "on site" : wall(r.checkedOutAt),
      r.breakMinutes,
      toHours(r.minutes),
      LIGHT_WORD[r.compliance],
      r.overrideReason,
      r.overriddenByName,
      r.checkedInByName,
      r.checkedOutByName,
      r.via,
      r.notes,
    ]);
    row.getCell(6).numFmt = "yyyy-mm-dd hh:mm";
    row.getCell(7).numFmt = "yyyy-mm-dd hh:mm";
    row.getCell(9).numFmt = "0.00";
    row.getCell(10).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_FILL[r.compliance] } };
  }
  if (rows.length) {
    const total = sheet.addRow(["", "", "Total", "", "", "", "", "", toHours(rows.reduce((s, r) => s + r.minutes, 0))]);
    total.font = { bold: true };
    total.getCell(9).numFmt = "0.00";
  }

  // Hours by day, when the range is short enough to fit across a sheet.
  const byDay = hoursByDay(rows);
  const span =
    byDay.days.length > 1 ? daysBetween(byDay.days[0]!, byDay.days[byDay.days.length - 1]!) + 1 : byDay.days.length;
  if (span > 0 && span <= MAX_DAY_COLUMNS) {
    const days: string[] = [];
    for (let i = 0; i < span; i++) days.push(addDays(byDay.days[0]!, i));
    const ws = wb.addWorksheet("Hours by day");
    const cols = ["Worker", "Company", ...days, "Total"];
    heading(ws, cols.length);
    header(ws, cols, [24, 20, ...days.map(() => 11), 9]);
    for (const w of byDay.workers) {
      const row = ws.addRow([w.name, w.company, ...days.map((d) => (w.byDay.has(d) ? toHours(w.byDay.get(d)!) : null)), toHours(w.minutes)]);
      for (let i = 3; i <= cols.length; i++) row.getCell(i).numFmt = "0.00";
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
