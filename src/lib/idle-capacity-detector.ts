import { fixedClock } from "./clock.js";
import { IDLE_LANE_SUMMARY_WINDOW_MS } from "./idle-lane-accounting.js";
import type {
  FleetFlowDetector,
  FleetFlowFinding,
  FleetFlowHistory,
  FleetFlowPolicy,
  FleetFlowRow,
} from "./fleet-flow-detectors.js";

/**
 * W1-T8238: idle lane capacity behind a hold is an incident.
 *
 * MEASURED 2026-10-11: core lanes sat empty with work queued behind a serve-restoration pause (four windows), a
 * 52-minute recycle drain and repeated restart latches, and a person found each one by reading the ledger.
 *
 * No fixed threshold. A hold's normal length is learned from the hold itself: this detector integrates the idle
 * lane-SLOT minutes each cause cost (from W1-T8235's `lane.idle_changed` rows) and the shared evaluator judges
 * that figure against `ownHistoryBound` over the same cause's earlier per-window slot-minutes (the population a
 * `lane.idle_summary` row's `slot_minutes_by_cause` records). A cause with too little history of its own — the
 * first operator pause of its kind — is judged against the all-cause idle population, never given a free pass.
 *
 * The finding names the HOLD (reason, setter, since) and never guesses a fix; whether a pause is foreign is
 * W1-T8245's judgement, not this detector's.
 */

/** The population a cause with no history of its own is judged against: every cause's idle slot-minutes. */
export const ALL_CAUSE_IDLE_POPULATION = "all-cause";

/** PRIMARY CONTROL: the sampling history and windows used to judge idle capacity. */
export const IDLE_CAPACITY_POLICY: FleetFlowPolicy = {
  minSamples: 5,
  maxSamples: 288,
  // The idle summary window; the short confirming window is 1/12 of it.
  longMs: IDLE_LANE_SUMMARY_WINDOW_MS,
};

const MS_PER_MINUTE = 60_000;

interface Interval {
  cause: string;
  hold: Record<string, unknown> | null;
  slots: number;
  dispatchable: number;
  startMs: number;
  endMs: number;
}

function rowMs(row: FleetFlowRow): number {
  if (typeof row.at_ms === "number" && Number.isFinite(row.at_ms)) return row.at_ms;
  return typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
}

function holdOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Each `lane.idle_changed` row holds until the next one; the last holds until `nowMs`. A row without a time is skipped. */
function intervalsOf(rows: readonly FleetFlowRow[], nowMs: number, fromMs: number): Interval[] {
  const changes = rows
    .filter((row) => row.step === "lane.idle_changed")
    .map((row) => ({ row, at: rowMs(row) }))
    .filter((c) => Number.isFinite(c.at) && c.at <= nowMs)
    .sort((a, b) => a.at - b.at);
  const out: Interval[] = [];
  changes.forEach(({ row }, i) => {
    const startMs = Math.max(changes[i]!.at, fromMs);
    const endMs = i + 1 < changes.length ? changes[i + 1]!.at : nowMs;
    const slots = typeof row.idle_slots === "number" ? row.idle_slots : 0;
    const dispatchable = typeof row.dispatchable === "number" ? row.dispatchable : 0;
    if (typeof row.cause !== "string" || slots <= 0 || dispatchable <= 0 || endMs <= startMs) return;
    out.push({ cause: row.cause, hold: holdOf(row.hold), slots, dispatchable, startMs, endMs });
  });
  return out;
}

/** A value for a runbook's `key=value` subject: whitespace-free, so `\S+` reads all of it. */
function token(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, "_");
  return cleaned.length === 0 ? "unnamed" : cleaned;
}

function reasonOf(hold: Record<string, unknown> | null, cause: string): string {
  return typeof hold?.reason === "string" && hold.reason.trim() !== "" ? hold.reason : `${cause}:unnamed`;
}

/** The setter as the hold recorded it: session id, else pid, else actor; "unrecorded" when it names none. */
function setterOf(hold: Record<string, unknown> | null): string {
  if (typeof hold?.session_id === "string" && hold.session_id !== "") return hold.session_id;
  if (typeof hold?.pid === "string" || typeof hold?.pid === "number") return String(hold.pid);
  return typeof hold?.actor === "string" && hold.actor !== "" ? hold.actor : "unrecorded";
}

function hasOwnHistory(history: FleetFlowHistory, cause: string, policy: FleetFlowPolicy): boolean {
  return history.filter((s) => s.population === cause && Number.isFinite(s.measured)).length >= policy.minSamples;
}

