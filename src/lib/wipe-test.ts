import { loadLayeredLearningsForTaskFiles, renderMatchedLearnings, selectLearnings } from "./learnings.js";
import { appendLedger } from "./ledger.js";
import type { LayeredLearningsHomes } from "./learnings.js";
import type { RunResult } from "./run-result.js";
import type { ProofExecOutcome } from "./review.js";

/**
 * `rmd wipe-test` — the learning-utility A/B harness (ratifies P12, MASTER-PLAN
 * §Self-improvement, W1-T86).
 *
 * W1-T19 injects task-matched LEARNINGS into every implement prompt (learnings.ts),
 * but nothing measures whether that injection changes an outcome — the claim "memory
 * helps" was unfalsifiable. The WIPE TEST [research: self-evolving-agents-2026] is the
 * falsifier this module implements: run the SAME task twice —
 *   ARM A (unmasked): normal injection, exactly what `runTaskBody` (run-task.ts) does
 *     today — {@link loadLayeredLearningsForTaskFiles} → {@link selectLearnings} →
 *     {@link renderMatchedLearnings}.
 *   ARM B (masked): injection returns "" — the STORE ITSELF IS NEVER TOUCHED (masking,
 *     not deletion). {@link computeMatchedLearningsForArm} enforces this at the type
 *     level: arm "B" returns before any of `deps`' three functions are ever called, so
 *     a test spying on those deps can prove zero reads reached the corpus.
 * — and report the deltas (turns/cost/verdict/strikes/proof_exec) between the two runs.
 *
 * PAIRING DISCIPLINE (the design's own words): a single pair is an anecdote. Only the
 * AGGREGATE over many seeded pairs ({@link aggregateWipeTestPairs}) is treated as
 * signal; each pair is ledgered ({@link ledgerWipeTestPair}, step `"wipetest.pair"`)
 * so the aggregate can be recomputed from the ledger at any time, not just from
 * whatever pairs happen to be in memory in one process.
 *
 * SANDBOX-ONLY BY DEFAULT: {@link resolveWipeTestTarget} refuses to target anything
 * but the sandbox unless the operator explicitly opts out — a wipe-test run burns
 * real budget running a task TWICE, and must never silently land on the primary repo.
 *
 * This module is the HARNESS. Running the experiment (scheduling real pairs against
 * the sandbox, reading the aggregate) is an operator action (Rule 18) — see `rmd
 * wipe-test`'s CLI wiring in run-task.ts.
 *
 * NEVER LEDGER A PAIR NEITHER ARM MEASURED (W1-T1252). Every sandbox subject can end up
 * already-merged, in which case `runTask`'s own W1-T319 guard refuses BOTH arms at zero
 * cost (`task_already_merged`) — a pair of two refusals, not a comparison. Two guards
 * exist because neither alone sees every cause (design note (iii)):
 *   (i) A PRE-FLIGHT, before either arm spawns — {@link resolveWipeTestPreflight}, PURE,
 *       consulted by `wipeTestCommand` once it knows whether the projection already
 *       reports the subject merged. Refuses up front, naming the reason; neither arm is
 *       dispatched and no `wipetest.pair` line is written.
 *   (ii) A LEDGER-TIME BACKSTOP for every OTHER zero-work cause (`blocked_transient`, a
 *        linter refusal, a spawn that never happened) — {@link ledgerWipeTestPair} itself
 *        refuses to write a pair whose two arms both report zero turns AND zero cost.
 * `--rerun` passthrough is deliberately NOT built here (design note (iv)): it would have
 * to reach both arms atomically or it manufactures a result, and this task is scoped to
 * refusing non-measurements, not to un-blocking the harness.
 */

// ── ARM A/B PROMPT ASSEMBLY ─────────────────────────────────────────────────

export type WipeTestArm = "A" | "B";

/** The load → select → render chain runTaskBody's real dispatch calls, as an injectable
 *  seam — so a test can spy on each function and prove arm B never calls any of them
 *  (the store is never touched, only the resulting text is forced empty). */
