import {
  candidateShardFiles,
  loadLayeredLearningsForTaskFiles,
  renderMatchedLearnings,
  selectLearnings,
} from "./learnings.js";
import { appendLedger } from "./ledger.js";
import type { LayeredLearningsHomes, LearningsIndex } from "./learnings.js";
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
 * SUBJECT SUPPLY (W1-T1253): "many seeded pairs" needs SUBJECTS to seed pairs with, and
 * a hand-written list (the sandbox's original three tasks) runs out — worse, once its
 * work has already merged, re-running it is not a subject at all, just a repeat.
 * {@link generateSandboxTask} is that supply: given the shard filenames
 * (`learnings/index.json`'s keys) a subject should select and an ever-incrementing `seq`,
 * it builds a FRESH `files:` list from the real project-layer corpus, never from a fixed
 * roster. A subject is defined by the shards its `files:` select, not by its prose
 * (injection is task-matched — {@link loadLayeredLearningsForTaskFiles} delegates to
 * `learnings.ts`'s `candidateShardFiles`), and that mapping is many-to-many (one path can
 * select two shards at once), so {@link generateSandboxTask} always reports the shards a
 * subject REALLY selects by re-running the same lookup injection itself uses, never by
 * reasoning about which path was picked.
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

/** Compute + LEDGER one pair's deltas (one `wipetest.pair` NDJSON line), returning the
 *  same delta the ledger line carries. Pairing discipline (the design's own words):
 *  this is ONE data point — an anecdote — never itself a verdict on whether learnings
 *  help; only {@link aggregateWipeTestPairs} over many ledgered pairs is signal. */
export function ledgerWipeTestPair(ledgerPath: string, runId: string, pair: WipeTestPair): WipeTestDelta {
  const delta = computeWipeTestDelta(pair);
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

// ── SANDBOX SUBJECT GENERATION (W1-T1253) ────────────────────────────────────

/** One synthetic wipe-test subject for the SANDBOX target: a `files:` list a generated task
 *  record would carry, plus the shard filenames those files ACTUALLY select. */
export interface SandboxSubject {
  /** Ever-distinct id — see {@link generateSandboxTask}'s `seq` param; never drawn from a
   *  fixed roster, so it never runs out the way the sandbox's original three tasks did. */
  id: string;
  /** The `files:` a task record built from this subject would carry. */
  files: string[];
  /** The shard filenames `files` ACTUALLY select, per {@link candidateShardFiles} run
   *  against the real `index` — design (ii): the mapping is many-to-many (one path can
   *  select two shards at once), so this is always the real lookup's output, never a
   *  count of the paths that were picked. */
  selectedShards: string[];
}

/** The literal (glob-free) entries of `index.files[shard].globs` — a glob containing `*` can
 *  match paths this generator never names, so only literal globs are usable AS a path. */
function literalGlobsFor(index: LearningsIndex, shard: string): string[] {
  return (index.files[shard]?.globs ?? []).filter((glob) => !glob.includes("*"));
}

/** One literal path per shard in `index` that selects THAT shard and no other — found by
 *  actually RUNNING {@link candidateShardFiles} over every literal glob the corpus carries
 *  (design ii: never reason about paths, always ask the real lookup), so it stays correct
 *  as the corpus grows or its many-to-many overlaps shift. A shard with no isolating
 *  literal path in the current corpus is simply absent from the returned map. */
function isolatingPathsByShard(index: LearningsIndex): Map<string, string> {
  const out = new Map<string, string>();
  for (const shard of Object.keys(index.files)) {
    for (const path of literalGlobsFor(index, shard)) {
      const selected = candidateShardFiles(index, [path]);
      if (selected.length === 1 && selected[0] === shard) {
        out.set(shard, path);
        break;
      }
    }
  }
  return out;
}

/** A single literal path in `index` whose real selection equals `shards` EXACTLY (sorted) —
 *  e.g. `src/lib/review.ts` alone selects exactly `["ci.yaml","failures.yaml"]`. `undefined`
 *  if no single literal path reaches that exact combination in one hop. */
function exactMultiShardPath(index: LearningsIndex, shards: string[]): string | undefined {
  const want = shards.join(" ");
  for (const shard of shards) {
    for (const path of literalGlobsFor(index, shard)) {
      if (candidateShardFiles(index, [path]).join(" ") === want) return path;
    }
  }
  return undefined;
}

/**
 * Generate ONE fresh sandbox subject that selects EXACTLY `shards` (design i/ii/iii): a new
 * `files:` list synthesized from the real project-layer corpus (`index`, i.e. a loaded
 * `learnings/index.json`), never a hand-written subject list that runs out. PURE — no I/O
 * beyond the already-loaded `index` — so `seq` (an ever-incrementing counter) is the
 * caller's job; nothing here reads a clock or randomness, so it stays unit-testable against
 * hand-seeded fixtures exactly like this module's other pure functions.
 *
 * Prefers a SINGLE literal path that reaches `shards` exactly in one hop (the corpus's
 * many-to-many globs make this possible — e.g. one path for both `ci.yaml` and
 * `failures.yaml`); falls back to the union of one per-shard ISOLATING path (a path
 * selecting that shard and no other), which the real project-layer corpus provides for
 * every shard today (architecture/ci/failures/platform/testing each have at least one).
 *
 * Throws (never silently returns a wrong subject) if `shards` is empty, names a shard
 * `index` does not carry, or some requested shard has neither an exact multi-shard path
 * nor an isolating one in the current corpus.
 */
export function generateSandboxTask(index: LearningsIndex, shards: string[], seq: number): SandboxSubject {
  if (shards.length === 0) {
    throw new Error("generateSandboxTask: 'shards' must name at least one shard.");
  }
  const known = new Set(Object.keys(index.files));
  for (const shard of shards) {
    if (!known.has(shard)) {
      throw new Error(
        `generateSandboxTask: unknown shard '${shard}' (index carries: ${[...known].sort().join(", ")}).`,
      );
    }
  }
  const sortedShards = [...new Set(shards)].sort();
  const exact = exactMultiShardPath(index, sortedShards);
  let files: string[];
  if (exact) {
    files = [exact];
  } else {
    const isolating = isolatingPathsByShard(index);
    files = sortedShards.map((shard) => {
      const path = isolating.get(shard);
      if (!path) {
        throw new Error(`generateSandboxTask: shard '${shard}' has no isolating literal path in this corpus.`);
      }
      return path;
    });
  }
  return {
    id: `wt-sbx-${seq}`,
    files,
    selectedShards: candidateShardFiles(index, files),
  };
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
