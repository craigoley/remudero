import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FIRST_FIX_ROUND_UNJUDGED_REASON, buildFixProgressInput, firstFixRoundVerdict,
  type FixProgressInput } from "#src/lib/fix-progress-judge.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { runFixRung, type ReviewRunResult } from "#test/helpers/run-task-test.js";

const TASK = "W1-T10039";
const NOW = Date.now();
const ESCALATE = { verdict: "escalate", loop: "no evidence of progress", reason: "missing receipts are uncertainty" } as const;

const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 12542, prUrl: "https://github.com/o/r/pull/12542", taskId: TASK,
  headSha: "head-0", checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: "ci", logTail: "not ok 1 - a real failure" }], ...over,
});

/** A sweep whose judge counts its calls and would escalate every one. */
function sweepFixture(rows: Record<string, unknown>[]) {
  const dispatched: unknown[] = [], escalated: string[] = [], judged: FixProgressInput[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/first-round-ledger", runId: "first-round-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async input => { judged.push(input); return ESCALATE; },
    arm: () => {}, close: () => {},
    escalate: (_pr, reason) => { escalated.push(reason); },
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence); },
  };
  return { deps, dispatched, escalated, judged };
}

/** A fix rung handed no sweep decision, whose judge counts its calls and escalates. */
async function rungFixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-first-round-"));
  try {
    const mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
    const review = (head: string): ReviewRunResult => ({
      state: "failure", headSha: head,
      criteria: [{ claim: "claim-0", proof: "unit test: claim", met: false, reason: "unmet", proof_exec: "executed_fail" }],
      testTheater: false, summary: "review", floorDegraded: false, capped: false,
      keywordOnly: false, planOnly: false, reviewerOutcome: "success",
    });
    const rows: Record<string, unknown>[] = [];
    const judged: FixProgressInput[] = [];
    let workers = 0;
    const outcome = await runFixRung({ taskId: TASK, runId: "rung-first-round", task: { id: TASK, title: "first round" },
      prUrl: "https://github.com/o/r/pull/12542", branch: "run-W1-T10039-1", worktreePath: root,
      initialSessionId: "session", mount, settingsFile: "settings/worker.json", config: {} as never,
      budgetUsd: 1, strikeCap: 2, initialReview: review("head-0"),
      reviewBase: { owner: "o", repo: "r", headCheckoutDir: root, reviewerMount: mount },
      escalationJudge: async () => ({ decision: "deliver", reason: "named loop" }),
      deps: {
        fixProgressJudge: async input => { judged.push(input); return ESCALATE; },
        spawn: async () => {
          workers++;
          return { sessionId: "session", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
            subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false };
        },
        waitForCiGreen: async () => "green", runReview: async () => review(`head-${workers}`),
        fetchPrBody: async () => `Remudero-Task: ${TASK}`, fetchPrDiffFiles: async () => [], push: () => {},
        issues: { create: () => "https://github.com/o/r/issues/1" },
        ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => [],
        log: (step, fields) => { rows.push({ ...fields, step }); }, say: () => {}, account: r => r,
      },
    });
    return { outcome, workers, judged, rows };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const judgedRows = (rows: Record<string, unknown>[]) => rows.filter(row => row.step === "fix.progress_judged");

describe("test/a-first-fix-round-is-dispatched-without-asking-the-progress-judge.test.ts", () => {
  test("W1-T10039: a first fix round is dispatched without asking the progress judge", async () => {
    const f = sweepFixture([]);
    await runSweep([pr()], f.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(f.judged.length, 0, "an empty history is not put to the judge");
    assert.deepEqual(f.escalated, []);
    assert.equal(f.dispatched.length, 1, "the first round is dispatched");

    // The pre-disposition block: a judgment on another red class makes one due, still with no round behind it.
    const stale = sweepFixture([{ task_id: TASK, step: "fix.progress_judged", pr_number: 12542, head_sha: "head-0",
      round_count: 0, verdict: "continue", reason: "an older red", red_class: "lint" }]);
    await runSweep([pr()], stale.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(stale.judged.length, 0);
    assert.deepEqual(stale.escalated, []);
    assert.equal(stale.dispatched.length, 1);

    // runFixRung with no sweep decision: the first worker runs, and the judge rules only on its completed round.
    const rung = await rungFixture();
    assert.equal(rung.workers, 1, "the first worker round ran without a judgment");
    assert.equal(rung.judged.length, 1);
    assert.equal(rung.judged[0]!.rounds.length, 1, "the judge's first question carries a completed round");
    assert.equal(rung.outcome.outcome, "escalated");
  });

  test("W1-T10039: the skipped first-round judgment is ledgered with its reason", async () => {
    const rows: Record<string, unknown>[] = [];
    const f = sweepFixture(rows);
    await runSweep([pr()], f.deps, DEFAULT_SWEEP_POLICY);
    const sweepRows = judgedRows(rows);
    assert.equal(sweepRows.length, 1);
    assert.equal(sweepRows[0]!.site, "fix-strike");
    for (const row of [sweepRows[0]!, judgedRows((await rungFixture()).rows)[0]!]) {
      assert.equal(row.verdict, "continue");
      assert.equal(row.reason, FIRST_FIX_ROUND_UNJUDGED_REASON);
      assert.equal(row.judge_skipped, "first-round");
      assert.equal(row.round_count, 0);
      assert.equal(typeof row.red_class, "string");
    }
    assert.equal(sweepRows[0]!.red_class, "ci");
  });

  test("W1-T10039: a completed round or a parked wait is still judged", async () => {
    const roundRows: Record<string, unknown>[] = [
      { task_id: TASK, step: "fix.dispatch", round_id: "r1", head_sha: "head-0", ci_failures: [{ check: "ci" }] },
      { task_id: TASK, step: "fix.done", round_id: "r1", head_sha: "head-0", pushed_head_sha: "head-1",
        fix_outcome: "FIXED", subtype: "success" },
    ];
    const completed = sweepFixture(roundRows);
    await runSweep([pr({ headSha: "head-1" })], completed.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(completed.judged.length, 1);
    assert.equal(completed.judged[0]!.rounds.length, 1);
    assert.equal(completed.dispatched.length, 0);
    assert.match(completed.escalated[0] ?? "", /no evidence of progress/);

    const parked = sweepFixture([{ task_id: TASK, step: "sweep.disposed", pr_number: 12542, head_sha: "head-0",
      metadata_red_checks: ["commitlint"], metadata_repair_outcome: "repaired", disposition: "blocked-fixable", acted: false }]);
    await runSweep([pr({ ciFailures: [{ name: "commitlint", logTail: "header invalid" }] })], parked.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(parked.judged.length, 1, "a parked wait with no round is still judged");
    assert.equal(parked.judged[0]!.rounds.length, 0);
    assert.match(parked.judged[0]!.parkedReason ?? "", /edited-event verdict/);
    assert.equal(parked.dispatched.length, 0);

    const empty = buildFixProgressInput({ taskId: TASK, headSha: "h", currentRed: ["ci"], ledger: [] });
    assert.equal(firstFixRoundVerdict(empty)?.reason, FIRST_FIX_ROUND_UNJUDGED_REASON);
    assert.equal(firstFixRoundVerdict({ ...empty, strikesSpent: 1 }), undefined);
    assert.equal(firstFixRoundVerdict({ ...empty, parkedReason: "rerun-still-red: once" }), undefined);
    assert.equal(firstFixRoundVerdict(buildFixProgressInput({ taskId: TASK, headSha: "h", currentRed: ["ci"],
      ledger: roundRows })), undefined);
  });
});
