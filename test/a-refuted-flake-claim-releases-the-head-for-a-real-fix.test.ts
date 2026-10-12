import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { join } from "node:path";
import * as sweepCore from "../src/lib/sweep.js";
import { fixRoundTally, fixRungStalledWithoutNewHead, runSweep,
  type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { runFixRung } from "./helpers/run-task-test.js";
import { gitRepo } from "./helpers/git-repo.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK = "W1-T7449", HEAD = "a5975e7", NOW = Date.now();
type Row = Record<string, unknown>;
const history = (claim = "refuted", head = HEAD, task = TASK): Row[] => [
  { step: "fix.dispatch", task_id: task, round_id: "flake-1", head_sha: head,
    mode: "ci-log", ci_failures: [{ check: "ci" }] },
  { step: "sweep.disposed", task_id: task, pr_number: 10400, head_sha: head,
    disposition: "blocked-fixable", acted: true, red_checks: ["ci"] },
  { step: "sweep.check_requeued", task_id: task, head_sha: head, check_name: "ci", job_id: "123" },
  { step: "fix.done", task_id: task, round_id: "flake-1", head_sha: head,
    fix_outcome: "FLAKE", flake_claim: claim, subtype: "success" },
];
const pr = (head = HEAD): OpenPrView => ({
  prNumber: 10400, prUrl: "https://github.com/o/r/pull/10400", taskId: TASK,
  headSha: head, checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: "ci", logTail: "not ok 3 - deterministic failure", jobId: "123" }],
});
function sweep(rows: Row[], judge: NonNullable<SweepDeps["fixProgressJudge"]>) {
  const dispatched: unknown[] = [], escalated: string[] = [];
  let reruns = 0;
  const deps: SweepDeps = {
    ledgerPath: "/unused/refuted-flake", runId: "refuted-flake", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: judge, arm: () => {}, close: () => {},
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence); },
    escalate: (_pr, reason) => { escalated.push(reason); },
    requeueCheck: () => { reruns++; return true; },
    rerunFailedChecks: async () => { reruns++; return { outcome: "rerun", runIds: [1] }; },
  };
  return { deps, dispatched, escalated, reruns: () => reruns };
}

async function rung(rows: Row[], head = HEAD, admitted = true) {
  const repo = gitRepo({ kind: "refuted-flake" });
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
  const review = { state: "failure", criteria: [], testTheater: false, summary: "red",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: head, reviewerOutcome: "failure" } as Parameters<typeof runFixRung>[0]["initialReview"];
  let prompt = "", reruns = 0, waits = 0, pushes = 0, judgments = 0;
  const result = await runFixRung({ taskId: TASK, runId: "repeat-flake",
    task: { id: TASK, title: "fix the deterministic red", files: ["src/fix.ts"] },
    prUrl: pr().prUrl, branch: "run-W1-T7449-1", worktreePath: repo.dir,
    initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as never,
    budgetUsd: 1, strikeCap: 2, initialReview: review, ciFailures: pr(head).ciFailures,
    progressDecision: admitted ? { verdict: "continue", reason: "sweep admitted a real fix" } : undefined,
    reviewBase: { owner: "o", repo: "r", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      fixProgressJudge: async input => {
        judgments++;
        assert.equal(Reflect.get(input.signals, "refutedFlakeClaims"), 1);
        assert.match(String(input.parkedReason), /flake claimed and refuted on an unchanged red/);
        return { verdict: "continue", reason: "attempt a real repair" };
      },
      spawn: async args => { prompt = args.prompt; return {
        sessionId: "flake-worker", costUsd: 0, numTurns: 1,
        text: "REPORT\nFIX_OUTCOME: FLAKE", blocks: [], stderr: "", subtype: "success",
        isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
        model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
      } as WorkerResult; },
      waitForCiGreen: async () => { waits++; return "red"; },
      runReview: async () => review, fetchPrBody: async () => "REPORT", push: () => { pushes++; },
      issues: { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, task_id: TASK, ...extra }); },
      say: () => {}, account: r => r, requeueCheck: () => { reruns++; return true; },
    },
  });
  return { result, prompt, reruns, waits, pushes, judgments };
}

