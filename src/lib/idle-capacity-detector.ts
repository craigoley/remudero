import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { evaluateFleetFlowDetectors, type FleetFlowInput } from "./fleet-flow-detectors.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized } from "./ledger-union.js";
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
  sinceMs: number;
  endMs: number;
}

function rowMs(row: FleetFlowRow): number {
  if (typeof row.at_ms === "number" && Number.isFinite(row.at_ms)) return row.at_ms;
  return typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
}

function holdOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function changesOf(rows: readonly FleetFlowRow[], nowMs: number): FleetFlowRow[] {
  const changes = rows.filter((r) => r.step === "lane.idle_changed" && Number.isFinite(rowMs(r)) && rowMs(r) <= nowMs)
    .sort((a, b) => rowMs(a) - rowMs(b));
  let previous: string | undefined;
  let sinceMs = 0;
  return changes.map((row) => {
    const hold = holdOf(row.hold);
    const key = JSON.stringify([row.cause, reasonOf(hold, String(row.cause)), setterOf(hold)]);
    if (key !== previous) {
      sinceMs = typeof row.idle_since_ms === "number" && Number.isFinite(row.idle_since_ms)
        ? Math.min(row.idle_since_ms, rowMs(row)) : rowMs(row);
    }
    previous = key;
    return { ...row, idle_since_ms: sinceMs };
  });
}

/** Each `lane.idle_changed` row holds until the next one; the last holds until `nowMs`. A row without a time is skipped. */
function intervalsOf(rows: readonly FleetFlowRow[], nowMs: number, fromMs: number): Interval[] {
  const changes = changesOf(rows, nowMs).map((row) => ({ row, at: rowMs(row) }));
  const out: Interval[] = [];
  changes.forEach(({ row }, i) => {
    const startMs = Math.max(changes[i]!.at, fromMs);
    const endMs = i + 1 < changes.length ? changes[i + 1]!.at : nowMs;
    const slots = typeof row.idle_slots === "number" ? row.idle_slots : 0;
    const dispatchable = typeof row.dispatchable === "number" ? row.dispatchable : 0;
    if (typeof row.cause !== "string" || slots <= 0 || dispatchable <= 0 || endMs <= startMs) return;
    out.push({ cause: row.cause, hold: holdOf(row.hold), slots, dispatchable, startMs, sinceMs: Number(row.idle_since_ms), endMs });
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
    const subject = `instance=${token(instance)} hold=${token(g.reason)} setter=${token(g.setter)} since=${fixedClock(g.sinceMs).iso()}`;
    const name = `idle-capacity:${g.cause}`;
    const measured = Math.round(g.slotMinutes * 100) / 100;
    const message = `since=${fixedClock(g.sinceMs).iso()} slot_minutes=${measured} dispatchable=${g.dispatchable} ` +
      `cause=${g.cause} reason=${JSON.stringify(g.reason)} — idle lane slots held by a named hold beyond the cause's own history`;
    const base = { name, subject, measured, bound: undefined, message };
    // The cause's own population judges once it has history.
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
      if (isShort) lastLong = undefined;
      const named = source.find((r) => typeof r.instance === "string")?.instance;
      const where = typeof named === "string" ? named : instance;

      const groups = new Map<string, Group>();
      for (const iv of intervalsOf(source, nowMs, nowMs - windowMs)) {
        const reason = reasonOf(iv.hold, iv.cause);
        const setter = setterOf(iv.hold);
        const key = JSON.stringify([iv.cause, reason, setter, iv.sinceMs]);
        const group = groups.get(key) ?? { cause: iv.cause, reason, setter, slotMinutes: 0, sinceMs: iv.sinceMs, dispatchable: 0 };
        group.slotMinutes += ((iv.endMs - iv.startMs) / MS_PER_MINUTE) * iv.slots * scale;
        group.sinceMs = Math.min(group.sinceMs, iv.sinceMs);
        group.dispatchable = iv.dispatchable;
        groups.set(key, group);
      }
      return findingsOf(groups.values(), where, history, policy);
    },
  };
}

interface IdleMemory {
  history: FleetFlowHistory;
  emitted: { name: string; subject: string; ts: number }[];
  summaryEndMs?: number;
  lastChange?: FleetFlowRow;
}

const idleReaders = new Map<string, ReturnType<typeof createLedgerRotationMemo>>();

