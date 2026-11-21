/**
 * THE QUEUE GOVERNOR'S WIP BOUND FOLLOWS FLOW, STUCK WORK AND HOST HEADROOM — operator ruling
 * 2026-10-09 ("I hate hard ceilings"; "never be left with stuck prs"). The fixed `policy.wipLimit`
 * held every new build for 1–3 h at a time that day while the open fleet PRs were mostly stuck red
 * and merges kept landing. W1-T7243 (#10387) owns every other fixed budget; this module owns the
 * WIP bound only.
 *
 * Three measured inputs, each continuous, none a gate on its own:
 *  - STUCK OWNED PRS do not hold the queue: a PR parked on a blocker no fix lane is moving (or one
 *    past its blocker SLO) is subtracted from the owned count before the bound is compared.
 *  - TRAILING THROUGHPUT loosens the bound: every merge in the governor's flow window adds a slot,
 *    so a queue that is draining fast admits more work (Little's law: WIP follows throughput).
 *  - HOST HEADROOM tightens it: below a comfortable available-memory fraction the bound scales down
 *    continuously; an unreadable reading leaves the bound unscaled and is ledgered as unread.
 * The base `policy.wipLimit` stays the starting point; {@link WIP_BOUND_BACKSTOP_MULTIPLE} is a
 * SAFETY BACKSTOP only, never the mechanism.
 */
import { existsSync, readFileSync, statSync } from "node:fs";

import { clockFromMillisFn, type Clock } from "./clock.js";
import { LEDGER_ROTATION_LOCK_SUFFIX } from "./ledger-path.js";
import { ledgerLivePath, readLedgerUnionRecords } from "./ledger-union.js";
import { BLOCKER_SLO_MS, type PrBlocker } from "./pr-blocker.js";

/** BACKSTOP ONLY: the adaptive bound never exceeds this multiple of the base limit. */
export const WIP_BOUND_BACKSTOP_MULTIPLE = 3;
/** The available-memory fraction at and above which headroom does not scale the bound. */
export const WIP_HEADROOM_COMFORT_FRACTION = 0.3;
/** The smallest scale low headroom applies; the dispatch memory guard owns the hard stop. */
const WIP_HEADROOM_MIN_SCALE = 0.25;

/** W1-T9673: every blocker pr-blocker.ts returns, placed on purpose. `parked`: no lane is moving it, stuck at any
 *  age. `ageing`: a lane is working it, stuck past the blocker SLO. `moving`: never stuck. */
export const WIP_BLOCKER_CLASS = {
  "strikes-exhausted": "parked", "escalated": "parked", "operator-hold": "parked",
  "plan-proof-unrunnable": "parked", "held-draft": "parked", "stale-reviewer-withheld": "parked",
  "own-red": "ageing", "review-failed": "ageing", "conflict": "ageing", "base-red": "ageing", "other": "ageing",
  "security-alert-hold": "ageing", "security-unknown-hold": "ageing",
  "awaiting-ci": "moving", "awaiting-review": "moving", "awaiting-arm": "moving", "armed-idle": "moving",
} as const satisfies Record<PrBlocker, "parked" | "ageing" | "moving">;

export interface AdaptiveWipInputs {
  baseLimit: number;
  trailingMergedCount?: number;
  /** MemAvailable / MemTotal, or undefined when it could not be read. */
  headroomFraction?: number;
}

/** The adaptive bound: base plus trailing merges, scaled by headroom, capped by the backstop. */
export function adaptiveWipBound(inputs: AdaptiveWipInputs): number {
  const base = Math.max(1, inputs.baseLimit);
  const flowRoom = base + Math.max(0, inputs.trailingMergedCount ?? 0);
  const h = inputs.headroomFraction;
  const scale = h === undefined || !Number.isFinite(h)
    ? 1
    : Math.min(1, Math.max(WIP_HEADROOM_MIN_SCALE, h / WIP_HEADROOM_COMFORT_FRACTION));
  return Math.min(Math.max(1, Math.floor(flowRoom * scale)), base * WIP_BOUND_BACKSTOP_MULTIPLE);
}

