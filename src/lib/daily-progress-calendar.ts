import { fixedClock } from "./clock.js";

export const DEFAULT_DAILY_PROGRESS_ZONE = "America/New_York";
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,127}$/.test(timeZone)) throw new RangeError("invalid reporting zone");
  let held = formatters.get(timeZone);
  if (!held) {
    held = new Intl.DateTimeFormat("en-CA", { timeZone, calendar: "iso8601", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    if (formatters.size < 256) formatters.set(timeZone, held);
  }
  return held;
}

function parts(at: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(formatter(timeZone).formatToParts(fixedClock(at).date()).map(p => [p.type, p.value]));
}

export function dailyDateAt(at: number, timeZone = DEFAULT_DAILY_PROGRESS_ZONE): string {
  if (!Number.isFinite(at)) throw new RangeError("invalid reporting clock");
  const p = parts(at, timeZone);
  return `${p.year!.padStart(4, "0")}-${p.month}-${p.day}`;
}

function civilUtc(date: string): number {
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new RangeError("invalid civil date");
  const at = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(at) || fixedClock(at).iso().slice(0, 10) !== date) throw new RangeError("invalid civil date");
  return at;
}

export function shiftDailyDate(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new RangeError("invalid calendar displacement");
  const at = fixedClock(civilUtc(date)).date();
  at.setUTCDate(at.getUTCDate() + days);
  const result = at.toISOString().slice(0, 10);
  civilUtc(result);
  return result;
}

const dayStarts = new Map<string, number>();
/** Find the first real instant of a civil date, including repeated and skipped midnight.
 * Local date labels can briefly go backwards (St Johns 2010); a binary search over date
 * labels alone would omit that first occurrence. Compare offset candidates and transitions. */
function midnight(date: string, timeZone: string): number {
  const target = civilUtc(date), key = `${timeZone}:${date}`, cached = dayStarts.get(key);
  if (cached !== undefined) return cached;
  // PRIMARY CONTROL: all IANA offsets fit in this 72-hour bracket. Hourly offset observations
  // locate the zone's transitions; refine changed brackets to the exact millisecond.
  const hour = 3_600_000, lower = target - 36 * hour, upper = target + 36 * hour;
  const offset = (at: number): number => {
    const p = parts(at, timeZone);
    return Date.parse(`${p.year!.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`) - Math.floor(at / 1000) * 1000;
  };
  const offsets = new Set<number>(), candidates = new Set<number>();
  let previous = lower, previousOffset = offset(previous); offsets.add(previousOffset);
  for (let at = lower + hour; at <= upper; at += hour) {
    const currentOffset = offset(at); offsets.add(currentOffset);
    if (currentOffset !== previousOffset) {
      let lo = previous, hi = at;
      while (hi - lo > 1) {
        const middle = lo + Math.floor((hi - lo) / 2);
        if (offset(middle) === previousOffset) lo = middle; else hi = middle;
      }
      candidates.add(hi);
    }
    previous = at; previousOffset = currentOffset;
  }
  for (const value of offsets) candidates.add(target - value);
  const starts = [...candidates].filter(at => dailyDateAt(at, timeZone) === date && dailyDateAt(at - 1, timeZone) !== date);
  if (!starts.length) throw new RangeError("the reporting date has no actual local start");
  const start = Math.min(...starts);
  // BACKSTOP: finite reusable calendar cache; new zones or dates never grow it indefinitely.
  if (dayStarts.size >= 512) dayStarts.delete(dayStarts.keys().next().value!);
  dayStarts.set(key, start);
  return start;
}

export function dailyWindow(date: string, timeZone = DEFAULT_DAILY_PROGRESS_ZONE): { reportDate: string; timeZone: string; windowStart: string; windowEnd: string } {
  const start = midnight(date, timeZone), end = midnight(shiftDailyDate(date, 1), timeZone);
  if (end <= start) throw new RangeError("invalid reporting interval");
  return { reportDate: date, timeZone, windowStart: fixedClock(start).iso(), windowEnd: fixedClock(end).iso() };
}

export function resolveDailyDate(date: string, at: number, timeZone = DEFAULT_DAILY_PROGRESS_ZONE): string {
  const resolved = date === "today" ? dailyDateAt(at, timeZone)
    : date === "yesterday" ? shiftDailyDate(dailyDateAt(at, timeZone), -1) : date;
  dailyWindow(resolved, timeZone);
  return resolved;
}

/** The next elapsed hourly slot or next civil midnight, whichever comes first. */
export function nextDailyDue(at: number, timeZone = DEFAULT_DAILY_PROGRESS_ZONE): number {
  const { windowEnd } = dailyWindow(dailyDateAt(at, timeZone), timeZone);
  return Math.min((Math.floor(at / 3_600_000) + 1) * 3_600_000, Date.parse(windowEnd));
}
