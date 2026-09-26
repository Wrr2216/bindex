/**
 * Working hours, for the "tag changed room out of hours" alert.
 *
 *   Mon-Fri 07:00-19:00; Sat 08:00-12:00
 *   Daily 06:00-22:00
 *   Mon,Wed,Fri 22:00-06:00        (overnight: runs into the next morning)
 *   Mon-Fri 07:00-12:00, 13:00-17:00
 *
 * Groups are separated by semicolons. Each is a set of days (a range, a comma
 * list, or Daily) and one or more time ranges. Pure: no clock, no environment.
 */

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Minutes after midnight, [start, end), per day of the week (0 = Sunday). */
export type WorkSchedule = { text: string; days: Array<Array<[number, number]>> };

function dayIndex(token: string): number {
  const i = DAYS.indexOf(token.trim().slice(0, 3).toLowerCase());
  if (i < 0) throw new Error(`"${token.trim()}" is not a day. Use Mon, Tue, Wed, Thu, Fri, Sat or Sun.`);
  return i;
}

function parseDays(spec: string): number[] {
  const s = spec.trim().toLowerCase();
  if (s === "daily" || s === "every day" || s === "all") return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const [from, to] = part.split("-");
    if (to === undefined) {
      out.add(dayIndex(from!));
      continue;
    }
    const a = dayIndex(from!);
    const b = dayIndex(to);
    // Wraps past Saturday: Fri-Mon is Fri, Sat, Sun, Mon.
    for (let d = a; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === b) break;
    }
  }
  return [...out];
}

function minutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`"${hhmm.trim()}" is not a time. Use 24-hour HH:MM, such as 07:30.`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`"${hhmm.trim()}" is not a time of day.`);
  return h * 60 + min;
}

/**
 * Parse a schedule. Throws an Error that says what is wrong, for the log;
 * callers treat a bad schedule as none, so the alert quietly stays off.
 */
export function parseWorkHours(text: string): WorkSchedule {
  const days: Array<Array<[number, number]>> = [[], [], [], [], [], [], []];
  const groups = text.split(";").map((g) => g.trim()).filter(Boolean);
  if (!groups.length) throw new Error("No working hours given.");
  for (const group of groups) {
    const m = /^(.+?)\s+(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})*)$/.exec(group);
    if (!m) throw new Error(`"${group}" should look like "Mon-Fri 07:00-19:00".`);
    const dayList = parseDays(m[1]!);
    for (const range of m[2]!.split(",")) {
      const [a, b] = range.split("-");
      const start = minutes(a!);
      const end = minutes(b!);
      if (start === end) throw new Error(`"${range.trim()}" starts and ends at the same time.`);
      for (const d of dayList) {
        if (start < end) days[d]!.push([start, end]);
        else {
          // Overnight: the rest of this day, then the next morning.
          days[d]!.push([start, 24 * 60]);
          if (end > 0) days[(d + 1) % 7]!.push([0, end]);
        }
      }
    }
  }
  return { text: text.trim(), days };
}

/** Weekday and minute of the day for `date` in `timeZone` (the server's when omitted). */
export function localTime(date: Date, timeZone?: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || undefined,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  return { day: dayIndex(get("weekday")), minute: hour * 60 + Number(get("minute")) };
}

export function isWorkingTime(date: Date, schedule: WorkSchedule, timeZone?: string): boolean {
  const { day, minute } = localTime(date, timeZone);
  return schedule.days[day]!.some(([start, end]) => minute >= start && minute < end);
}

/** Whether a time zone name is one this runtime knows. */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
