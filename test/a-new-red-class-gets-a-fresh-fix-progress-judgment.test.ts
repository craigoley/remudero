import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildFixProgressInput, fixRedClass } from "#src/lib/fix-progress-judge.js";
import {
  DEFAULT_SWEEP_POLICY, fixRoundLabel, lastProgressJudgementFor, prRedClass, productionFixProgressJudge, runSweep,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

const TASK = "W1-T9001";
const NOW = Date.now();
const STALE_APPROACH = "stale approach: split the comment-load baseline row";
const CENSUS_LOG = "census-precheck: BLOCKED -- the comment-load ratchet baseline row is missing";
const DIFF_LOG = "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests";

const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 10671, prUrl: "https://github.com/o/r/pull/10671", taskId: TASK,
  headSha: "head-5", checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  redRequiredChecks: ["coverage-shard (3/8)", "coverage-ratchet"],
  ciFailures: [
    { name: "coverage-shard (3/8)", logTail: "not ok 12 - something" },
    { name: "coverage-ratchet", logTail: DIFF_LOG },
  ], ...over,
});

/** The class the stale verdict was ruled on: the comment-load ratchet red behind a census-precheck refusal. */
const OLD_CLASS = "census-precheck";
const staleRows = (withClass: boolean): Record<string, unknown>[] => [
  { task_id: TASK, step: "fix.dispatch", round_id: "r1", head_sha: "head-1", ci_failures: [{ check: "coverage-ratchet" }] },
  { task_id: TASK, step: "fix.done", round_id: "r1", head_sha: "head-1", pushed_head_sha: "head-2", fix_outcome: "FIXED" },
  { task_id: TASK, step: "fix.progress_judged", pr_number: 10671, head_sha: "head-2", round_count: 4,
    verdict: "change-approach", approach: STALE_APPROACH, reason: "census-precheck kept refusing",
    ...(withClass ? { red_class: OLD_CLASS } : {}) },
];

function sweepFixture(rows: Record<string, unknown>[], judge?: NonNullable<SweepDeps["fixProgressJudge"]>) {
  const dispatched: unknown[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/fresh-judgment-ledger", runId: "fresh-judgment-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    ...(judge ? { fixProgressJudge: judge } : {}), arm: () => {}, close: () => {}, escalate: () => {},
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence); },
  };
  return { deps, dispatched };
}

