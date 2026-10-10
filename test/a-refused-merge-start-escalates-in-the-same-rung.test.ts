import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import { MERGE_HEAD_ABSENT_REASON, runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import { withTempDir } from "../src/lib/tmp.js";
import type { WorkerResult } from "../src/lib/worker.js";

type Run = Parameters<typeof runFixRung>[0];
type Row = { step: string } & Record<string, unknown>;
const MOUNT = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
const FIRST_REASON = "fetch of origin main failed: connection reset";
const SECOND_REASON = "origin/main is already in this branch: no MERGE_HEAD";

function review(state: "success" | "failure"): Run["initialReview"] {
  return {
    state, criteria: [{ claim: "the conflict resolves", proof: "proof", met: state === "success",
      reason: "dirty", proof_exec: "not_executable" }], summary: state, headSha: "branch-head",
    testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    reviewerOutcome: "success",
  };
}

function fixture(root: string) {
  const rows: Row[] = [];
  const issues: Array<{ title: string; body: string }> = [];
  let starts = 0;
  let spawns = 0;
  let pushes = 0;
  const run: Run = {
    taskId: "W1-T5867X", runId: "W1-T5867X-run",
    task: { id: "W1-T5867X", title: "resolve the merge", files: ["conflict.txt"] },
    prUrl: "https://github.com/acme/remudero/pull/5867", branch: "run-W1-T5867X-1",
    worktreePath: root, initialSessionId: "initial", mount: MOUNT,
    settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 5, initialReview: review("failure"),
    progressDecision: { verdict: "continue", reason: "the sweep admitted this round" },
    mergeConflict: { files: [{ path: "conflict.txt", oursDeleted: 1, theirsDeleted: 1 }],
      oursLog: "ours", theirsLog: "theirs" },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      fixProgressJudge: async (input) => {
        const last = input.rounds.at(-1)!;
        assert.equal(last.completed, true);
        if (last.refusal) {
          assert.deepEqual(last.redBefore, ["conflict:conflict.txt"]);
          assert.equal(input.signals.refusedRounds, input.rounds.length);
          assert.ok(input.parkedReason?.includes(last.refusal));
          return input.rounds.length < 2
            ? { verdict: "continue", reason: "retry the merge with new evidence" }
            : { verdict: "escalate", loop: "repeated merge refusals", reason: "the merge did not progress" };
        }
        assert.equal(input.parkedReason, undefined);
        return { verdict: "escalate", loop: "unchanged red after a worker round", reason: "no progress" };
      },
      spawn: async () => {
        spawns++;
        return {
          sessionId: `fix-${spawns}`, costUsd: 0, numTurns: 1,
          text: "REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(merge): resolve the conflict",
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
          tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
          compactionEvents: [], qualitySuspect: false, provider: "claude",
        } satisfies WorkerResult;
      },
      startShellLessMergeConflictMerge: () => ({ started: false, reason: ++starts === 1 ? FIRST_REASON : SECOND_REASON }),
      harnessCommitForShellLessWorker: (input) => { input.onCommit?.("merged-head"); return 1; },
      worktreeHasUncommittedChanges: () => false,
      waitForCiGreen: async () => "green",
      runReview: async () => review("success"), fetchPrBody: async () => "REPORT",
      push: () => { pushes++; },
      issues: {
        create: (title, body) => { issues.push({ title, body }); return "https://github.com/acme/remudero/issues/1"; },
        listOpen: () => [], comment: () => {},
      },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: "W1-T5867X", ...extra }),
      say: () => {}, account: (result) => result,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      captureWorktreeSnapshot: () => ({ status: "", diff: "", untrackedHash: "unchanged" }),
    },
  };
  return { run, rows, issues, counts: () => ({ starts, spawns, pushes }) };
}