export interface LearningsInjectionDeps {
  loadLayeredLearningsForTaskFiles: typeof loadLayeredLearningsForTaskFiles;
  selectLearnings: typeof selectLearnings;
  renderMatchedLearnings: typeof renderMatchedLearnings;
}

/** The real chain — what a live (non-test) call gets by default. */
export const REAL_LEARNINGS_INJECTION_DEPS: LearningsInjectionDeps = {
  loadLayeredLearningsForTaskFiles,
  selectLearnings,
  renderMatchedLearnings,
};

export interface MatchedLearningsInput {
  homes: LayeredLearningsHomes;
  taskFiles: string[] | undefined;
  budgetChars?: number;
}

/** What one arm's learnings-injection step produced — everything `run-task.ts`'s
 *  `learnings.injected` ledger line already logs, so the real CLI path can keep
 *  logging identically regardless of which arm ran. */
export interface MatchedLearningsResult {
  matchedLearnings: string;
  selectedIds: string[];
  droppedIds: string[];
  globalRefusedReason?: string;
}

const MASKED_RESULT: MatchedLearningsResult = { matchedLearnings: "", selectedIds: [], droppedIds: [] };

/**
 * Compute the matched-learnings text (and its bookkeeping) for ONE arm of a wipe-test
 * pair. Arm "B" returns {@link MASKED_RESULT} WITHOUT calling any of `deps` — the store
 * (`learnings/*.yaml`, the user-overall home, the global artifact) is never opened, let
 * alone written; only the injected TEXT is forced empty. Arm "A" runs the exact chain
 * `runTaskBody` uses for a normal (non-wipe-test) run.
 */
export function computeMatchedLearningsForArm(
  arm: WipeTestArm,
  input: MatchedLearningsInput,
  deps: LearningsInjectionDeps = REAL_LEARNINGS_INJECTION_DEPS,
): MatchedLearningsResult {
  if (arm === "B") return MASKED_RESULT;
  const { entries, globalRefusedReason } = deps.loadLayeredLearningsForTaskFiles(input.homes, input.taskFiles);
  const { selected, dropped } = deps.selectLearnings(entries, input.taskFiles, input.budgetChars);
  return {
    matchedLearnings: deps.renderMatchedLearnings(selected),
    selectedIds: selected.map((e) => e.id),
    droppedIds: dropped.map((e) => e.id),
    globalRefusedReason,
  };
}

// ── PAIRED RESULTS + DELTAS ─────────────────────────────────────────────────

/** One arm's outcome — the fields the design calls out ("reports deltas: num_turns,
 *  notional cost, verdict, strike count, proof_exec"). {@link RunResult} itself
 *  carries only verdict/costUsd (see run-result.ts's own doc for why the others live
 *  only on the ledger); this is the richer shape a wipe-test pair needs, built either
 *  by hand (fixtures, tests) or derived from a real run via
 *  {@link deriveWipeTestRunResult}. */
export interface WipeTestRunResult {
  taskId: string;
  runId: string;
  verdict: RunResult["verdict"];
  numTurns: number;
  costUsd: number;
  strikes: number;
  proofExec: ProofExecOutcome[];
}

/** One wipe-test pair: the SAME task, arm A (unmasked) vs arm B (masked). */
export interface WipeTestPair {
  taskId: string;
  armA: WipeTestRunResult;
  armB: WipeTestRunResult;
}

/** The deltas one pair yields — always B minus A, so a POSITIVE turns/cost delta means
 *  masking the learnings made the run more expensive (i.e. the learnings were HELPING). */
