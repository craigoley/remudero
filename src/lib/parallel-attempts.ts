/**
 * lib/parallel-attempts.ts — W1-T4667: repair rounds are 77% of PR time and run sequentially.
 * This module keeps the design's two phases strictly separate:
 *
 *   (i) OFFLINE MEASUREMENT — {@link measureShapeGains} reduces paired-trial rows (the sealed
 *       side-attempt mechanism W1-T4625/W1-T4638 already built) to, per task "shape", whether
 *       P(any-of-k passes) beats P(single attempt passes) by enough to pay for the extra
 *       reserved window the k side attempts cost. {@link shapeGainPays} is the payoff test — a
 *       RATIO of measured gain to extra window share, never a fixed k (design (ii)).
 *   (ii) PLANNING + SELECTION — {@link planParallelAttempts} decides, for one task about to
 *       enter a repair round after a first failed strike, whether this shape's measured gain
 *       pays for running k sealed attempts in parallel instead of the ordinary single one.
 *       {@link selectPreferredAttempt} then picks, among attempts that already ran, the one
 *       the task's own proofs prefer — falling to the reviewer's score only when the proofs
 *       alone leave more than one candidate standing (design (ii): "select by proofs, then
 *       reviewer").
 *
 * INVARIANT: no spawn seam lives here. This module never calls spawnWorker, never pushes a
 * branch, and never opens a worktree — planning a shape "in" is a decision object, not an
 * effect. A shape with no measured rows (or too few to trust) always plans k=1, the ordinary
 * single attempt — never a guess dressed as a measurement.
 */

import type { CorpusProofOutcome } from "./golden-corpus.js";
import type { Task } from "./plan.js";

/** A task's shape for this measurement: its risk band and a coarse bucket over touched-file
 *  count. Coarse on purpose — a per-exact-file-count shape would starve every bucket of the
 *  rows {@link MIN_ROWS_FOR_SIGNAL} needs to trust it. */
export type TaskShape = string;

export function taskShapeKey(task: Pick<Task, "risk"> & { files?: readonly string[] }): TaskShape {
  const fileCount = task.files?.length ?? 0;
  const bucket = fileCount <= 1 ? "1-file" : fileCount <= 3 ? "2-3-file" : "4-plus-file";
  return `${task.risk}:${bucket}`;
}

/**
 * One historical repair round, paired: whether the ordinary single (first) attempt passed, and
 * whether ANY of the k sealed side attempts run alongside it passed, for a task of this shape.
 * Rows are read from paired-trial evidence, never the ledger directly (design (i)), so the
 * measurement here stays testable without a live trial.
 */
export interface RepairShapeTrialRow {
  shape: TaskShape;
  singlePassed: boolean;
  anyOfKPassed: boolean;
  /** The k side attempts' reserved-window cost, as a multiple of one single attempt's window
   *  (k attempts run IN PARALLEL cost ~1x wall-clock, but reserve k x the scheduling window —
   *  it is that reserved-window share this measures, never elapsed time). 1 == no extra cost. */
  windowShare: number;
}

/** Per-shape measured gain: the paired pass rates behind it, and the reserved-window cost the
 *  gain must clear before parallel attempts are worth spawning for this shape. */
export interface ShapeGain {
  shape: TaskShape;
  rows: number;
  singlePassRate: number;
  anyOfKPassRate: number;
  /** P(any-of-k) - P(single). Never negative-adjusted — a shape where parallel attempts measure
   *  WORSE reports that honestly, so {@link shapeGainPays} refuses it on `gain > 0` alone. */
  gain: number;
  meanWindowShare: number;
  /** gain / (meanWindowShare - 1): the extra pass rate bought per unit of EXTRA reserved window
   *  above the one a single attempt already spends. A shape whose mean window share is exactly
   *  1 (no measured extra cost) reports `Infinity` when `gain > 0`, else `0` — never a divide
   *  that turns "no extra cost" into a spurious refusal. */
  gainPerExtraWindow: number;
}

/** Below this many paired rows, a shape's measured gain is not trusted — {@link shapeGainPays}
 *  refuses it and {@link planParallelAttempts} falls back to the ordinary single attempt. */
export const MIN_ROWS_FOR_SIGNAL = 8;

/** Reduces paired rows to one {@link ShapeGain} per shape seen. Pure: no I/O, no ledger read —
 *  the caller supplies rows already read from paired-trial evidence (design (i)). */
export function measureShapeGains(rows: readonly RepairShapeTrialRow[]): Map<TaskShape, ShapeGain> {
  const byShape = new Map<TaskShape, RepairShapeTrialRow[]>();
  for (const row of rows) {
    const list = byShape.get(row.shape) ?? [];
    list.push(row);
    byShape.set(row.shape, list);
  }
  const out = new Map<TaskShape, ShapeGain>();
  for (const [shape, shapeRows] of byShape) {
    const n = shapeRows.length;
    const singlePassRate = shapeRows.filter((r) => r.singlePassed).length / n;
    const anyOfKPassRate = shapeRows.filter((r) => r.anyOfKPassed).length / n;
    const gain = anyOfKPassRate - singlePassRate;
    const meanWindowShare = shapeRows.reduce((sum, r) => sum + r.windowShare, 0) / n;
    const extraWindow = meanWindowShare - 1;
    const gainPerExtraWindow = extraWindow > 0 ? gain / extraWindow : gain > 0 ? Infinity : 0;
    out.set(shape, { shape, rows: n, singlePassRate, anyOfKPassRate, gain, meanWindowShare, gainPerExtraWindow });
  }
  return out;
}

