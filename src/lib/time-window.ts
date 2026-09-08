/**
 * `utcWeekWindowMs` — split out of `sweep.ts` (W1-T2895) into a LEAF module. `retro.ts` imported
 * it from `sweep.ts`, and `cost-anomaly.ts -> retro.ts -> sweep.ts -> cost-anomaly.ts` was one of
 * thirteen import cycles `npm run cycle-ratchet` tolerated (`.dependency-cruiser.cjs`'s
 * `no-circular` rule). This module imports nothing, so `retro.ts` importing it directly instead
 * of through `sweep.ts` breaks that ring at this edge. `sweep.ts` re-exports the name unchanged
 * for its own internal use.
 */

/** `[start, end)` of `now`'s UTC calendar day, in epoch ms — the day-cost window boundary, factored
 *  out so a "merged today" tally (lib/glance.ts, W1-T159) and week-window derivation agree on
 *  exactly what "today" means rather than each computing its own midnight. */
export function utcDayWindowMs(now: number): [start: number, end: number] {
  const day = new Date(now).toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return [start, start + 24 * 60 * 60 * 1000];
}

/** `[start, end)` of the CURRENT UTC ISO week (Monday 00:00 UTC through the following Monday
 *  00:00 UTC) containing `now`, in epoch ms — the week-to-date spend window (W1-T159). */
export function utcWeekWindowMs(now: number): [start: number, end: number] {
  const [dayStart] = utcDayWindowMs(now);
  const dayOfWeek = new Date(dayStart).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const weekStart = dayStart - daysSinceMonday * 24 * 60 * 60 * 1000;
  return [weekStart, weekStart + 7 * 24 * 60 * 60 * 1000];
}