describe("test/a-refuted-flake-claim-releases-the-head-for-a-real-fix.test.ts", () => {
  test("a refuted rerun releases the head and the next pass dispatches a real fix", async () => {
    const rows = history();
    const f = sweep(rows, async input => {
      assert.equal(Reflect.get(input.signals, "refutedFlakeClaims"), 1);
      assert.equal(Reflect.get(input.signals, "repeatedFlakeClaims"), 0);
      assert.equal(input.signals.noOpRounds, 1);
      assert.equal(input.signals.identicalRedSets, 1);
      return { verdict: "change-approach", approach: "repair the source map", reason: "red reproduced" };
    });
    await runSweep([pr()], f.deps);
    assert.equal(f.dispatched.length, 1);
    assert.equal((f.dispatched[0] as { progressApproach: string }).progressApproach, "repair the source map");
    assert.equal(f.reruns(), 0);
    assert.deepEqual(f.escalated, []);
    assert.match(String(rows.findLast(r => r.step === "sweep.disposed")?.stand_down_reason),
      /flake claim refuted at a5975e7 — dispatching a real fix round/);
  });

  test("a repeated FLAKE is recorded as a no-op without rerunning, waiting or pushing", async () => {
    const rows = history();
    const f = await rung(rows);
    assert.match(f.prompt, /this red reproduced on a rerun at a5975e7; it is not a flake/);
    assert.equal(rows.findLast(r => r.step === "fix.done")?.flake_claim, "repeated");
    assert.equal(f.reruns, 0);
    assert.equal(f.waits, 0);
    assert.equal(f.pushes, 0);
    assert.equal(f.result.outcome, "stood_down");
    const tally = fixRoundTally(rows, TASK, HEAD);
    assert.equal(tally.noCommitRounds.length, 1);
    assert.equal(tally.strikes, 0);
    const errored = rows.map(row => row.step === "fix.done" && row.flake_claim === "repeated"
      ? { ...row, subtype: "error" } : row);
    assert.equal(fixRoundTally(errored, TASK, HEAD, "executed").noCommitRounds.length, 1);
    assert.equal(fixRungStalledWithoutNewHead(rows, TASK), true);
    const s = sweep(rows, async input => {
      assert.equal(Reflect.get(input.signals, "refutedFlakeClaims"), 1);
      assert.equal(Reflect.get(input.signals, "repeatedFlakeClaims"), 1);
      assert.equal(input.signals.noOpRounds, 2);
      return { verdict: "escalate", loop: "flake claimed and refuted on an unchanged red", reason: "no new evidence" };
    });
    await runSweep([pr()], s.deps);
    assert.equal(s.reruns(), 0, "the no-commit gateway must not rerun a repeated FLAKE");
    assert.equal(s.dispatched.length, 0);
    assert.match(s.escalated[0], /flake claimed and refuted on an unchanged red/);
    await runSweep([pr()], s.deps);
    assert.equal(s.escalated.length, 1);
  });

  test("an unavailable progress verdict holds and is asked again on the next pass", async () => {
    const rows = history();
    let calls = 0;
    const f = sweep(rows, async () => ++calls === 1 ? undefined : { verdict: "continue", reason: "attempt a real repair" });
    await runSweep([pr()], f.deps);
    assert.equal(calls, 1);
    assert.equal(f.dispatched.length, 0);
    await runSweep([pr()], f.deps);
    assert.equal(calls, 2);
    assert.equal(f.dispatched.length, 1);
  });

  test("the fix rung gives the refutation to its own progress judge before starting the worker", async () => {
    const rows = history();
    const f = await rung(rows, HEAD, false);
    assert.equal(f.judgments, 1);
    assert.equal(rows.findLast(r => r.step === "fix.done")?.flake_claim, "repeated");
    assert.equal(f.reruns, 0);
  });

  test("many repeated claims remain the progress judge's decision rather than a strike ceiling", async () => {
    const rows = history();
    for (let i = 0; i < 5; i++) rows.push(
      { step: "fix.dispatch", task_id: TASK, round_id: `repeat-${i}`, head_sha: HEAD, mode: "ci-log", ci_failures: [{ check: "ci" }] },
      { step: "fix.done", task_id: TASK, round_id: `repeat-${i}`, head_sha: HEAD, flake_claim: "repeated", fix_outcome: "FLAKE", subtype: "success" });
    const f = sweep(rows, async input => {
      assert.equal(Reflect.get(input.signals, "repeatedFlakeClaims"), 5);
      return { verdict: "continue", reason: "operator supplied new repair evidence" };
    });
    assert.equal(fixRoundTally(rows, TASK, HEAD).strikes, 0);
    assert.equal(fixRoundTally(rows, TASK, HEAD).noCommitRounds.length, 5);
    await runSweep([pr()], f.deps);
    assert.equal(f.dispatched.length, 1);
    assert.equal(f.reruns(), 0);
    assert.deepEqual(f.escalated, []);
  });

  test("confirmed claims and a fresh dispatch keep their hold", () => {
    assert.equal(fixRungStalledWithoutNewHead(history("confirmed"), TASK), false);
    assert.equal(fixRungStalledWithoutNewHead(history(), TASK), true);
    assert.equal(fixRungStalledWithoutNewHead([...history(), { step: "fix.dispatch", task_id: TASK, head_sha: HEAD }], TASK), false);
  });

  test("flake pre-signals preserve the parked reason and exclude other PRs and missing identities", () => {
    const { buildFixProgressInput } = sweepCore;
    assert.equal(typeof buildFixProgressInput, "function");
    const input = buildFixProgressInput({ taskId: TASK, prNumber: 10400, headSha: HEAD,
      currentRed: ["ci"], parkedReason: "previous repair repeated", ledger: history() });
    assert.equal(input.signals.refutedFlakeClaims, 1);
    assert.match(String(input.parkedReason), /previous repair repeated; flake claimed and refuted on an unchanged red/);
    for (const facts of [{ taskId: undefined, headSha: HEAD }, { taskId: TASK, headSha: "" },
      { taskId: TASK, headSha: "new-head" }]) {
      assert.equal(buildFixProgressInput({ ...facts, currentRed: ["ci"], ledger: history() }).signals.refutedFlakeClaims, 0);
    }
    const otherPr = history().map(row => ({ ...row, pr_number: 99 }));
    assert.equal(buildFixProgressInput({ taskId: TASK, prNumber: 10400, headSha: HEAD,
      currentRed: ["ci"], ledger: otherPr }).signals.refutedFlakeClaims, 0);
  });

  test("another head or task's refutation does not suppress a first FLAKE rerun", async () => {
    for (const rows of [history("refuted", "old-head"), history("refuted", HEAD, "other-task"), history("confirmed")]
      .map(rows => rows.filter(row => row.step !== "sweep.check_requeued"))) {
      const f = await rung(rows);
      assert.doesNotMatch(f.prompt, /this red reproduced on a rerun/);
      assert.equal(f.reruns, 1);
      assert.equal(f.waits, 1);
      assert.equal(rows.findLast(r => r.step === "fix.done")?.flake_claim, "refuted");
    }
  });
});