/** Each owned PR's latest `sweep.disposed` row, classed `parked`, or `ageing` once past its SLO; a PR with no row,
 *  one that is moving, and one under its SLO yield nothing. */
function* stuckOwnedClasses(
  lines: ReadonlyArray<Record<string, unknown>>, ownedPrNumbers: readonly number[], nowMs: number,
): Generator<"parked" | "ageing"> {
  const owned = new Set(ownedPrNumbers);
  const latest = new Map<number, Record<string, unknown>>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed" || typeof line.pr_number !== "number" || !owned.has(line.pr_number)) continue;
    latest.set(line.pr_number, line);
  }
  for (const row of latest.values()) {
    const blocker = typeof row.blocker === "string" ? row.blocker : "";
    const cls = Object.hasOwn(WIP_BLOCKER_CLASS, blocker) ? WIP_BLOCKER_CLASS[blocker as PrBlocker] : undefined;
    if (cls === "parked") { yield cls; continue; }
    if (cls !== "ageing") continue;
    const ts = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    const ageAtRow = typeof row.blocker_age_ms === "number" ? row.blocker_age_ms : NaN;
    if (!Number.isFinite(ts) || !Number.isFinite(ageAtRow)) continue;
    if (ageAtRow + Math.max(0, nowMs - ts) >= BLOCKER_SLO_MS) yield cls;
  }
}

/** How many of `ownedPrNumbers` are stuck, from each PR's latest `sweep.disposed` row. A PR with no
 *  disposition row counts as progressing, so an unread signal never frees a slot. */
export function deriveStuckOwnedCount(
  lines: ReadonlyArray<Record<string, unknown>>,
  ownedPrNumbers: readonly number[],
  nowMs: number,
): number {
  return [...stuckOwnedClasses(lines, ownedPrNumbers, nowMs)].length;
}

/** W1-T13990: the stuck owned PRs a fix lane can move, the `ageing` class past its SLO. A `parked` PR waits on a
 *  person (an escalation, an operator hold, exhausted strikes), so the capacity focus frees cannot drain it. */
export function deriveMovableStuckOwnedCount(
  lines: ReadonlyArray<Record<string, unknown>>,
  ownedPrNumbers: readonly number[],
  nowMs: number,
): number {
  return [...stuckOwnedClasses(lines, ownedPrNumbers, nowMs)].filter((cls) => cls === "ageing").length;
}

/** W1-T13990: the fix lane's admissions since a time. */
export interface FixRoundAdmissions {
  /** Rounds whose fix worker was spawned and held a slot (its {@link FIX_WORKER_START_STEP} row), however the round
   *  ended: a round that used its slot in the window. */
  admitted: number;
  /** Claims and rounds no fix worker was spawned for: refused by the capacity controller (each rise of a
   *  `sweep.fix_capacity` row's `fixes_refused`), by review precedence before the controller was consulted, by an abandoned
   *  memory admission; a body-only repair, a merge that did not start, and any other round that ended or was lost before
   *  its worker spawned. */
  refused: number;
  /** W1-T13990: {@link refused} by cause, present when any was refused. */
  refusedCauses?: Partial<Record<FixRoundRefusalCause, number>>;
  /** Rounds the fix lane admitted that are still running now, from this process's fix registry: a round admitted in the
   *  window, or running at its start, has written no `fix.dispatch` yet. Absent when no registry was read. */
  running?: number;
}
/** Undefined when the fix lane's rows have not been read, or a refusal count in the window has no baseline. */
export type FixRoundReader = (sinceMs: number) => FixRoundAdmissions | undefined;

/** W1-T13990: why no fix worker was spawned for a claim or a round. A round's own end names it. */
export type FixRoundRefusalCause = "capacity" | "review_precedence" | "memory_admission_abandoned" | "dispatch_failed" |
  "stood_down" | "superseded" | "spawn_abandoned" | "round_yielded" | "body_repair_only" | "merge_refused" | "no_worker_start";