/** The ratio a shape's measured gain must clear, per unit of extra reserved window, before
 *  parallel attempts are judged worth the window they cost. A THRESHOLD the measured ratio is
 *  compared against — never the fixed k the design explicitly rules out. */
export const MIN_GAIN_PER_EXTRA_WINDOW = 0.15;

/** Whether a shape's measured any-of-k gain pays for the window it costs. `undefined`, or fewer
 *  rows than {@link MIN_ROWS_FOR_SIGNAL}, is an UNMEASURED shape — never a guessed "yes". */
export function shapeGainPays(gain: ShapeGain | undefined): boolean {
  if (gain === undefined || gain.rows < MIN_ROWS_FOR_SIGNAL) return false;
  return gain.gain > 0 && gain.gainPerExtraWindow >= MIN_GAIN_PER_EXTRA_WINDOW;
}

/** PRIMARY CONTROL — how many sealed side attempts to run when a shape's measured gain pays. It
 *  directly bounds `k` in {@link planParallelAttempts} on every call, not only once some other
 *  check has already failed; {@link shapeGainPays} is the SEPARATE decision of whether to run
 *  any attempts at all. */
export const DEFAULT_MAX_PARALLEL_K = 3;

export interface ParallelAttemptsPlanInput {
  task: Pick<Task, "risk"> & { files?: readonly string[] };
  /** Strikes already spent on this PR before this round. Parallel attempts only ever follow a
   *  FIRST FAILED STRIKE (design) — never the cold first attempt, which always runs alone. */
  priorStrikes: number;
  /** The offline measurement (design (i)), keyed by {@link taskShapeKey}. An empty map plans
   *  k=1 for every shape — the same "no evidence yet" posture paired-trial.ts holds inert by
   *  default until a live protocol activates one. */
  gains: ReadonlyMap<TaskShape, ShapeGain>;
  maxK?: number;
}

export interface ParallelAttemptsPlan {
  shape: TaskShape;
  parallel: boolean;
  k: number;
  reason: string;
}

/**
 * Decides whether this task's repair round runs k sealed attempts in parallel or the ordinary
 * single one. Parallel attempts are spawned ONLY for shapes whose measured any-of-k gain pays
 * (design (ii)) — never for a cold first strike, and never for a shape the caller has not yet
 * measured. This function is a pure decision: it spawns nothing itself (see the module doc).
 */
export function planParallelAttempts(input: ParallelAttemptsPlanInput): ParallelAttemptsPlan {
  const shape = taskShapeKey(input.task);
  if (input.priorStrikes < 1) return { shape, parallel: false, k: 1, reason: "no-prior-failed-strike" };
  const gain = input.gains.get(shape);
  if (!shapeGainPays(gain)) {
    return { shape, parallel: false, k: 1, reason: gain === undefined ? "shape-unmeasured" : "gain-does-not-pay-for-window" };
  }
  const k = Math.max(2, Math.min(input.maxK ?? DEFAULT_MAX_PARALLEL_K, DEFAULT_MAX_PARALLEL_K));
  return { shape, parallel: true, k, reason: `measured-gain-${gain!.gain.toFixed(3)}-pays-per-extra-window` };
}

/** One completed sealed attempt awaiting selection: its own proof-only verdict — reduced
 *  exactly as {@link import("./paired-trial.js").gradeHeadWithReviewerExecutor} reduces a
 *  head's criteria (any fail fails, any unmeasurable is unmeasurable, all pass passes) — and,
 *  only when needed, the reviewer's own preference score (higher preferred). */
export interface ParallelAttemptCandidate {
  id: string;
  proofVerdict: CorpusProofOutcome;
  reviewerScore?: number;
}

export interface SelectedAttempt {
  id: string;
  /** `"proofs"`: exactly one candidate's proofs passed, so the reviewer was never consulted.
   *  `"reviewer"`: the proofs left more than one candidate standing (or none), and the
   *  reviewer's score broke the tie — design (ii): "select by proofs, then reviewer". */
  selectedBy: "proofs" | "reviewer";
}

/**
 * Picks the attempt the task's own proofs prefer among completed sealed candidates, falling to
 * the reviewer's score only when the proofs alone do not leave exactly one candidate standing.
 * Returns `null` for an empty candidate list — there is nothing to choose among.
 */
export function selectPreferredAttempt(candidates: readonly ParallelAttemptCandidate[]): SelectedAttempt | null {
  if (candidates.length === 0) return null;
  const passing = candidates.filter((c) => c.proofVerdict === "pass");
  if (passing.length === 1) return { id: passing[0]!.id, selectedBy: "proofs" };
  const pool = passing.length > 0 ? passing : candidates;
  const byScore = [...pool].sort((a, b) => (b.reviewerScore ?? -Infinity) - (a.reviewerScore ?? -Infinity));
  return { id: byScore[0]!.id, selectedBy: "reviewer" };
}
