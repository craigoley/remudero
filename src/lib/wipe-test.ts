import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  candidateShardFiles,
  loadLayeredLearningsForTaskFiles,
  renderMatchedLearnings,
  selectLearnings,
} from "./learnings.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { readLedgerLines } from "./status.js";
import type { Config } from "./config.js";
import type { LayeredLearningsHomes, LearningsIndex, LearningsSelectionContext, LearningMatchCounts } from "./learnings.js";
import type { RunResult } from "./run-result.js";
import type { ProofExecOutcome } from "./review.js";

/** `rmd wipe-test` — paired A/B harness measuring whether learnings injection
 *  (learnings.ts, W1-T19) changes a task's outcome (ratifies P12, MASTER-PLAN
 *  §Self-improvement, W1-T86).
 *
 *  Runs the same task twice: arm A unmasked (the real chain `runTaskBody` uses), arm B
 *  masked ({@link computeMatchedLearningsForArm} returns empty text without touching the
 *  learnings store). {@link WipeTestFactor} names which thing arm B masks; {@link
 *  wipeTestFactorMasksLearnings} / {@link wipeTestFactorMasksRecon} are the pure decisions
 *  `run-task.ts`'s dispatch reads.
 *
 *  Invariants: one pair is an anecdote, only {@link aggregateWipeTestPairs} is signal;
 *  `--repo` defaults to the sandbox ({@link resolveWipeTestTarget}); neither arm may arm
 *  or merge its own PR ({@link resolveWipeTestArmPermission}); a pair where neither arm
 *  did work is never ledgered ({@link isWipeTestNullPair}). Running the experiment is an
 *  operator action (Rule 18); this module is the harness. Why:
 *  docs/forensics/wipe-test.md#module-header (P12, W1-T86, W1-T1252, W1-T1253, W1-T1256, W1-T2512). */

// ── ARM A/B PROMPT ASSEMBLY ─────────────────────────────────────────────────

export type WipeTestArm = "A" | "B";

/** Which thing arm B masks (W1-T2512): `"learnings"` masks {@link
 *  computeMatchedLearningsForArm}'s injection; `"recon"` masks the recon worker spawn
 *  (`run-task.ts`'s `opts.maskRecon`); `"rules"` (W1-T2761) masks the policy-gated
 *  `rule_headlines` prompt part (`run-task.ts`'s `opts.maskRules`) — the first worker to ever
 *  see CLAUDE.md's headline index is measured through this factor, never assumed helpful.
 *  Why: docs/forensics/wipe-test.md#wipetestfactor. */
export type WipeTestFactor = "learnings" | "recon" | "rules";

/** Every factor `rmd wipe-test --factor <name>` accepts — the one source {@link
 *  resolveWipeTestFactor} validates against. Why: docs/forensics/wipe-test.md#wipe_test_factors. */
export const WIPE_TEST_FACTORS: readonly WipeTestFactor[] = ["learnings", "recon", "rules"];

/** True only for `factor: "learnings"`, arm `"B"` — the pure decision `run-task.ts`'s
 *  dispatch consults instead of hard-coding it. Why: docs/forensics/wipe-test.md#wipetestfactormaskslearnings. */
export function wipeTestFactorMasksLearnings(factor: WipeTestFactor, arm: WipeTestArm): boolean {
  return factor === "learnings" && arm === "B";
}

/** Sibling of {@link wipeTestFactorMasksLearnings} for the `"recon"` factor — same shape,
 *  opposite masked thing. Why: docs/forensics/wipe-test.md#wipetestfactormasksrecon. */
export function wipeTestFactorMasksRecon(factor: WipeTestFactor, arm: WipeTestArm): boolean {
  return factor === "recon" && arm === "B";
}

/** Sibling of {@link wipeTestFactorMasksLearnings}/{@link wipeTestFactorMasksRecon} for the
 *  `"rules"` factor (W1-T2761) — same shape, masks ONLY the `rule_headlines` prompt part and
 *  nothing else (`run-task.ts`'s `opts.maskRules`). Why: docs/forensics/wipe-test.md#wipetestfactormasksrules. */
export function wipeTestFactorMasksRules(factor: WipeTestFactor, arm: WipeTestArm): boolean {
  return factor === "rules" && arm === "B";
}