/** The one fact a round is judged on: was its fix worker spawned. `worker.assignment` with `worker_rung: "fix"` is the one
 *  row a spawn writes, after the worker's admission and before its provider call (worker.ts emitWorkerSelectionAssignment
 *  through run-task.ts fixWorkerReceipt, every fix rung spawn's wrapper), under the fix run's `run_id` with the round as
 *  `repair_round_id`. No other row is a start: `fix.dispatch` and `fix.done` are also written by rounds that spawned no
 *  worker (fix.ts's body-only repair, and its merge that did not start). */
export const FIX_WORKER_START_STEP = "worker.assignment";
/** A round's rows that say nothing about its worker: part of a spawned round's run, else that round's refusal. */
const FIX_ROUND_END_CAUSES: ReadonlyMap<string, FixRoundRefusalCause> = new Map([
  ["fix.dispatch", "no_worker_start"], ["fix.retrigger", "no_worker_start"], ["fix.done", "no_worker_start"],
  ["fix.stood_down", "stood_down"], ["fix.superseded", "superseded"], ["fix.spawn_abandoned", "spawn_abandoned"],
  ["fix.round_yielded", "round_yielded"], ["sweep.fix.dispatch_failed", "dispatch_failed"],
]);
/** The refusal review precedence makes before the capacity controller is consulted (sweep.ts countedYieldingFixClaim). */
export const FIX_CLAIM_YIELDED_STEP = "sweep.fix.claim_yielded";
const FIX_ROUND_STEPS: readonly string[] = [FIX_WORKER_START_STEP, ...FIX_ROUND_END_CAUSES.keys(), "sweep.fix_capacity",
  FIX_CLAIM_YIELDED_STEP];

/** A round end's own cause when no worker was spawned for it: fix.ts names a body-only repair by its `mode` and a merge that
 *  did not start by its round id (`<run>:merge-refused:...`). */
