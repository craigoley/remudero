/**
 * W1-T14490 — a ready task the selector keeps ranking below the lanes it fills is named in a row.
 *
 * INVARIANT a-long-wait-is-named: an eligible task the daemon's pick leaves unpicked past
 * STARVATION_AGE_MS writes one `dispatch.starved` row per UTC day, naming its rank in the selector's
 * own ordered eligible set, the eligible count, when it became ready, the days it has waited and the
 * ids ranked above it. The selector already names a task it filters (onFiltered) and one a disjoint
 * pack passes over (onPassedOver, W1-T8771); `dispatch.pick_scored` (W1-T10028) describes only a
 * picked task. A task simply ranked too low, for weeks, wrote nothing.
 *
 * OBSERVATION ONLY: everything here reads the pick after it is final and returns rows. It never
 * reorders, filters or adds to what the pick starts.
 */
import { fixedClock } from "./clock.js";
import type { DispatchValueContext } from "./dispatch-value.js";
import type { Task } from "./plan.js";

export const DISPATCH_STARVED_STEP = "dispatch.starved";
/** A week ready and unpicked: past every tier's ordinary wait, short of a month of silence. */
export const STARVATION_AGE_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const OUTRANKED_LIMIT = 5;

export interface DispatchStarvedRow {
  readonly task: string;
  /** 1-based, in the selector's own ordered eligible set. */
  readonly rank: number;
  readonly eligible_count: number;
  readonly ready_since: string;
  readonly waited_days: number;
  readonly priority: number | null;
  /** The head of the order: up to five ids ranked above this task. */
  readonly outranked_by: readonly string[];
}

export interface DispatchStarvationInput {
  readonly eligible: readonly Task[];
  readonly picked: readonly Pick<Task, "id">[];
  readonly readySinceById: ReadonlyMap<string, number>;
  readonly nowMs: number;
  /** The UTC day (YYYY-MM-DD) of each task's newest prior `dispatch.starved` row. */
  readonly lastRowDayById: ReadonlyMap<string, string>;
}

export const utcDayOf = (ms: number): string => fixedClock(ms).iso().slice(0, 10);

/** The rows this pick owes: one per starved task not already named today. Pure; never changes the pick. */
export function observeDispatchStarvation(input: DispatchStarvationInput): DispatchStarvedRow[] {
  const picked = new Set(input.picked.map(task => task.id));
  const today = utcDayOf(input.nowMs);
  const rows: DispatchStarvedRow[] = [];
  const named = new Set<string>();
  input.eligible.forEach((task, index) => {
    if (picked.has(task.id) || named.has(task.id) || input.lastRowDayById.get(task.id) === today) return;
    const readySince = input.readySinceById.get(task.id);
    // An undatable task is not named: a wait nobody can measure is not evidence of one.
    if (readySince === undefined || !Number.isFinite(readySince)) return;
    const waited = input.nowMs - readySince;
    if (waited <= STARVATION_AGE_MS) return;
    named.add(task.id);
    rows.push({
      task: task.id, rank: index + 1, eligible_count: input.eligible.length,
      ready_since: fixedClock(readySince).iso(), waited_days: Math.round((waited / DAY_MS) * 10) / 10,
      priority: task.priority ?? null,
      outranked_by: input.eligible.slice(0, Math.min(index, OUTRANKED_LIMIT)).map(above => above.id),
    });
  });
  return rows;
}

/**
 * Ready-since: the later of a task's filing time and its last dependency's merge. Filing comes from the
 * dispatch value context's own filing age (W1-T4064), measured at the context's newest evidence, which is
 * never after `nowMs` — so the wait it yields can only be understated. A task the context imputes or
 * cannot score has no ready-since; a dependency with no merge row in the ledger read adds nothing.
 */
export function dispatchReadySince(
  eligible: readonly Task[], context: DispatchValueContext | undefined, nowMs: number,
  mergedAtById: ReadonlyMap<string, number>,
): Map<string, number> {
  const imputed = new Set(context?.costOfDelayImputed ?? []);
  const readySince = new Map<string, number>();
  for (const task of eligible) {
    const inputs = context?.costOfDelayInputsByTaskId?.get(task.id);
    if (inputs === undefined || imputed.has(task.id)) continue;
    const merges = task.depends_on.map(dep => mergedAtById.get(dep) ?? -Infinity);
    readySince.set(task.id, Math.max(nowMs - inputs.filing_age_ms, ...merges));
  }
  return readySince;
}

/** What the observer reads from ledger lines: each task's newest merge and newest starvation-row day. */
export interface StarvationLedgerIndex {
  readonly mergedAtById: Map<string, number>;
  readonly lastRowDayById: Map<string, string>;
}

/** Fold raw ledger lines into `index` (a torn or foreign line is skipped); later rows only move forward. */
export function indexStarvationLedger(
  lines: readonly string[],
  index: StarvationLedgerIndex = { mergedAtById: new Map(), lastRowDayById: new Map() },
): StarvationLedgerIndex {
  for (const raw of lines) {
    if (!raw.includes("merged") && !raw.includes(DISPATCH_STARVED_STEP)) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(raw) as Record<string, unknown>; } catch { continue; /* a torn line names no task */ }
    const at = typeof row?.ts === "string" ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at)) continue;
    const merged = row.step === "verdict.merged" || (row.step === "verdict" && row.verdict === "merged");
    if (merged && typeof row.task_id === "string") {
      index.mergedAtById.set(row.task_id, Math.max(at, index.mergedAtById.get(row.task_id) ?? -Infinity));
    } else if (row.step === DISPATCH_STARVED_STEP && typeof row.task === "string") {
      const day = utcDayOf(at);
      const prior = index.lastRowDayById.get(row.task);
      if (prior === undefined || day > prior) index.lastRowDayById.set(row.task, day);
    }
  }
  return index;
}