/** W1-T8238: use completed summary windows as history; polling a live hold must never teach its own bound. */
export async function evaluateIdleCapacityDetectors(input: FleetFlowInput) {
  if (!input.detectors.some((d) => d.id === "idle-capacity")) return evaluateFleetFlowDetectors(input);
  const policy = IDLE_CAPACITY_POLICY;
  const since = input.nowMs - policy.longMs;
  let rows: readonly FleetFlowRow[];
  if (input.readRows) rows = await input.readRows(input.nowMs - policy.longMs * policy.maxSamples, input.nowMs);
  else {
    const inputs = [...new Set(input.detectors.flatMap((d) => [...d.inputs]))];
    const key = JSON.stringify([input.stateDir, inputs]);
    let memo = idleReaders.get(key);
    if (!memo) {
      const matches = (step: unknown) => typeof step === "string" && inputs.some((s) =>
        s.endsWith("*") ? step.startsWith(s.slice(0, -1)) :
          s.startsWith("*") ? step.endsWith(s.slice(1)) : step === s);
      const literals = inputs.map((s) => s.replace(/^\*|\*$/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const pattern = new RegExp(`"step"\\s*:\\s*"[^"]*(?:${literals.join("|")})[^"]*"`);
      memo = createLedgerRotationMemo((records) => records.filter((r) => matches(r.step)), { pattern });
      idleReaders.set(key, memo);
    }
    const result = await readLedgerUnionRecordsMemoized(input.stateDir, memo, {
      since: fixedClock(input.nowMs - policy.longMs * policy.maxSamples).iso(),
      rotationWindowMs: policy.longMs * policy.maxSamples,
      step: inputs.every((s) => !s.includes("*")) ? inputs : undefined,
      refuseIncomplete: true,
    });
    if (!result.ok) throw new Error(`Idle-capacity ledger unreadable: ${result.unread.join(", ")}`);
    rows = result.rows;
  }
  const path = join(input.stateDir, "fleet-flow-detectors.json");
  const store = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { detectors: {} };
  if (!store || !store.detectors || typeof store.detectors !== "object" || Array.isArray(store.detectors)) {
    throw new Error(`Invalid fleet-flow history: ${path}`);
  }
  const memory: IdleMemory = store.detectors["idle-capacity"] ?? { history: [], emitted: [] };
  const history = [...memory.history];
  let summaryEndMs = memory.summaryEndMs ?? -Infinity;
  const summaries = rows.filter((r) => r.step === "lane.idle_summary")
    .map((row) => ({ row, end: typeof row.window_end_ms === "number" ? row.window_end_ms : rowMs(row) }))
    .filter((s) => Number.isFinite(s.end) && s.end <= since && s.end > summaryEndMs)
    .sort((a, b) => a.end - b.end);
  for (const { row, end } of summaries) {
    if (end <= summaryEndMs) continue;
    const values = holdOf(row.slot_minutes_by_cause);
    if (!values) continue;
    const entries = Object.entries(values);
    if (entries.length === 0 || entries.some(([, measured]) =>
      typeof measured !== "number" || !Number.isFinite(measured) || measured < 0)) continue;
    let total = 0;
    for (const [population, value] of entries) {
      const measured = value as number;
      total += measured;
      if (measured > 0) history.push({ population, measured, ts: end });
    }
    history.push({ population: ALL_CAUSE_IDLE_POPULATION, measured: total, ts: end });
    summaryEndMs = end;
  }
  const learned = history.slice(-policy.maxSamples);
  const changes = changesOf([...(memory.lastChange ? [memory.lastChange] : []), ...rows], input.nowMs);
  const lastChange = changes.at(-1);
  const carry = changes.filter((r) => rowMs(r) <= since).at(-1);
  const source = [...rows.filter((r) => r.step !== "lane.idle_changed"), ...changes];
  if (carry) source.push({ ...carry, at_ms: rowMs(carry), ts: fixedClock(since + 1).iso() });
  store.detectors["idle-capacity"] = { ...memory, history: learned };
  writeAtomic(path, JSON.stringify(store) + "\n");
  const events = await evaluateFleetFlowDetectors({ ...input, readRows: () => source });
  const next = JSON.parse(readFileSync(path, "utf8"));
  next.detectors["idle-capacity"] = {
    ...next.detectors["idle-capacity"], history: learned,
    summaryEndMs: Number.isFinite(summaryEndMs) ? summaryEndMs : undefined, lastChange,
  };
  writeAtomic(path, JSON.stringify(next) + "\n");
  return events;
}
