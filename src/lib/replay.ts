/**
 * The golden-task regression suite (W1-T165, MASTER-PLAN §5A/§9) — the missing
 * SELF-HARNESS leg. The harness has no self-test today: a change to a worker
 * prompt, the review logic, or a rung selector ships unproven against
 * known-good behavior. A GOLDEN is a recorded known-good run — a task spec
 * plus its recorded terminal disposition/shape — curated from the ledger's
 * history. `replayGoldens` drives each golden's task spec through a
 * CANDIDATE harness and compares the outcome to what the golden recorded, so
 * a harness-touching change can be validated by replay in sandbox
 * (remudero-sandbox, the venue commissioned live by W1-T12d / PR #69) BEFORE
 * it ships.
 *
 * MECHANISM, not orchestration: this module never spawns a worker and never
 * touches the sandbox itself. The seam is {@link HarnessRunner} — a
 * caller-supplied function that actually drives one golden's task spec
 * through a candidate harness (in production: a dispatch against
 * remudero-sandbox; in a unit test: a pure stub standing in for "unchanged"
 * or "deliberately degraded"). `replayGoldens` only compares whatever that
 * function returns against the golden's recorded expectation — pure
 * reducer / injected effect, the same split retro.ts's mutation-gate section
 * already uses (`mutationGateLifetime` reads, `recordMutationGateVerdict`
 * writes). retro.ts reads the {@link REPLAY_RESULT_STEP} ledger lines this
 * module writes and reports the replay pass-rate for the cycle.
 *
 * Start MINIMAL (design note, distrust-checked against source before
 * writing this): {@link SEEDED_GOLDENS} seeds exactly 3 goldens, one per
 * workflow class named in the task (plan filing, src fix, doc task that
 * engages the fix-rung heal loop) — grown from PRODUCTION FAILURES per the
 * literature's curve, never front-loaded to "curate every class now".
 */

import { appendLedger, type LedgerLine } from "./ledger.js";

/** The three workflow classes {@link SEEDED_GOLDENS} spans (design note, verbatim). */
export type GoldenClass = "plan-filing" | "src-fix" | "doc-fix-rung";

/** The minimal task-spec shape a candidate harness needs to replay one golden —
 *  mirrors the fields of `plan.ts`'s `Task` a dispatch actually reads, not the
 *  full plan-row shape (a golden is not a live plan entry). */
export interface GoldenTaskSpec {
  id: string;
  type: string;
  verify: string;
  files: string[];
}

/** The golden's recorded terminal disposition/shape (design note (1)) — what a
 *  correct candidate harness must reproduce for this golden to PASS replay. */
export interface GoldenExpectation {
  verdict: string;
  filesTouched: string[];
  prTrailerTaskId: string;
  /** Present only for a golden whose known-good run required a fix-rung
   *  round (the doc-fix-rung class) — the number of fix dispatches the
   *  known-good run actually took before it merged. */
  fixDispatches?: number;
}

/** One replayable golden: a task spec plus the known-good disposition it must reproduce. */
export interface GoldenTask {
  id: string;
  class: GoldenClass;
  title: string;
  task: GoldenTaskSpec;
  expected: GoldenExpectation;
}

/** What a candidate harness ACTUALLY produced for one golden's task spec —
 *  compared field-for-field against {@link GoldenExpectation}. */
export interface ReplayOutcome {
  verdict: string;
  filesTouched: string[];
  prTrailerTaskId?: string;
  fixDispatches?: number;
}

/**
 * The seam between this mechanism and whatever actually drives a golden's
 * task spec through a candidate harness. Production wires this to a
 * dispatch against remudero-sandbox (the proven venue, W1-T12d); a unit
 * test wires it to a pure stub. `replayGoldens` never assumes anything
 * about how the outcome was produced — only that it matches this shape.
 */
export type HarnessRunner = (golden: GoldenTask) => ReplayOutcome | Promise<ReplayOutcome>;

/** The result of replaying ONE golden — `passed` iff the outcome matches the
 *  golden's expectation on every compared field; `mismatches` names every
 *  field that did not, for the falsifier case to be diagnosable, not just detectable. */
export interface ReplayResult {
  goldenId: string;
  class: GoldenClass;
  passed: boolean;
  mismatches: string[];
}

/** True iff `a` and `b` contain the same set of paths, ORDER-independent —
 *  a candidate harness that touches the same files in a different diff
 *  order is not a regression this suite exists to catch. */
function sameFileSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((f) => bSet.has(f));
}

/**
 * Compare one golden's recorded expectation against what a candidate
 * harness actually produced — the comparison half of the replay mechanism
 * (design note (1): "compare the outcome to the golden's expected result").
 * Pure: never runs a harness, never touches the ledger.
 */