function unstartedCause(line: Record<string, unknown>, cause: FixRoundRefusalCause): FixRoundRefusalCause {
  if (line.mode === "body-repair") return "body_repair_only";
  if (typeof line.round_id === "string" && line.round_id.includes(":merge-refused:")) return "merge_refused";
  return cause;
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const prOfUrl = (value: unknown): number | undefined => {
  const match = typeof value === "string" ? /\/pull\/(\d+)$/.exec(value) : null;
  return match ? Number(match[1]) : undefined;
};

/** W1-T13990: a reader over the fix-round rows in ledger lines already read, keeping only their times. */
export function fixRoundReaderFor(lines: ReadonlyArray<Record<string, unknown>>): FixRoundReader {
  const stamp = (line: Record<string, unknown>): number => typeof line.ts === "string" ? Date.parse(line.ts) : NaN;
  // Each round whose fix worker was spawned, keyed by its round id (else its run), at its latest row: it held its slot
  // until then. Read first, since a spawn and its round's other rows can be read in either order.
  const started = new Map<string, number>();
  const startedRound = new Set<string>();
  const startedRunUnit = new Map<string, string>();
  const startedPr = new Map<number, { unit: string; ts: number }[]>();
  lines.forEach((line, index) => {
    const ts = stamp(line);
    if (line.step !== FIX_WORKER_START_STEP || line.worker_rung !== "fix" || !Number.isFinite(ts)) return;
    const roundId = text(line.repair_round_id);
    const runId = text(line.run_id);
    const unit = roundId !== undefined ? `round\0${roundId}` : runId !== undefined ? `run\0${runId}` : `row\0${index}`;
    started.set(unit, Math.max(started.get(unit) ?? ts, ts));
    if (roundId !== undefined) startedRound.add(roundId);
    if (runId !== undefined) startedRunUnit.set(runId, unit);
    const pr = prOfUrl(line.repair_pr_url);
    if (pr !== undefined) startedPr.set(pr, [...(startedPr.get(pr) ?? []), { unit, ts }]);
  });
  // The spawned round a row belongs to: its round's, its run's, or, for an in-process dispatch's loss that names no run,
  // the latest spawn for its pull request at or before it.
  const startedUnitOf = (line: Record<string, unknown>, ts: number): string | undefined => {
    if (typeof line.round_id === "string") return startedRound.has(line.round_id) ? `round\0${line.round_id}` : undefined;
    const lost = line.step === "sweep.fix.dispatch_failed";
    for (const run of [line.child_run_id, line.admission_run_id, lost ? undefined : line.run_id]) {
      const unit = typeof run === "string" ? startedRunUnit.get(run) : undefined;
      if (unit !== undefined) return unit;
    }
    if (!lost || line.child_run_id !== undefined || line.admission_run_id !== undefined) return undefined;
    const pr = typeof line.pr_number === "number" ? line.pr_number : undefined;
    return pr === undefined ? undefined : startedPr.get(pr)?.filter((s) => s.ts <= ts).at(-1)?.unit;
  };
  const refused: { ts: number; cause: FixRoundRefusalCause }[] = [];
  const abandonedRounds = new Set<unknown>();
  const refusedRounds = new Set<string>();
  const dispatchFailures: { line: Record<string, unknown>; ts: number }[] = [];
  // Each controller (one per pass, keyed by its controller_id, or by run and surface on older rows) writes its running
  // refusal count from 0.
  const controllerRefused = new Map<string, number>();
  // A controller whose first row read already counts refusals opened before these lines: its count has no baseline.
  const unbaselined: number[] = [];
  const refusedRuns = new Set<unknown>();
  for (const line of lines) {
    if (typeof line.step !== "string" || line.step === FIX_WORKER_START_STEP || !FIX_ROUND_STEPS.includes(line.step)) continue;
    const ts = stamp(line);
    if (!Number.isFinite(ts)) continue;
    const runId = typeof line.run_id === "string" ? line.run_id : "";
    if (line.step === FIX_CLAIM_YIELDED_STEP) {
      refused.push({ ts, cause: "review_precedence" });
    } else if (line.step === "sweep.fix_capacity") {
      const count = line.fixes_refused;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) continue;
      // A controller's own id when its row carries one: passes sharing a run and surface are separate counters.
      const key = typeof line.controller_id === "string" ? `id\0${line.controller_id}` : `${runId}\0${String(line.surface)}`;
      if (!controllerRefused.has(key) && count > 0) unbaselined.push(ts);
      const prior = controllerRefused.get(key) ?? 0;
      // A fall means a new controller, whose whole count is new.
      const fresh = count >= prior ? count - prior : count;
      controllerRefused.set(key, count);
      for (let i = 0; i < fresh; i++) refused.push({ ts, cause: "capacity" });
      if (fresh > 0) refusedRuns.add(runId);
    } else {
      const unit = startedUnitOf(line, ts);
      // A round whose worker was spawned held its slot however it ended: it ran, until its last row.
      if (unit !== undefined) {
        started.set(unit, Math.max(started.get(unit) ?? ts, ts));
      } else if (line.step === "sweep.fix.dispatch_failed") {
        dispatchFailures.push({ line, ts });
      } else if (line.step === "fix.done" && line.subtype === "admission_abandoned") {
        if (abandonedRounds.has(line.round_id)) continue;
        if (typeof line.round_id === "string") abandonedRounds.add(line.round_id);
        if (runId !== "") refusedRuns.add(runId);
        refused.push({ ts, cause: "memory_admission_abandoned" });
      } else {
        // One refusal per round, however many of its rows were read.
        if (typeof line.round_id === "string") {
          if (refusedRounds.has(line.round_id)) continue;
          refusedRounds.add(line.round_id);
        }
        refused.push({ ts, cause: unstartedCause(line, FIX_ROUND_END_CAUSES.get(line.step) ?? "no_worker_start") });
      }
    }
  }
  // A dispatch failure can report the same abandoned or refused child, in either ledger order.
  for (const { line, ts } of dispatchFailures) {
    if (abandonedRounds.has(line.round_id) || refusedRuns.has(line.child_run_id) || refusedRuns.has(line.admission_run_id)) continue;
    refused.push({ ts, cause: "dispatch_failed" });
  }
  // A window holding such a first row cannot tell its refusals from the ones before it: unknown, never idle or inflated.
  return (sinceMs) => {
    if (unbaselined.some((t) => t >= sinceMs)) return undefined;
    const inWindow = refused.filter((r) => r.ts >= sinceMs);
    const refusedCauses: Partial<Record<FixRoundRefusalCause, number>> = {};
    for (const { cause } of inWindow) refusedCauses[cause] = (refusedCauses[cause] ?? 0) + 1;
    return { admitted: [...started.values()].filter((t) => t >= sinceMs).length, refused: inWindow.length,
      ...(inWindow.length > 0 ? { refusedCauses } : {}) };
  };
}

