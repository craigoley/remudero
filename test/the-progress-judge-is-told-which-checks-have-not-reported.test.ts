import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { buildFixProgressInput, type FixProgressInput } from "#src/lib/fix-progress-judge.js";
import { DEFAULT_SWEEP_POLICY, pendingQualityGateNames, productionFixProgressJudge, runSweep, type OpenPrView,
  type RollupCheckEntry, type SweepDeps } from "#src/lib/sweep.js";

const TASK = "W1-T9877";
const HEAD = "7518991a5";
const NOW = Date.now();
const REQUIRED = ["acceptance-author-gate", "ci", "head-identity-gate", "lint-plan", "proof-discrimination", "rule-checks"];
const EARLY_REDS = ["acceptance-author-gate", "head-identity-gate", "proof-discrimination"];
const CLEARED = { verdict: "continue", reason: "The latest round cleared the rule-checks red after the scope amendment merged" } as const;

/** #12575 at 16:37Z: three gates concluded red, `ci` still running, `rule-checks` not yet posted. */
const halfReported: RollupCheckEntry[] = [
  ...EARLY_REDS.map(name => ({ name, status: "COMPLETED", conclusion: "FAILURE" })),
  { name: "ci", status: "IN_PROGRESS" },
  { name: "lint-plan", status: "COMPLETED", conclusion: "SUCCESS" },
];
/** The same head once every required check has concluded. */
const fullyReported: RollupCheckEntry[] = [
  ...EARLY_REDS.map(name => ({ name, status: "COMPLETED", conclusion: "FAILURE" })),
  ...["ci", "lint-plan", "rule-checks"].map(name => ({ name, status: "COMPLETED", conclusion: "SUCCESS" })),
];

/** One completed round, dispatched against rule-checks on the head before the branch update. */
const ledger = (): Record<string, unknown>[] => [
  { task_id: TASK, step: "fix.dispatch", round_id: "r1", pr_number: 12575, head_sha: "125ad2aaa",
    ci_failures: [{ check: "rule-checks" }] },
  { task_id: TASK, step: "fix.done", round_id: "r1", pr_number: 12575, head_sha: "125ad2aaa",
    pushed_head_sha: HEAD, fix_outcome: "FIXED", subtype: "success" },
];

const inputFor = (rollup: RollupCheckEntry[]) => buildFixProgressInput({ taskId: TASK, prNumber: 12575, headSha: HEAD,
  strikesSpent: 1, currentRed: EARLY_REDS, ledger: ledger(), pendingChecks: pendingQualityGateNames(rollup, REQUIRED) });

const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 12575, prUrl: "https://github.com/o/r/pull/12575", taskId: TASK,
  headSha: HEAD, checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  redRequiredChecks: [...EARLY_REDS], ciFailures: EARLY_REDS.map(name => ({ name, logTail: "not ok 1 - red" })), ...over,
});

function sweepFixture() {
  const rows = ledger();
  const judged: FixProgressInput[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/pending-checks-ledger", runId: "pending-checks-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async input => { judged.push(input); return CLEARED; },
    arm: () => {}, close: () => {}, escalate: () => {}, dispatchFix: () => {},
  };
  return { deps, rows, judged };
}

describe("test/the-progress-judge-is-told-which-checks-have-not-reported.test.ts", () => {
  test("W1-T10067: a half-reported head marks the newest round partial and names its pending checks", async () => {
    assert.deepEqual(pendingQualityGateNames(halfReported, REQUIRED), ["ci", "rule-checks"],
      "a running check and a check not yet posted are both pending; concluded ones are not");
    const input = inputFor(halfReported);
    assert.deepEqual(input.pendingChecks, ["ci", "rule-checks"]);
    assert.equal(input.signals.pendingChecks, 2);
    const newest = input.rounds.at(-1)!;
    assert.deepEqual(newest.redBefore, ["rule-checks"]);
    assert.equal(newest.redAfter?.includes("rule-checks"), false, "rule-checks is absent from the red it has not reported to");
    assert.equal(newest.redAfterPartial, true, "so the round's red-after is marked as read off a half-reported head");

    let prompt = "";
    const judge = productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json",
      mount: { model: "test-model", effort: "low", maxTurns: 1, contextBudget: 10000 }, spawn: async args => {
        prompt = args.prompt;
        return { text: `FIX_PROGRESS: ${JSON.stringify(CLEARED)}` } as never;
      } });
    await judge(input);
    assert.match(prompt, /pendingChecks names required checks that had not reported/);
    assert.match(prompt, /a pending check's absence from redAfter or currentRed is not evidence it was fixed/);
    assert.match(prompt, /"pendingChecks":\["ci","rule-checks"\]/);
    assert.match(prompt, /"redAfterPartial":true/);
  });

  test("W1-T10067: a fully reported head carries no pending marker", () => {
    assert.deepEqual(pendingQualityGateNames(fullyReported, REQUIRED), []);
    const input = inputFor(fullyReported);
    assert.equal("pendingChecks" in input, false);
    assert.equal("pendingChecks" in input.signals, false);
    assert.equal(input.rounds.some(round => "redAfterPartial" in round), false);
    // The pending set enters the input a verdict is keyed on, so a half-reported verdict is never reused.
    const key = (i: FixProgressInput) => createHash("sha256").update(JSON.stringify(i)).digest("hex");
    assert.notEqual(key(inputFor(halfReported)), key(input));
    // A round whose red-after is the next round's dispatch red is history, not a half-reported read.
    const twoRounds = buildFixProgressInput({ taskId: TASK, prNumber: 12575, headSha: HEAD, currentRed: EARLY_REDS,
      pendingChecks: ["rule-checks"], ledger: [...ledger(),
        { task_id: TASK, step: "fix.dispatch", round_id: "r2", pr_number: 12575, head_sha: HEAD, ci_failures: [{ check: "ci" }] }] });
    assert.equal(twoRounds.rounds[0]!.redAfterPartial, undefined);
  });

  test("W1-T10067: the fix-strike judgment row names the pending checks", async () => {
    const f = sweepFixture();
    await runSweep([pr({ pendingRequiredChecks: ["ci", "rule-checks"] })], f.deps, DEFAULT_SWEEP_POLICY);
    assert.ok(f.judged.length >= 1, "the judge is asked about the completed round");
    assert.deepEqual(f.judged[0]!.pendingChecks, ["ci", "rule-checks"]);
    assert.equal(f.judged[0]!.rounds.at(-1)!.redAfterPartial, true);
    const judgedRows = f.rows.filter(row => row.step === "fix.progress_judged");
    assert.equal(judgedRows.length, 1);
    assert.equal(judgedRows[0]!.site, "fix-strike");
    assert.deepEqual(judgedRows[0]!.pending_checks, ["ci", "rule-checks"]);
    assert.equal((judgedRows[0]!.signals as Record<string, unknown>).pendingChecks, 2);

    const concluded = sweepFixture();
    await runSweep([pr()], concluded.deps, DEFAULT_SWEEP_POLICY);
    const row = concluded.rows.find(r => r.step === "fix.progress_judged");
    assert.ok(row, "a fully reported head is still judged");
    assert.equal("pending_checks" in row, false);
  });
});