/** The load → select → render chain `runTaskBody` calls, as an injectable seam so a test
 *  can spy on each step and prove arm B calls none of them. */
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
  selectionContext?: LearningsSelectionContext;
  budgetChars?: number;
}

/** What one arm's learnings-injection step produced — the fields `run-task.ts`'s
 *  `learnings.injected` ledger line logs, so either arm logs identically. */
export interface MatchedLearningsResult {
  matchedLearnings: string;
  selectedIds: string[];
  droppedIds: string[];
  matchedBy: LearningMatchCounts;
  globalRefusedReason?: string;
}

const MASKED_RESULT: MatchedLearningsResult = {
  matchedLearnings: "",
  selectedIds: [],
  droppedIds: [],
  matchedBy: { file: 0, symbol: 0, error: 0 },
};

/** Compute the matched-learnings text for one arm. Arm "B" returns {@link MASKED_RESULT}
 *  without calling `deps` — masking the text, never touching the store. Arm "A" runs the
 *  real chain `runTaskBody` uses for a normal run. Why:
 *  docs/forensics/wipe-test.md#computematchedlearningsforarm. */
export function computeMatchedLearningsForArm(
  arm: WipeTestArm,
  input: MatchedLearningsInput,
  deps: LearningsInjectionDeps = REAL_LEARNINGS_INJECTION_DEPS,
): MatchedLearningsResult {
  if (arm === "B") return MASKED_RESULT;
  const { entries, globalRefusedReason } = deps.loadLayeredLearningsForTaskFiles(
    input.homes,
    input.taskFiles,
    input.selectionContext,
  );
  const { selected, dropped, matchedBy } = deps.selectLearnings(entries, input.taskFiles, input.budgetChars, input.selectionContext);
  return {
    matchedLearnings: deps.renderMatchedLearnings(selected),
    selectedIds: selected.map((e) => e.id),
    droppedIds: dropped.map((e) => e.id),
    matchedBy,
    globalRefusedReason,
  };
}

// ── PAIRED RESULTS + DELTAS ─────────────────────────────────────────────────

/** One arm's outcome: turns, cost, verdict, strikes, proof_exec — richer than {@link
 *  RunResult}. Why: docs/forensics/wipe-test.md#wipetestrunresult. */
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
  /** Which factor this pair varied. Optional — absent means "learnings" (see {@link
   *  wipeTestPairFactor}), the only factor that existed before W1-T2512. Why:
   *  docs/forensics/wipe-test.md#wipetestpair-factor-field. */
  factor?: WipeTestFactor;
  armA: WipeTestRunResult;
  armB: WipeTestRunResult;
}

/** {@link WipeTestPair.factor}, defaulted — the one place every reader (delta, ledger,
 *  aggregate) resolves "absent means learnings" identically. */
export function wipeTestPairFactor(pair: WipeTestPair): WipeTestFactor {
  return pair.factor ?? "learnings";
}

/** The deltas one pair yields — always B minus A, so a positive turns/cost delta means
 *  masking the factor made the run more expensive (i.e. that factor was helping). */