export function compareOutcome(golden: GoldenTask, outcome: ReplayOutcome): ReplayResult {
  const mismatches: string[] = [];
  if (outcome.verdict !== golden.expected.verdict) {
    mismatches.push(`verdict: expected "${golden.expected.verdict}", got "${outcome.verdict}"`);
  }
  if (!sameFileSet(outcome.filesTouched, golden.expected.filesTouched)) {
    mismatches.push(
      `filesTouched: expected [${golden.expected.filesTouched.join(", ")}], got [${outcome.filesTouched.join(", ")}]`,
    );
  }
  if (outcome.prTrailerTaskId !== golden.expected.prTrailerTaskId) {
    mismatches.push(
      `prTrailerTaskId: expected "${golden.expected.prTrailerTaskId}", got "${outcome.prTrailerTaskId ?? "(none)"}"`,
    );
  }
  if (golden.expected.fixDispatches !== undefined && outcome.fixDispatches !== golden.expected.fixDispatches) {
    mismatches.push(`fixDispatches: expected ${golden.expected.fixDispatches}, got ${outcome.fixDispatches ?? 0}`);
  }
  return { goldenId: golden.id, class: golden.class, passed: mismatches.length === 0, mismatches };
}

/** Replay ONE golden against a candidate harness (design note (1)). */
export async function replayGolden(golden: GoldenTask, run: HarnessRunner): Promise<ReplayResult> {
  const outcome = await run(golden);
  return compareOutcome(golden, outcome);
}

/** Replay every golden in `goldens` against a candidate harness, in order,
 *  each independently — one golden's outcome never influences another's. */
export async function replayGoldens(goldens: GoldenTask[], run: HarnessRunner): Promise<ReplayResult[]> {
  const out: ReplayResult[] = [];
  for (const golden of goldens) {
    out.push(await replayGolden(golden, run));
  }
  return out;
}

/** `n passed / n goldens` for one replay run — the figure retro.ts's
 *  calibration section renders for the cycle. */
export interface ReplayPassRate {
  total: number;
  passed: number;
  rate: number;
}

export function replayPassRate(results: ReplayResult[]): ReplayPassRate {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  return { total, passed, rate: total ? passed / total : 0 };
}

/** The ledger step {@link replayResultLine} writes, one line per golden per
 *  replay run — retro.ts's `replayPassRateForCycle` reads back exactly this
 *  step name, mirroring `MUTATION_GATE_VERDICT_STEP`'s write/read split. */
export const REPLAY_RESULT_STEP = "replay.result";

/** Build (never write) the ledger line for one golden's replay result — pure,
 *  same builder/writer split as retro.ts's `mutationGateVerdictLine`. */
export function replayResultLine(runId: string, taskId: string, result: ReplayResult): LedgerLine {
  return {
    run_id: runId,
    task_id: taskId,
    step: REPLAY_RESULT_STEP,
    golden_id: result.goldenId,
    class: result.class,
    passed: result.passed,
    ...(result.mismatches.length ? { mismatches: result.mismatches } : {}),
  };
}

/** Dependencies for {@link recordReplayResults} — an injectable writer so a
 *  test spies on it instead of touching disk (mirrors `MutationGateVerdictDeps`). */
export interface RecordReplayResultsDeps {
  ledgerPath: string;
  writeLedger?: typeof appendLedger;
}

/** Append one {@link replayResultLine} per result — the write side a
 *  production replay-against-sandbox caller invokes after `replayGoldens`
 *  returns; a unit test never needs this (it reads `ReplayResult[]` directly). */
export function recordReplayResults(runId: string, taskId: string, results: ReplayResult[], deps: RecordReplayResultsDeps): void {
  const writeLedger = deps.writeLedger ?? appendLedger;
  for (const result of results) {
    writeLedger(deps.ledgerPath, replayResultLine(runId, taskId, result));
  }
}

// ── 3 seeded goldens, one per workflow class (design note (2)) ──────────────
//
// Each golden's `expected` is the disposition/shape a correct, UNCHANGED
// harness must reproduce; `test/replay.test.ts`'s falsifier degrades exactly
// one field per golden to prove replay actually catches a regression rather
// than passing unconditionally.

export const SEEDED_GOLDENS: GoldenTask[] = [
  {
    id: "golden-plan-filing-1",
    class: "plan-filing",
    title: "plan filing — a triaged feedback filing lands as a plan-only PR touching plan/tasks.yaml",
    task: { id: "GOLDEN-PLAN-1", type: "plan", verify: "auto", files: ["plan/tasks.yaml"] },
    expected: {
      verdict: "merged",
      filesTouched: ["plan/tasks.yaml"],
      prTrailerTaskId: "GOLDEN-PLAN-1",
    },
  },
  {
    id: "golden-src-fix-1",
    class: "src-fix",
    title: "src fix — a scoped, unit-tested bugfix in one src file merges clean on the first pass",
    task: { id: "GOLDEN-SRC-1", type: "implement", verify: "auto", files: ["src/lib/example.ts"] },
    expected: {
      verdict: "merged",
      filesTouched: ["src/lib/example.ts", "test/example.test.ts"],
      prTrailerTaskId: "GOLDEN-SRC-1",
    },
  },
  {
    id: "golden-doc-fix-rung-1",
    class: "doc-fix-rung",
    title: "doc task — review's first pass flags a doc-shape nit; the fix-rung heals it and it merges",
    task: { id: "GOLDEN-DOC-1", type: "docs", verify: "auto", files: ["docs/example.md"] },
    expected: {
      verdict: "merged",
      filesTouched: ["docs/example.md"],
      prTrailerTaskId: "GOLDEN-DOC-1",
      fixDispatches: 1,
    },
  },
];