describe("test/a-refused-merge-start-escalates-in-the-same-rung.test.ts", () => {
  test("the progress judge escalates two merge-start refusals in this rung, naming both reasons", () =>
    withTempDir("w1-t5867-refused", async (root) => {
      const f = fixture(root);
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.match(outcome.reason, /repeated merge refusals/);
      assert.equal(outcome.strikes, 2);
      assert.deepEqual(f.counts(), { starts: 2, spawns: 0, pushes: 0 });
      assert.deepEqual(f.rows.filter((row) => row.step === "fix.dispatch").map((row) => row.reason),
        [FIRST_REASON, SECOND_REASON]);
      assert.equal(f.issues.length, 1);
      assert.ok(f.issues[0].body.includes(FIRST_REASON));
      assert.ok(f.issues[0].body.includes(SECOND_REASON));
      assert.equal(f.rows.some((row) => row.step === "fix.stood_down"), false);
    }));

  test("a refusal followed by a started merge reaches the worker and pushes its commit", () =>
    withTempDir("w1-t5867-recovery", async (root) => {
      const f = fixture(root);
      let starts = 0;
      f.run.deps.startShellLessMergeConflictMerge = () =>
        ++starts === 1 ? { started: false, reason: FIRST_REASON } : { started: true };
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "fixed");
      assert.equal(outcome.strikes, 2);
      assert.equal(starts, 2);
      assert.equal(f.counts().spawns, 1);
      assert.equal(f.counts().pushes, 1);
      assert.equal(f.issues.length, 0);
    }));

  test("a MERGE_HEAD refusal followed by a merge-start refusal names both in the same escalation", () =>
    withTempDir("w1-t5867-merge-head", async (root) => {
      const f = fixture(root);
      let starts = 0;
      f.run.deps.startShellLessMergeConflictMerge = () =>
        ++starts === 1 ? { started: true } : { started: false, reason: SECOND_REASON };
      f.run.deps.harnessCommitForShellLessWorker = (input) => {
        input.onRefusal?.(MERGE_HEAD_ABSENT_REASON, []);
        return 0;
      };
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.match(outcome.reason, /repeated merge refusals/);
      assert.equal(outcome.strikes, 2);
      assert.equal(starts, 2);
      assert.equal(f.counts().spawns, 1);
      assert.equal(f.counts().pushes, 0);
      assert.equal(f.issues.length, 1);
      assert.ok(f.issues[0].body.includes(MERGE_HEAD_ABSENT_REASON));
      assert.ok(f.issues[0].body.includes(SECOND_REASON));
    }));

  test("the progress judge sees two completed MERGE_HEAD refusals and escalates their loop", () =>
    withTempDir("w1-t5867-two-merge-heads", async (root) => {
      const f = fixture(root);
      let starts = 0;
      f.run.deps.startShellLessMergeConflictMerge = () => { starts++; return { started: true }; };
      f.run.deps.harnessCommitForShellLessWorker = (input) => {
        input.onRefusal?.(MERGE_HEAD_ABSENT_REASON, []);
        return 0;
      };
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.match(outcome.reason, /repeated merge refusals/);
      assert.equal(outcome.strikes, 2);
      assert.equal(starts, 2);
      assert.equal(f.counts().spawns, 2);
      assert.equal(f.counts().pushes, 0);
      assert.equal(f.issues.length, 1);
      assert.ok(f.issues[0].body.includes(MERGE_HEAD_ABSENT_REASON));
      assert.deepEqual(f.rows.filter((row) => row.step === "fix.commit_refused").map((row) => row.reason),
        [MERGE_HEAD_ABSENT_REASON, MERGE_HEAD_ABSENT_REASON]);
      assert.deepEqual(f.rows.filter((row) => row.step === "fix.progress_judged").map((row) => row.round_count), [1, 2]);
    }));

  test("an unchanged round outside merge mode reaches the judge before another worker", () =>
    withTempDir("w1-t5867-normal", async (root) => {
      const f = fixture(root);
      f.run.mergeConflict = undefined;
      f.run.ciFailures = [{ name: "ci", logTail: "tsc: error TS2322" }];
      f.run.deps.waitForCiGreen = async () => "red";
      f.run.deps.fetchCiFailures = async () => [{ name: "ci", logTail: "tsc: error TS2322" }];
      f.run.deps.runReview = async () => review("failure");
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.equal(outcome.strikes, 1);
      assert.match(outcome.reason, /unchanged red after a worker round/);
      assert.deepEqual(f.counts(), { starts: 0, spawns: 1, pushes: 1 });
      assert.equal(f.issues.length, 1);
    }));

  test("a successful commit clears consecutive refusal evidence before the next judgment", () =>
    withTempDir("w1-t5867-reset", async (root) => {
      const f = fixture(root);
      let starts = 0;
      f.run.deps.startShellLessMergeConflictMerge = () =>
        ++starts === 1 ? { started: false, reason: FIRST_REASON } : { started: true };
      f.run.deps.waitForCiGreen = async () => "red";
      f.run.deps.fetchCiFailures = async () => [{ name: "ci", logTail: "tsc: error TS2322" }];
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.equal(outcome.strikes, 2);
      assert.match(outcome.reason, /unchanged red after a worker round/);
      assert.equal(starts, 2);
      assert.equal(f.counts().spawns, 1);
      assert.equal(f.counts().pushes, 1);
      assert.equal(f.issues.length, 1);
    }));

  test("a former one-strike budget permits the judge to continue to a second merge refusal", () =>
    withTempDir("w1-t5867-one-strike", async (root) => {
      const f = fixture(root);
      f.run.strikeCap = 1;
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.match(outcome.reason, /repeated merge refusals/);
      assert.equal(outcome.strikes, 2);
      assert.deepEqual(f.counts(), { starts: 2, spawns: 0, pushes: 0 });
      assert.equal(f.issues.length, 1);
      assert.ok(f.issues[0].body.includes(FIRST_REASON));
    }));

  test("a refusal without a supplied reason is explicitly named in the escalation", () =>
    withTempDir("w1-t5867-no-reason", async (root) => {
      const f = fixture(root);
      let starts = 0;
      f.run.deps.startShellLessMergeConflictMerge = () =>
        ++starts === 1 ? { started: false } : { started: false, reason: SECOND_REASON };
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.match(outcome.reason, /repeated merge refusals/);
      assert.equal(outcome.strikes, 2);
      assert.equal(starts, 2);
      assert.equal(f.issues.length, 1);
      assert.ok(f.issues[0].body.includes("no reason reported"));
      assert.ok(f.issues[0].body.includes(SECOND_REASON));
    }));

  test("the judge can change approach and continue beyond two consecutive merge refusals", () =>
    withTempDir("w1-t7096-merge-progress", async (root) => {
      const f = fixture(root);
      f.run.strikeCap = 1;
      let starts = 0;
      const decisions: number[] = [];
      f.run.deps.startShellLessMergeConflictMerge = () => ++starts <= 3
        ? { started: false, reason: starts % 2 ? FIRST_REASON : SECOND_REASON } : { started: true };
      f.run.deps.fixProgressJudge = async (input) => {
        decisions.push(input.rounds.length);
        assert.equal(input.signals.refusedRounds, starts);
        assert.equal(input.signals.incompleteRounds, 0);
        assert.deepEqual(input.rounds.map((r) => r.refusal),
          Array.from({ length: starts }, (_, i) => i % 2 ? SECOND_REASON : FIRST_REASON));
        assert.deepEqual(input.currentRed, ["conflict:conflict.txt"]);
        assert.equal(input.signals.identicalRedSets, starts);
        return { verdict: "change-approach", approach: "verify fetch before merging", reason: "new evidence permits recovery" };
      };
      const spawn = f.run.deps.spawn;
      f.run.deps.spawn = async (args) => {
        assert.ok(args.prompt.includes("Progress judge approach: verify fetch before merging"));
        return spawn(args);
      };
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "fixed", outcome.reason);
      assert.equal(outcome.strikes, 4);
      assert.deepEqual(decisions, [1, 2, 3]);
      assert.equal(starts, 4);
      assert.deepEqual(f.counts(), { starts: 0, spawns: 1, pushes: 1 });
      assert.equal(f.issues.length, 0);
    }));

  test("an unavailable merge-refusal judgment hands off without a second merge or worker", () =>
    withTempDir("w1-t7096-merge-unavailable", async (root) => {
      const f = fixture(root);
      let judgments = 0;
      f.run.deps.fixProgressJudge = async (input) => {
        judgments++;
        assert.equal(input.rounds.length, 1);
        assert.equal(input.rounds[0].refusal, FIRST_REASON);
        assert.equal(input.rounds[0].completed, true);
        return undefined;
      };
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "handed_off", outcome.reason);
      assert.match(outcome.reason, /absent or unparseable/);
      assert.equal(judgments, 1);
      assert.deepEqual(f.counts(), { starts: 1, spawns: 0, pushes: 0 });
      assert.equal(f.issues.length, 0);
    }));

  test("the retry still stands down when the PR closes after the first refusal", () =>
    withTempDir("w1-t5867-terminal", async (root) => {
      const f = fixture(root);
      let reads = 0;
      f.run.deps.readLiveState = async () => ({ ok: true, state: ++reads === 1 ? "OPEN" : "CLOSED" });
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "stood_down");
      assert.equal(outcome.strikes, 1);
      assert.deepEqual(f.counts(), { starts: 1, spawns: 0, pushes: 0 });
      assert.equal(f.issues.length, 0);
    }));
});