describe("test/a-new-red-class-gets-a-fresh-fix-progress-judgment.test.ts", () => {
  test("W1-T7762: a red class differing from the ruled one never shows the stale judge label", async () => {
    const rows = staleRows(true);
    const f = sweepFixture(rows, async () => ({ verdict: "continue", reason: "a different red" }));
    const summary = await runSweep([pr()], f.deps, DEFAULT_SWEEP_POLICY);
    const reason = summary.actions[0]!.reason;
    assert.doesNotMatch(reason, /change-approach/);
    assert.match(reason, /awaiting a fresh judgment \(red changed from census-precheck to /);
    // The pure label: the old verdict, reason and approach are never in it, and a legacy row (no class) is stale too.
    for (const withClass of [true, false]) {
      const label = lastProgressJudgementFor(staleRows(withClass), 10671, "coverage-shard+diff-coverage");
      const text = fixRoundLabel(pr({ lastProgressJudgement: label }), 2);
      assert.match(text, /^fix round 5 — awaiting a fresh judgment \(red changed from /);
      assert.doesNotMatch(text, /change-approach|kept refusing|stale approach/);
    }
    assert.match(fixRoundLabel(pr({ lastProgressJudgement: lastProgressJudgementFor(staleRows(false), 10671, "x") }), 2),
      /from an unrecorded class to x/);
    // The same class keeps its verdict's label.
    const same = lastProgressJudgementFor(staleRows(true), 10671, OLD_CLASS);
    assert.match(fixRoundLabel(pr({ lastProgressJudgement: same }), 2), /judge: change-approach/);
  });

  test("W1-T7762: a new red class gets a fresh judgment, never the stale verdict", async () => {
    const rows = staleRows(true);
    const seen: { redClass?: string; otherClassRounds?: number }[] = [];
    const f = sweepFixture(rows, async input => {
      seen.push({ redClass: input.redClass, otherClassRounds: input.signals.otherClassRounds });
      return { verdict: "continue", reason: "the new red is a different problem" };
    });
    const view = pr();
    assert.ok(view.priorStrikes < DEFAULT_SWEEP_POLICY.strikeCap, "the PR is below the former ceiling");
    await runSweep([view], f.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(seen.length, 1, "a judgment is made below the former ceiling");
    assert.equal(seen[0]!.redClass, prRedClass(view));
    assert.notEqual(seen[0]!.redClass, OLD_CLASS);
    const fresh = rows.filter(r => r.step === "fix.progress_judged").at(-1)!;
    assert.equal(fresh.verdict, "continue");
    assert.equal(fresh.red_class, prRedClass(view));
    // The next pass reads the fresh verdict as its own class's label.
    const judgedBefore = rows.filter(r => r.step === "fix.progress_judged").length;
    await runSweep([view], f.deps, DEFAULT_SWEEP_POLICY);
    assert.ok(judgedBefore >= 2);
    assert.equal(lastProgressJudgementFor(rows, 10671, prRedClass(view))?.redChanged, undefined,
      "the fresh verdict is the label of its own class");
  });

  test("W1-T7762: every fix.progress_judged row names its red class", async () => {
    // Ceiling site: the PR has spent its strikes, so the pre-pass judges it.
    const rows = staleRows(false);
    const f = sweepFixture(rows, async () => ({ verdict: "continue", reason: "ok" }));
    const view = pr({ priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap });
    await runSweep([view], f.deps, DEFAULT_SWEEP_POLICY);
    const judged = rows.filter(r => r.step === "fix.progress_judged" && r.verdict !== undefined && r.red_class !== undefined);
    assert.ok(judged.length >= 1, "the ceiling site wrote a row");
    for (const row of rows.filter(r => r.step === "fix.progress_judged" && r.site !== undefined)) {
      assert.equal(row.red_class, prRedClass(view), `site ${String(row.site)} names its class`);
    }
  });

  test("W1-T7762: the fixable path's row names its red class too", async () => {
    const rows: Record<string, unknown>[] = [];
    const f = sweepFixture(rows, async () => ({ verdict: "continue", reason: "ok" }));
    const view = pr({ priorStrikes: 0 });
    await runSweep([view], f.deps, DEFAULT_SWEEP_POLICY);
    const judged = rows.filter(r => r.step === "fix.progress_judged");
    assert.ok(judged.length >= 1);
    for (const row of judged) assert.equal(row.red_class, prRedClass(view));
  });

  test("W1-T7762: the judge input names the red class and each round class, with shard indices folded", () => {
    assert.equal(fixRedClass(["ci-shard (3/8)", "ci-shard (7/8)"]), fixRedClass(["ci-shard (1/8)"]));
    assert.equal(fixRedClass(["coverage-shard 4/8", "coverage-shard 7/8"]), "coverage-shard");
    assert.notEqual(fixRedClass(["census-precheck"]), fixRedClass(["diff-coverage"]));
    assert.equal(fixRedClass([]), "none");
    const ledger = [
      { task_id: TASK, step: "fix.dispatch", round_id: "a", head_sha: "h1", ci_failures: [{ check: "comment-load-ratchet" }] },
      { task_id: TASK, step: "fix.done", round_id: "a", head_sha: "h1", pushed_head_sha: "h2", fix_outcome: "FIXED" },
      { task_id: TASK, step: "fix.dispatch", round_id: "b", head_sha: "h2", ci_failures: [{ check: "ci-shard (3/8)" }] },
      { task_id: TASK, step: "fix.done", round_id: "b", head_sha: "h2", pushed_head_sha: "h3", fix_outcome: "FIXED" },
    ];
    const input = buildFixProgressInput({ taskId: TASK, headSha: "h3", currentRed: ["ci-shard (7/8)"], ledger });
    assert.equal(input.redClass, "ci-shard");
    assert.deepEqual(input.rounds.map(r => r.redClass), ["comment-load-ratchet", "ci-shard"]);
    assert.equal(input.signals.otherClassRounds, 1, "one round was dispatched against a different class");
    const same = buildFixProgressInput({ taskId: TASK, headSha: "h3", currentRed: ["ci-shard (7/8)"], ledger: ledger.slice(2) });
    assert.equal(same.signals.otherClassRounds, undefined);
    const gates = buildFixProgressInput({ taskId: TASK, headSha: "h3", currentRed: ["coverage-ratchet"], ledger: [],
      redClassNames: ["diff-coverage"] });
    assert.equal(gates.redClass, "diff-coverage");
  });

  test("W1-T7762: the production judge prompt says other-class rounds are context", async () => {
    let prompt = "";
    const judge = productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json",
      mount: { model: "m", effort: "low", maxTurns: 1, contextBudget: 1000 }, spawn: async args => {
        prompt = args.prompt;
        return { text: 'FIX_PROGRESS: {"verdict":"continue","reason":"r"}' } as never;
      } });
    await judge(buildFixProgressInput({ taskId: TASK, headSha: "h", currentRed: ["ci"], ledger: [] }));
    assert.match(prompt, /otherClassRounds/);
    assert.match(prompt, /context, not failed attempts/);
  });

  test("W1-T7762: a change-approach ruled on another red class is not carried into the next round", async () => {
    const rows = staleRows(true);
    let calls = 0;
    const f = sweepFixture(rows, async () => { calls++; return { verdict: "continue", reason: "no approach change needed for this red" }; });
    await runSweep([pr()], f.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(calls, 1, "the new class was judged afresh before the round");
    assert.equal(rows.filter(r => r.step === "fix.progress_judged").at(-1)!.approach, undefined);
    assert.ok(f.dispatched.length >= 1, "a round was dispatched");
    for (const evidence of f.dispatched) {
      assert.notEqual((evidence as { progressApproach?: string }).progressApproach, STALE_APPROACH);
      assert.doesNotMatch(JSON.stringify(evidence), /stale approach/);
    }
    // A fresh change-approach on the new class IS carried.
    const rows2 = staleRows(true);
    const g = sweepFixture(rows2, async () => ({ verdict: "change-approach", approach: "fresh approach", reason: "new red" }));
    await runSweep([pr()], g.deps, DEFAULT_SWEEP_POLICY);
    assert.equal((g.dispatched[0] as { progressApproach?: string }).progressApproach, "fresh approach");
  });
});