/** W1-T13990: the fix-round rows stamped at or after a time in a ledger directory, or undefined when unread. The focus gate
 *  asks from a window before the dwell, so each controller's last row before the dwell is read as its baseline. */
export type FixRoundUnionRead = (stateDir: string, sinceMs: number) => Promise<ReadonlyArray<Record<string, unknown>> | undefined>;

/** W1-T13990: the union's fix-round rows since `sinceMs`, rotations and the live file, read off the loop. Rotation keeps
 *  no `sweep.fix_capacity` row in the live file, so a refusal older than the last rotation is in an archive alone.
 *  Undefined when a rotation, the live file or the directory could not be read: unknown is never idle. */
export async function readFixRoundUnionRows(stateDir: string, sinceMs: number): Promise<ReadonlyArray<Record<string, unknown>> | undefined> {
  let complete = true;
  const unread = (): void => { complete = false; };
  const rows = await readLedgerUnionRecords(stateDir, { since: clockFromMillisFn(() => sinceMs).iso(), step: FIX_ROUND_STEPS,
    onUnreadArchive: unread, onUnreadLive: unread, onUnreadDirectory: unread });
  return complete ? rows : undefined;
}

/** W1-T13990: the focus gate's fix-round reader over the ledger union, for a gate that answers synchronously. */
export interface FixRoundUnionReader {
  /** A reader for one consultation: the newest completed union read, joined once with the live `lines` the gate just
   *  read. Undefined while no usable snapshot covers the window and the current live ledger generation. With
   *  `readRunning`, an answer also carries the rounds running now. */
  readerFor(lines: ReadonlyArray<Record<string, unknown>>): FixRoundReader;
  /** Settles when the read in flight does. */
  settled(): Promise<void>;
}

export function createFixRoundUnionReader(
  stateDir: string, opts: { clock: Clock; read?: FixRoundUnionRead; readRunning?: () => number },
): FixRoundUnionReader {
  const read = opts.read ?? readFixRoundUnionRows;
  const livePath = ledgerLivePath(stateDir);
  const liveGeneration = (): string | undefined => {
    try {
      const stat = statSync(livePath, { bigint: true });
      // Rotation replaces the live inode under this lock, then drains late writes from the old inode.
      if (existsSync(livePath + LEDGER_ROTATION_LOCK_SUFFIX)) return undefined;
      return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    } catch (error) {
      void error; // An unreadable live identity cannot establish continuity.
      return undefined;
    }
  };
  let latest: { generation: string; startedAtMs: number; rows: ReadonlyArray<Record<string, unknown>> } | undefined;
  let inFlight: Promise<void> | undefined;
  // W1-T13990: a window asked for while a read is in flight, newer than that read began. The read is then begun again
  // once it ends, so a read begun before a dwell matured never leaves the matured window with no read begun inside it.
  let followUpSinceMs: number | undefined;
  const start = (sinceMs: number): void => {
    if (inFlight !== undefined) {
      followUpSinceMs = Math.max(followUpSinceMs ?? sinceMs, sinceMs);
      return;
    }
    const startedAtMs = opts.clock.now();
    // One window more before the dwell: a controller's `fixes_refused` is cumulative, so its rise in the dwell is read
    // against its last row before it. A controller with no row in that lookback is unknown (fixRoundReaderFor).
    const baselineSinceMs = sinceMs - Math.max(0, startedAtMs - sinceMs);
    inFlight = Promise.resolve().then(async () => {
      const generation = liveGeneration();
      const rows = generation === undefined ? undefined : await read(stateDir, baselineSinceMs);
      latest = generation === undefined || rows === undefined ? undefined : { generation, startedAtMs, rows };
    }).catch((error: unknown) => {
      void error; // A failed read is no reading, so the dwell is unknown and the hold stands.
      latest = undefined;
    }).finally(() => {
      inFlight = undefined;
      const next = followUpSinceMs;
      followUpSinceMs = undefined;
      if (next !== undefined && (latest === undefined || latest.startedAtMs < opts.clock.now())) start(next);
    });
  };
  return {
    readerFor: (lines) => (sinceMs) => {
      const snapshot = latest;
      start(sinceMs);
      // A rotation since the snapshot started may have archived rows missing from both inputs. Wait for the refresh.
      if (snapshot === undefined || snapshot.startedAtMs < sinceMs || snapshot.generation !== liveGeneration()) return undefined;
      const seen = new Set(snapshot.rows.map((row) => JSON.stringify(row)));
      const live = lines.filter((line) => typeof line.step === "string" && FIX_ROUND_STEPS.includes(line.step) &&
        !seen.has(JSON.stringify(line)));
      // In time order, so a pass's rows the read's window cut are its context, never a new controller.
      const stamp = (row: Record<string, unknown>): number => typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
      const rows = [...snapshot.rows, ...live].sort((a, b) => (stamp(a) || 0) - (stamp(b) || 0));
      const rounds = fixRoundReaderFor(rows)(sinceMs);
      return rounds && opts.readRunning ? { ...rounds, running: opts.readRunning() } : rounds;
    },
    settled: async () => { while (inFlight !== undefined) await inFlight; },
  };
}