export interface WipeTestDelta {
  taskId: string;
  /** Carried from the pair via {@link wipeTestPairFactor}, so a delta read in isolation
   *  still says what it measured. */
  factor: WipeTestFactor;
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
    factor: wipeTestPairFactor(pair),
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

/** The ledger `step` a pair's deltas are recorded under, so {@link aggregateWipeTestPairs}
 *  can be recomputed from the ledger, not only from pairs held in memory. */
export const WIPE_TEST_PAIR_STEP = "wipetest.pair";

/** Minimum same-factor pair count before a production report may call the aggregate signal.
 *  Below this floor, the report refuses and names the pair count instead of printing an
 *  anecdotal rate. */
export const WIPE_TEST_PAIRING_FLOOR = 2;

/** Did this arm do any measurable work? Zero turns and zero cost means no worker ran,
 *  whatever the verdict names as the cause. Why: docs/forensics/wipe-test.md#armdidnowork. */
function armDidNoWork(arm: WipeTestRunResult): boolean {
  return arm.numTurns === 0 && arm.costUsd === 0;
}

/** True iff neither arm did any work — a non-measurement whatever caused it; the
 *  ledger-time backstop behind {@link resolveWipeTestPreflight}. Why: docs/forensics/wipe-test.md#iswipetestnullpair. */
export function isWipeTestNullPair(pair: WipeTestPair): boolean {
  return armDidNoWork(pair.armA) && armDidNoWork(pair.armB);
}

/** Compute and ledger one pair's deltas (one `wipetest.pair` line). Writes nothing when
 *  {@link isWipeTestNullPair} holds — the ledger stays byte-for-byte unchanged, since
 *  averaging in a fabricated zero would be worse than fewer points. Why:
 *  docs/forensics/wipe-test.md#ledgerwipetestpair. */
export function ledgerWipeTestPair(ledgerPath: string, runId: string, pair: WipeTestPair): WipeTestDelta {
  const delta = computeWipeTestDelta(pair);
  if (isWipeTestNullPair(pair)) return delta;
  // Why: docs/forensics/wipe-test.md#ledgerwipetestpair (W1-T2512 — a pre-existing row
  // carries no `factor` key; wipeTestPairFactor's default still aggregates it correctly).
  appendLedger(ledgerPath, {
    run_id: runId,
    task_id: pair.taskId,
    step: WIPE_TEST_PAIR_STEP,
    // W1-T2512: named explicitly so a reader of the ledger — not just of the in-memory pair —
    // knows WHICH factor this row varied. A row written before this task carries no `factor`
    // key at all; `wipeTestPairFactor`'s "absent means learnings" default is what makes such a
    // row still aggregate correctly (see `aggregateWipeTestPairs`'s own doc).
    factor: delta.factor,
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

/** The aggregate over N pairs — the publishable learning-utility number. A single pair
 *  is an anecdote; this is signal. Why: docs/forensics/wipe-test.md#wipetestaggregate. */
export interface WipeTestAggregate {
  /** Which factor every pair in this aggregate varied — `null` only for the empty
   *  aggregate. Never a mix: {@link aggregateWipeTestPairs} refuses to average two. */
  factor: WipeTestFactor | null;
  pairs: number;
  avgTurnsDelta: number;
  avgCostDelta: number;
  avgStrikesDelta: number;
  verdictChangedCount: number;
  verdictChangedRate: number;
}

const EMPTY_AGGREGATE: WipeTestAggregate = {
  factor: null,
  pairs: 0,
  avgTurnsDelta: 0,
  avgCostDelta: 0,
  avgStrikesDelta: 0,
  verdictChangedCount: 0,
  verdictChangedRate: 0,
};

/** Aggregate many seeded pairs into one report (map → reduce → round). Zero pairs is a
 *  well-defined empty aggregate, never NaN. Refuses to average pairs across factors —
 *  throws if they name more than one {@link wipeTestPairFactor}, since a learnings delta
 *  and a recon delta share no unit; filter `pairs` to one factor first. Why:
 *  docs/forensics/wipe-test.md#aggregatewipetestpairs. */
export function aggregateWipeTestPairs(pairs: WipeTestPair[]): WipeTestAggregate {
  if (pairs.length === 0) return EMPTY_AGGREGATE;
  const deltas = pairs.map(computeWipeTestDelta);
  const factors = new Set(deltas.map((d) => d.factor));
  if (factors.size > 1) {
    throw new Error(
      `aggregateWipeTestPairs: pairs vary more than one factor (${[...factors].sort().join(", ")}) — ` +
        "an aggregate is only ever signal for ONE factor at a time; filter to a single factor " +
        "(e.g. pairs.filter((p) => wipeTestPairFactor(p) === \"recon\")) before aggregating.",
    );
  }
  const n = deltas.length;
  const sum = (f: (d: WipeTestDelta) => number) => deltas.reduce((s, d) => s + f(d), 0);
  const verdictChangedCount = deltas.filter((d) => d.verdictChanged).length;
  return {
    factor: deltas[0].factor,
    pairs: n,
    avgTurnsDelta: round(sum((d) => d.turnsDelta) / n),
    avgCostDelta: round(sum((d) => d.costDelta) / n),
    avgStrikesDelta: round(sum((d) => d.strikesDelta) / n),
    verdictChangedCount,
    verdictChangedRate: round(verdictChangedCount / n),
  };
}

// ── SANDBOX SUBJECT GENERATION (W1-T1253) ────────────────────────────────────

/** One synthetic wipe-test subject for the sandbox target: a `files:` list a generated task
 *  record would carry, plus the shard filenames those files actually select. Why:
 *  docs/forensics/wipe-test.md#sandboxsubject. */
export interface SandboxSubject {
  /** Ever-distinct id (see {@link generateSandboxTask}'s `seq`) — never drawn from a
   *  fixed roster, so it never runs out. */
  id: string;
  /** The `files:` a task record built from this subject would carry. */
  files: string[];
  /** The shard filenames `files` actually select, per {@link candidateShardFiles} — the
   *  real lookup's output, since one path can select more than one shard. */
  selectedShards: string[];
}

/** The literal (glob-free) entries of `index.files[shard].globs` — a glob containing `*` can
 *  match paths this generator never names, so only literal globs are usable as a path. */
function literalGlobsFor(index: LearningsIndex, shard: string): string[] {
  return (index.files[shard]?.globs ?? []).filter((glob) => !glob.includes("*"));
}

/** One literal path per shard in `index` that selects that shard and no other, found by
 *  running {@link candidateShardFiles} rather than reasoning about paths. A shard with no
 *  isolating path in the current corpus is absent from the returned map. Why:
 *  docs/forensics/wipe-test.md#isolatingpathsbyshard. */
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
  const want = shards.join(" ");
  for (const shard of shards) {
    for (const path of literalGlobsFor(index, shard)) {
      if (candidateShardFiles(index, [path]).join(" ") === want) return path;
    }
  }
  return undefined;
}

/** Generate one fresh sandbox subject selecting exactly `shards`, synthesized from the
 *  real project-layer corpus rather than a fixed roster that runs out (W1-T1253). Pure —
 *  `seq` is the caller's job. Prefers a single literal path reaching `shards` in one hop,
 *  falling back to one isolating path per shard; throws rather than returning a wrong
 *  subject. Why: docs/forensics/wipe-test.md#generatesandboxtask. */
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

// ── NO-MERGE BOUNDARY (design note (iv), (vi), (ix) of W1-T1256) ────────────

/** Operator ruling (W1-T1256): neither wipe-test arm may arm or merge its own PR — a
 *  merged arm A moves `origin/main`, flipping arm B's own already-merged read (`runTask`'s
 *  W1-T319 guard) and refusing arm B at zero cost. The ruling instead measures a pair at
 *  the verdict (turns, cost, verdict, strikes, proof_exec are all determined before any
 *  merge), so refusing to arm loses no signal. `run-task.ts` consults this immediately
 *  before it would otherwise arm auto-merge. Falsifier: test/wipe-test-arm-isolation.test.ts.
 *  Why: docs/forensics/wipe-test.md#resolvewipetestarmpermission. */
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

/** A guard against a residual leak the no-merge boundary above does not name — arm A
 *  dispatching first on every pair would make such a leak systematic; alternating turns
 *  a fixed bias into scatter. Pure: `pairIndex` is the caller's own ledgered-pair count
 *  (parity decides order; it never changes which arm is "A" vs "B"). Why:
 *  docs/forensics/wipe-test.md#resolvewipetestarmorder. */
export function resolveWipeTestArmOrder(pairIndex: number): [WipeTestArm, WipeTestArm] {
  return pairIndex % 2 === 0 ? ["A", "B"] : ["B", "A"];
}

// ── SANDBOX-ONLY GUARD ───────────────────────────────────────────────────────

/** The default (and, without an override, only) repo `rmd wipe-test` targets — a run
 *  dispatches a real task twice, so it must never silently land on the primary repo. Why:
 *  docs/forensics/wipe-test.md#wipe_test_sandbox_default. */
export const WIPE_TEST_SANDBOX_DEFAULT = "remudero-sandbox";

export interface WipeTestTarget {
  repo: string;
}

/** `--flag value` lookup over a raw argv tail, duplicated from `run-task.ts` (not
 *  imported — `src/lib` may not import the CLI entrypoint). */
function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

/** Resolve which repo `rmd wipe-test` targets. Pure. Defaults to {@link
 *  WIPE_TEST_SANDBOX_DEFAULT}; any other `--repo` is refused unless `--allow-non-sandbox`
 *  is also passed — experiments never burn a non-sandbox repo unflagged. */
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

/** Resolve which factor `rmd wipe-test --factor <name>` varies (W1-T2512); pure, same
 *  shape as {@link resolveWipeTestTarget}. Omitted defaults to `"learnings"`; unrecognized
 *  is refused, never silently coerced. Why: docs/forensics/wipe-test.md#resolvewipetestfactor. */
export function resolveWipeTestFactor(rest: string[]): { factor: WipeTestFactor } | { error: string } {
  const raw = flagValue(rest, "--factor");
  if (raw === undefined) return { factor: "learnings" };
  if ((WIPE_TEST_FACTORS as readonly string[]).includes(raw)) return { factor: raw as WipeTestFactor };
  return {
    error:
      `rmd wipe-test: unknown --factor '${raw}' — must be one of: ${WIPE_TEST_FACTORS.join(", ")}. ` +
      `Omitting --factor defaults to "learnings".`,
  };
}

// ── PRE-FLIGHT REFUSAL (design note (i)) ─────────────────────────────────────

/** What the caller already knows about `taskId` from the same projection `runTask`'s own
 *  W1-T319 already-merged guard consults, derived before either arm dispatches — this
 *  module never re-derives it, nor imports the CLI-only pieces that would take
 *  (`src/lib` may not import the CLI entrypoint). */
export interface WipeTestMergedState {
  merged: boolean;
  prUrl?: string;
}

/** Pre-flight for `rmd wipe-test`: refuse before either arm dispatches when the
 *  projection already reports `taskId` merged, naming the reason — instead of paying
 *  for two arms `runTask`'s own W1-T319 guard would refuse anyway. Pure: takes the
 *  already-derived {@link WipeTestMergedState}. Why:
 *  docs/forensics/wipe-test.md#resolvewipetestpreflight. */
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

/** Best-effort derivation of a {@link WipeTestRunResult} from a real {@link RunResult} plus
 *  the ledger. `numTurns` sums this run's own `DONE_STEPS`; `strikes`/`proofExec` are
 *  task-scoped best-effort reads. CLI glue only. Why:
 *  docs/forensics/wipe-test.md#derivewipetestrunresult. */
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

export interface WipeTestPairSubject {
  id: string;
  files?: readonly string[];
  selectedShards?: readonly string[];
}

export interface WipeTestRunTaskOptions {
  planPath?: string;
  config?: Config;
  skipGitSync?: boolean;
  maskLearnings?: boolean;
  maskRecon?: boolean;
  maskRules?: boolean;
  noMerge?: boolean;
}

export type WipeTestRunTask = (taskId: string, opts: WipeTestRunTaskOptions) => Promise<RunResult>;

export interface WipeTestPairRunDeps {
  config: Config;
  repoRoot: string;
  owner: string;
  selfRepo: string;
  targetArgs?: string[];
  runTaskFn: WipeTestRunTask;
  execFileSyncFn?: typeof execFileSync;
  ledgerPath?: string;
  runId?: string;
  pairIndex?: number;
  resolveMergedState: (taskId: string, planPath: string, config: Config) => WipeTestMergedState;
  now?: () => Date;
}

export type WipeTestPairRunResult =
  | {
      status: "measured";
      target: WipeTestTarget;
      planPath: string;
      runId: string;
      pair: WipeTestPair;
      delta: WipeTestDelta;
    }
  | {
      status: "refused";
      reason: string;
      target?: WipeTestTarget;
      planPath?: string;
      runId?: string;
    };

function ledgerPathForRoot(root: string): string {
  return join(root, "state", LEDGER_FILENAME);
}

function renderGeneratedSubjectTask(subject: WipeTestPairSubject, repo: string): string {
  const files = JSON.stringify([...(subject.files ?? [])]);
  return [
    `- id: ${JSON.stringify(subject.id)}`,
    `  title: ${JSON.stringify(`wipe-test sandbox subject ${subject.id}`)}`,
    `  repo: ${JSON.stringify(repo)}`,
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: low",
    "  files: " + files,
    "  note: |",
    "    Synthetic wipe-test cadence subject, generated from the learnings index.",
  ].join("\n") + "\n";
}

function materializeGeneratedSubject(planPath: string, subject: WipeTestPairSubject, repo: string): void {
  if (!subject.files) return;
  const shardDir = join(dirname(planPath), "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(join(shardDir, `${subject.id}.yaml`), renderGeneratedSubjectTask(subject, repo), "utf8");
}

/** Run one wipe-test pair. This is the shared core behind the operator CLI verb and the cadence
 *  rung: both paths resolve the target, prepare the sandbox checkout, preflight the subject, run
 *  the two isolated arms, and ledger through {@link ledgerWipeTestPair}. */
export async function runWipeTestPair(
  subject: WipeTestPairSubject,
  factor: WipeTestFactor,
  deps: WipeTestPairRunDeps,
): Promise<WipeTestPairRunResult> {
  const targetArgs = deps.targetArgs ?? [];
  const resolved = resolveWipeTestTarget(targetArgs);
  if ("error" in resolved) return { status: "refused", reason: resolved.error };
  const { repo } = resolved.target;

  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const ledgerPath = deps.ledgerPath ?? ledgerPathForRoot(deps.config.root);
  const isSelf = repo === deps.selfRepo;
  const reposDir = join(deps.config.root, "repos");
  const planPath = isSelf ? join(deps.repoRoot, "plan", "tasks.yaml") : join(reposDir, repo, "plan", "tasks.yaml");

  if (!isSelf) {
    const repoDir = join(reposDir, repo);
    if (!existsSync(repoDir)) {
      mkdirSync(dirname(repoDir), { recursive: true });
      execFileSyncFn("gh", ["repo", "clone", `${deps.owner}/${repo}`, repoDir], { stdio: "inherit" });
    } else {
      execFileSyncFn("git", ["-C", repoDir, "fetch", "--quiet", "origin"], { stdio: "pipe" });
      execFileSyncFn("git", ["-C", repoDir, "reset", "--hard", "--quiet", "origin/main"], { stdio: "pipe" });
    }
  }
  materializeGeneratedSubject(planPath, subject, repo);

  const preflight = resolveWipeTestPreflight(subject.id, deps.resolveMergedState(subject.id, planPath, deps.config));
  if ("error" in preflight) {
    return { status: "refused", reason: preflight.error, target: resolved.target, planPath };
  }

  // ledger-read-intent: live — arm ordering matches the original CLI path, which deliberately
  // counts only already-written live pair rows before dispatching either arm.
  const priorLedgerLines = readLedgerLines(ledgerPath);
  const pairIndex =
    deps.pairIndex ??
    priorLedgerLines.filter((l) => l.task_id === subject.id && l.step === WIPE_TEST_PAIR_STEP).length;
  const dispatchOrder = resolveWipeTestArmOrder(pairIndex);
  const runId = deps.runId ?? `WIPETEST-${deps.now?.().getTime() ?? Date.now()}`;

  const rawResults: Partial<Record<WipeTestArm, RunResult>> = {};
  for (const arm of dispatchOrder) {
    const label = `${factor}${arm === "A" ? " ON" : " MASKED"}`;
    console.log(`### rmd wipe-test — ${subject.id} on ${deps.owner}/${repo}: arm ${arm} (${label})`);
    rawResults[arm] = await deps.runTaskFn(subject.id, {
      planPath,
      config: deps.config,
      skipGitSync: true,
      ...(wipeTestFactorMasksLearnings(factor, arm) ? { maskLearnings: true } : {}),
      ...(wipeTestFactorMasksRecon(factor, arm) ? { maskRecon: true } : {}),
      ...(wipeTestFactorMasksRules(factor, arm) ? { maskRules: true } : {}),
      noMerge: true,
    });
  }

  // ledger-read-intent: live — derive arm metrics from the same live ledger rows the original
  // CLI path read immediately after both arms completed.
  const ledgerLines = readLedgerLines(ledgerPath);
  const pair: WipeTestPair = {
    taskId: subject.id,
    factor,
    armA: deriveWipeTestRunResult(rawResults.A!, ledgerLines),
    armB: deriveWipeTestRunResult(rawResults.B!, ledgerLines),
  };
  const delta = ledgerWipeTestPair(ledgerPath, runId, pair);
  return { status: "measured", target: resolved.target, planPath, runId, pair, delta };
}