export interface WipeTestDelta {
  taskId: string;
  turnsDelta: number;
  costDelta: number;
  strikesDelta: number;
  verdictA: RunResult["verdict"];
  verdictB: RunResult["verdict"];
  verdictChanged: boolean;
  proofExecPassA: number;
  proofExecPassB: number;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function countExecutedPass(outcomes: ProofExecOutcome[]): number {
  return outcomes.filter((o) => o === "executed_pass").length;
}

/** Pure delta computation for one pair — no I/O, so it is trivially unit-testable
 *  against a hand-seeded fixture pair. */
export function computeWipeTestDelta(pair: WipeTestPair): WipeTestDelta {
  return {
    taskId: pair.taskId,
    turnsDelta: pair.armB.numTurns - pair.armA.numTurns,
    costDelta: round(pair.armB.costUsd - pair.armA.costUsd),
    strikesDelta: pair.armB.strikes - pair.armA.strikes,
    verdictA: pair.armA.verdict,
    verdictB: pair.armB.verdict,
    verdictChanged: pair.armA.verdict !== pair.armB.verdict,
    proofExecPassA: countExecutedPass(pair.armA.proofExec),
    proofExecPassB: countExecutedPass(pair.armB.proofExec),
  };
}

/** The ledger `step` a pair's deltas are recorded under — accumulated over time so
 *  {@link aggregateWipeTestPairs} can be recomputed from the ledger, not only from
 *  pairs held in one process's memory. */
export const WIPE_TEST_PAIR_STEP = "wipetest.pair";

/** Did this one arm do any measurable work at all? Zero turns AND zero cost means no
 *  worker ever ran — whatever the verdict says caused it (`task_already_merged`,
 *  `blocked_transient`, a linter refusal, a spawn that never happened). */
function armDidNoWork(arm: WipeTestRunResult): boolean {
  return arm.numTurns === 0 && arm.costUsd === 0;
}

/** THE LEDGER-TIME BACKSTOP (design note (ii)): a pair is a non-measurement, whatever
 *  produced it, when NEITHER arm did any work — the pre-flight ({@link
 *  resolveWipeTestPreflight}) catches the one cause it can see (merged-by-id) BEFORE
 *  either arm spawns; this catches every other cause, AFTER both arms have already
 *  returned, so it must run regardless of which guard the pre-flight itself missed. */
export function isWipeTestNullPair(pair: WipeTestPair): boolean {
  return armDidNoWork(pair.armA) && armDidNoWork(pair.armB);
}

/** Compute + LEDGER one pair's deltas (one `wipetest.pair` NDJSON line), returning the
 *  same delta the ledger line carries. Pairing discipline (the design's own words):
 *  this is ONE data point — an anecdote — never itself a verdict on whether learnings
 *  help; only {@link aggregateWipeTestPairs} over many ledgered pairs is signal.
 *
 *  NEVER WRITES A NULL PAIR (W1-T1252 design note (ii)): when {@link isWipeTestNullPair}
 *  holds — both arms report zero turns and zero cost — this returns the (still pure,
 *  still computed) delta for the caller's own reporting, but performs NO ledger I/O at
 *  all: the ledger is left byte-for-byte as it was. An aggregate that averaged in
 *  fabricated zeroes would be worse than an aggregate with fewer points (rationale (5)). */
export function ledgerWipeTestPair(ledgerPath: string, runId: string, pair: WipeTestPair): WipeTestDelta {
  const delta = computeWipeTestDelta(pair);
  if (isWipeTestNullPair(pair)) return delta;
  appendLedger(ledgerPath, {
    run_id: runId,
    task_id: pair.taskId,
    step: WIPE_TEST_PAIR_STEP,
    arm_a_run_id: pair.armA.runId,
    arm_b_run_id: pair.armB.runId,
    verdict_a: delta.verdictA,
    verdict_b: delta.verdictB,
    verdict_changed: delta.verdictChanged,
    turns_delta: delta.turnsDelta,
    cost_delta: delta.costDelta,
    strikes_delta: delta.strikesDelta,
    proof_exec_pass_a: delta.proofExecPassA,
    proof_exec_pass_b: delta.proofExecPassB,
  });
  return delta;
}

// ── AGGREGATION ──────────────────────────────────────────────────────────────

/** The aggregate over N pairs — THE publishable learning-utility number (the design's
 *  own framing: "the WS-12 receipts thesis applied to memory"). A single pair is an
 *  anecdote; this is signal. */
export interface WipeTestAggregate {
  pairs: number;
  avgTurnsDelta: number;
  avgCostDelta: number;
  avgStrikesDelta: number;
  verdictChangedCount: number;
  verdictChangedRate: number;
}

const EMPTY_AGGREGATE: WipeTestAggregate = {
  pairs: 0,
  avgTurnsDelta: 0,
  avgCostDelta: 0,
  avgStrikesDelta: 0,
  verdictChangedCount: 0,
  verdictChangedRate: 0,
};

/** Aggregate many seeded pairs into ONE report — mirrors retro.ts's
 *  `aggregateByType`/`aggregateByClass` shape (map → reduce → round). Zero pairs is a
 *  well-defined, non-throwing empty aggregate, never a NaN. */
export function aggregateWipeTestPairs(pairs: WipeTestPair[]): WipeTestAggregate {
  if (pairs.length === 0) return EMPTY_AGGREGATE;
  const deltas = pairs.map(computeWipeTestDelta);
  const n = deltas.length;
  const sum = (f: (d: WipeTestDelta) => number) => deltas.reduce((s, d) => s + f(d), 0);
  const verdictChangedCount = deltas.filter((d) => d.verdictChanged).length;
  return {
    pairs: n,
    avgTurnsDelta: round(sum((d) => d.turnsDelta) / n),
    avgCostDelta: round(sum((d) => d.costDelta) / n),
    avgStrikesDelta: round(sum((d) => d.strikesDelta) / n),
    verdictChangedCount,
    verdictChangedRate: round(verdictChangedCount / n),
  };
}

// ── NO-MERGE BOUNDARY (design note (iv), (vi), (ix) of W1-T1256) ────────────

/**
 * OPERATOR RULING 2026-08-23 (W1-T1256, design note (iv)): NEITHER WIPE-TEST ARM MAY ARM OR
 * MERGE ITS OWN PR. The chain this closes: arm A succeeds -> arm A's PR merges -> `origin/main`
 * moves -> `projectPlan` reports the subject merged -> arm B's own already-merged read
 * (`runTask`'s W1-T319 guard) refuses arm B at zero cost. A SUCCESSFUL ARM A DESTROYS ITS OWN
 * CONTROL, and no LOCAL reset reaches this: arm A's pushed run branch and open PR are REMOTE
 * objects, `task_already_merged` reads them through `projectPlan`/the ledger, and
 * `worktreeAdd(…, "origin/main")` means a merged arm A moves the very ref arm B's worktree is
 * cut from — a fresh clone or `reset --hard origin/main` both clone/reset TO the contaminated
 * state (design note (iii)). The ruling instead measures the pair AT THE VERDICT: every
 * quantity `wipetest.pair` records — turns, cost, verdict, strikes, proof_exec — is already
 * determined before any merge, so refusing to arm loses no signal.
 *
 * PURE (design note (ix), DECISIONS SPLIT FROM I/O): the ONE bit `run-task.ts`'s deferred
 * arm-at-verdict call site already knows — its own `opts.noMerge` — decides. `run-task.ts`
 * never re-derives this decision or duplicates its wording; it calls this function immediately
 * before it would otherwise call `armAutoMergeAtOpen` and skips that call outright when this
 * refuses. That split is what lets the falsifier (test/wipe-test-arm-isolation.test.ts) drive
 * both directions without a network: boundary present → arm B still dispatches and never
 * observes a merged verdict; boundary REMOVED (the test's own control, `noMerge: false`) →
 * arm B demonstrably refuses, reproducing the exact contamination this task fixes.
 */
export interface WipeTestArmDecision {
  armed: boolean;
  reason?: string;
}

export function resolveWipeTestArmPermission(noMerge: boolean): WipeTestArmDecision {
  if (!noMerge) return { armed: true };
  return {
    armed: false,
    reason:
      "wipe-test no-merge boundary (W1-T1256): neither arm may arm or merge its own PR — the pair " +
      "is measured at the verdict, not at the merge, because a merged arm A moves origin/main and " +
      "flips arm B's own already-merged read, a remote channel no local reset can reach.",
  };
}

// ── ARM ORDER ALTERNATION (design note (vii) of W1-T1256) ───────────────────

/**
 * NOT A FIX (design note (vii) says so explicitly, and it survives the no-merge-boundary
 * ruling) — a GUARD against a residual or unknown leak the boundary above does not name. Arm A
 * (learnings ON) dispatching first on every pair, unconditionally, would make any such leak
 * SYSTEMATIC and one-directional; alternating converts a fixed bias into random error — still
 * not clean, but strictly better than a fixed order, and it makes a leak visible as scatter
 * instead of drift.
 *
 * PURE: `pairIndex` is the caller's own count of pairs already ledgered for this task (parity,
 * not identity, decides which arm dispatches first) — this never reads the ledger itself, so a
 * test drives both orders without I/O. The returned tuple is DISPATCH order only; it never
 * changes which arm is semantically "A" (learnings-on) vs "B" (masked) — `wipeTestCommand`
 * still assembles the pair's `armA`/`armB` fields by arm identity, not by call order.
 */
export function resolveWipeTestArmOrder(pairIndex: number): [WipeTestArm, WipeTestArm] {
  return pairIndex % 2 === 0 ? ["A", "B"] : ["B", "A"];
}

// ── SANDBOX-ONLY GUARD ───────────────────────────────────────────────────────

/** The default (and, without an explicit override, ONLY) repo `rmd wipe-test` targets.
 *  A wipe-test run dispatches a real task TWICE — real budget, real PRs — so it must
 *  never silently land on the primary repo (same fail-loud-control-surface doctrine as
 *  `resolveDaemonTarget`, run-task.ts). */
export const WIPE_TEST_SANDBOX_DEFAULT = "remudero-sandbox";

export interface WipeTestTarget {
  repo: string;
}

/** `--flag value` lookup over a raw argv tail — same tiny helper `run-task.ts` defines
 *  for its own CLI parsing, duplicated here (not imported) because `src/lib` may never
 *  import the CLI entrypoint (`.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule). */
function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

/**
 * Resolve which repo `rmd wipe-test` targets — PURE (no I/O), so the guard is
 * unit-testable. Defaults to {@link WIPE_TEST_SANDBOX_DEFAULT}; any OTHER `--repo`
 * (explicitly including the primary repo) is REFUSED unless `--allow-non-sandbox` is
 * also passed — experiments never burn a non-sandbox repo unflagged.
 */
export function resolveWipeTestTarget(
  rest: string[],
  sandboxDefault: string = WIPE_TEST_SANDBOX_DEFAULT,
): { target: WipeTestTarget } | { error: string } {
  const repoFlag = flagValue(rest, "--repo");
  const allowNonSandbox = rest.includes("--allow-non-sandbox");
  const repo = repoFlag ?? sandboxDefault;
  if (repo !== sandboxDefault && !allowNonSandbox) {
    return {
      error:
        `rmd wipe-test: refusing non-sandbox target '${repo}' — a wipe-test run dispatches a ` +
        `real task TWICE (real budget, real PRs) and must not burn the primary repo unflagged. ` +
        `Default target is the sandbox: \`rmd wipe-test <task-id> --repo ${sandboxDefault}\`. To ` +
        `target a different repo deliberately, pass --allow-non-sandbox.`,
    };
  }
  return { target: { repo } };
}

// ── PRE-FLIGHT REFUSAL (design note (i)) ─────────────────────────────────────

/** What the caller already knows about `taskId` from the SAME projection `runTask`'s own
 *  W1-T319 already-merged guard consults — `wipeTestCommand` derives this via `projectPlan`
 *  over a batched GitHub gateway (mirroring `runTaskBody` exactly) BEFORE dispatching either
 *  arm, so this module never re-derives it (and never imports the CLI-only pieces that
 *  derivation needs — `src/lib` may not import the CLI entrypoint). */
export interface WipeTestMergedState {
  merged: boolean;
  prUrl?: string;
}

/**
 * PRE-FLIGHT for `rmd wipe-test` (design note (i)): when the projection already reports
 * `taskId` merged, refuse BEFORE either arm is dispatched, naming the reason — instead of
 * paying for two arms that `runTask`'s own W1-T319 guard would refuse anyway at zero cost,
 * and instead of ledgering the resulting non-measurement as a `wipetest.pair` line.
 *
 * PURE (no I/O): takes the already-derived {@link WipeTestMergedState} rather than deriving
 * it itself, so this refusal — and its exact wording — is unit-testable without a live
 * GitHub read or a real plan on disk. `--rerun` passthrough is deliberately NOT built here
 * (design note (iv)): there is no override to consult, so a merged subject is refused
 * unconditionally until the CLI wires one (which must reach BOTH arms atomically, or not
 * at all).
 */
export function resolveWipeTestPreflight(taskId: string, state: WipeTestMergedState): { ok: true } | { error: string } {
  if (!state.merged) return { ok: true };
  return {
    error:
      `rmd wipe-test: refusing ${taskId} — it is already merged${state.prUrl ? ` (${state.prUrl})` : ""}, so ` +
      `runTask's own already-merged guard (W1-T319) would refuse BOTH arms at zero cost and the pair ` +
      `would ledger two refusals, not a measurement. Neither arm was dispatched and no wipetest.pair ` +
      `line was written.`,
  };
}

// ── REAL-RUN DERIVATION (CLI glue) ───────────────────────────────────────────

const DONE_STEPS = new Set(["recon.done", "implement.done", "implement.resumed"]);

/**
 * Best-effort derivation of a {@link WipeTestRunResult} from a real {@link RunResult}
 * plus the ledger — turns {@link RunResult}'s verdict/costUsd (all it carries) into the
 * richer shape {@link computeWipeTestDelta} needs. `numTurns` is exact (summed over
 * THIS run's own `run_id`, same `DONE_STEPS` retro.ts's `gatherRuns` sums); `strikes`
 * and `proofExec` are task-scoped best-effort reads (fix/review are separate rungs that
 * ledger under their OWN run ids, not this one) — good enough for the CLI's live report,
 * NOT itself a new decision-relevant ledger reader. Not exercised by this task's
 * REQUIRED unit tests (those work off hand-seeded fixtures, per the design's own
 * acceptance wording) — this is the thin glue "running the experiment is
 * operator-scheduled" (the task's own note) anticipates.
 */
export function deriveWipeTestRunResult(
  result: RunResult,
  ledgerLines: Array<Record<string, unknown>>,
): WipeTestRunResult {
  const numTurns = ledgerLines
    .filter((l) => l.run_id === result.runId && typeof l.step === "string" && DONE_STEPS.has(l.step as string))
    .reduce((s, l) => s + (typeof l.num_turns === "number" ? l.num_turns : 0), 0);
  const strikes = ledgerLines.filter(
    (l) => l.task_id === result.taskId && l.step === "fix.dispatch" && typeof l.strike === "number",
  ).length;
  let proofExec: ProofExecOutcome[] = [];
  for (const l of ledgerLines) {
    if (l.task_id === result.taskId && l.step === "review.posted" && Array.isArray(l.proof_exec)) {
      proofExec = l.proof_exec as ProofExecOutcome[]; // last one wins — the CURRENT posted verdict
    }
  }
  return {
    taskId: result.taskId,
    runId: result.runId,
    verdict: result.verdict,
    numTurns,
    costUsd: result.costUsd,
    strikes,
    proofExec,
  };
}