/** MemAvailable / MemTotal from a /proc/meminfo-shaped file; throws when either line is absent. */
export function readMemoryHeadroomFraction(path = "/proc/meminfo"): number {
  const text = readFileSync(path, "utf8");
  const total = /^MemTotal:\s*(\d+)\s*kB\s*$/m.exec(text);
  const available = /^MemAvailable:\s*(\d+)\s*kB\s*$/m.exec(text);
  if (!total || !available || Number(total[1]) <= 0) throw new Error(`${path}: no MemTotal/MemAvailable pair`);
  return Number(available[1]) / Number(total[1]);
}

export interface AdaptiveQueueFlowInputs {
  lines: ReadonlyArray<Record<string, unknown>>;
  ownedPrNumbers?: readonly number[];
  nowMs: number;
  baseLimit: number;
  trailingMergedCount: number;
  /** Throws (unreadable) or returns the fraction; the throw is recorded as an unread reading. */
  readHeadroom: () => number;
}

export interface AdaptiveQueueFlow {
  stuckOwnedCount: number;
  /** W1-T13990: the part of {@link stuckOwnedCount} a fix lane can move. Focus reads it; the WIP bound does not. */
  movableStuckOwnedCount: number;
  headroomFraction: number | undefined;
  headroomUnread: boolean;
  /** Why the headroom read failed, when it did — ledgered, so an unscaled bound is never silent. */
  headroomError?: string;
  adaptiveBound: number;
}

/** Everything the production dispatch gate hands {@link checkQueueGovernor} besides the counts. */
export function assembleAdaptiveQueueFlow(inputs: AdaptiveQueueFlowInputs): AdaptiveQueueFlow {
  let headroomFraction: number | undefined;
  let headroomError: string | undefined;
  try {
    headroomFraction = inputs.readHeadroom();
  } catch (error) {
    // Unread, never "plenty": the bound stays unscaled and the reason rides the ledger row.
    headroomError = error instanceof Error ? error.message : String(error);
  }
  const stuckOwnedCount = inputs.ownedPrNumbers === undefined
    ? 0
    : deriveStuckOwnedCount(inputs.lines, inputs.ownedPrNumbers, inputs.nowMs);
  const movableStuckOwnedCount = inputs.ownedPrNumbers === undefined
    ? 0
    : deriveMovableStuckOwnedCount(inputs.lines, inputs.ownedPrNumbers, inputs.nowMs);
  return {
    stuckOwnedCount,
    movableStuckOwnedCount,
    headroomFraction,
    headroomUnread: headroomError !== undefined,
    ...(headroomError !== undefined ? { headroomError } : {}),
    adaptiveBound: adaptiveWipBound({
      baseLimit: inputs.baseLimit, trailingMergedCount: inputs.trailingMergedCount, headroomFraction,
    }),
  };
}