interface Group {
  cause: string;
  reason: string;
  setter: string;
  slotMinutes: number;
  sinceMs: number;
  dispatchable: number;
}

function findingsOf(
  groups: Iterable<Group>, instance: string, history: FleetFlowHistory, policy: FleetFlowPolicy,
): FleetFlowFinding[] {
  const out: FleetFlowFinding[] = [];
  for (const g of groups) {
    const subject = `instance=${token(instance)} hold=${token(g.reason)} setter=${token(g.setter)}`;
    const name = `idle-capacity:${g.cause}`;
    const measured = Math.round(g.slotMinutes * 100) / 100;
    const message = `since=${fixedClock(g.sinceMs).iso()} slot_minutes=${measured} dispatchable=${g.dispatchable} ` +
      `cause=${g.cause} reason=${JSON.stringify(g.reason)} — idle lane slots held by a named hold beyond the cause's own history`;
    const base = { name, subject, measured, bound: undefined, message };
    // The cause's own population always learns; it judges once it has history.
    out.push({ ...base, population: g.cause });
    // No history of its own yet: judged against the all-cause idle population instead of passing free.
    if (!hasOwnHistory(history, g.cause, policy)) out.push({ ...base, population: ALL_CAUSE_IDLE_POPULATION });
  }
  return out;
}

/**
 * The idle-capacity detector. `instance` names the registry instance when the rows themselves do not carry one.
 *
 * The shared evaluator hands `evaluate` the rows of the long window, then of the short one, and a hold that has
 * been steady for an hour wrote no row in the short window. So the long call's rows are kept for the same pass and
 * the short call reads the hold in force at its start from them, clipping the integration to its own window and
 * scaling it to the long window's length (a burn rate), because both windows are judged against the same bound.
 */
export function idleCapacityDetector(instance = "unknown"): FleetFlowDetector {
  const policy = IDLE_CAPACITY_POLICY;
  let lastLong: { nowMs: number; rows: readonly FleetFlowRow[] } | undefined;
  return {
    id: "idle-capacity",
    inputs: ["lane.idle_changed", "lane.idle_summary"],
    policy,
    evaluate(rows, nowMs, history) {
      const isShort = lastLong !== undefined && lastLong.nowMs === nowMs;
      const windowMs = isShort ? policy.longMs / 12 : policy.longMs;
      if (!isShort) lastLong = { nowMs, rows };
      // The short window confirms the RATE: its slot-minutes scaled to the long window, so both compare to one bound.
      const scale = policy.longMs / windowMs;
      const source = isShort ? lastLong!.rows : rows;
      const named = source.find((r) => typeof r.instance === "string")?.instance;
      const where = typeof named === "string" ? named : instance;

      const groups = new Map<string, Group>();
      for (const iv of intervalsOf(source, nowMs, nowMs - windowMs)) {
        const reason = reasonOf(iv.hold, iv.cause);
        const setter = setterOf(iv.hold);
        const key = JSON.stringify([iv.cause, reason, setter]);
        const group = groups.get(key) ?? { cause: iv.cause, reason, setter, slotMinutes: 0, sinceMs: iv.startMs, dispatchable: 0 };
        group.slotMinutes += ((iv.endMs - iv.startMs) / MS_PER_MINUTE) * iv.slots * scale;
        group.sinceMs = Math.min(group.sinceMs, iv.startMs);
        group.dispatchable = iv.dispatchable;
        groups.set(key, group);
      }
      // A window the daemon just closed: its per-cause slot-minutes are the same population, and a hot one names
      // its hold. A hold the live rows already cover is not counted twice.
      for (const row of rows) {
        const endMs = typeof row.window_end_ms === "number" ? row.window_end_ms : rowMs(row);
        if (row.step !== "lane.idle_summary" || !Number.isFinite(endMs) || endMs <= nowMs - policy.longMs / 12 || endMs > nowMs) continue;
        const holds = holdOf(row.holds);
        for (const [cause, minutes] of Object.entries(holdOf(row.slot_minutes_by_cause) ?? {})) {
          if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) continue;
          const hold = holdOf(holds?.[cause]);
          const reason = reasonOf(hold, cause);
          const setter = setterOf(hold);
          const key = JSON.stringify([cause, reason, setter]);
          if (groups.has(key)) continue;
          groups.set(key, {
            cause, reason, setter, slotMinutes: minutes, dispatchable: 0,
            sinceMs: typeof row.window_start_ms === "number" ? row.window_start_ms : endMs,
          });
        }
      }
      return findingsOf(groups.values(), where, history, policy);
    },
  };
}
