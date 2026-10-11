/**
 * test/a-merge-round-holding-main-routes-to-the-real-red.test.ts — #10787 (W1-T6087), 2026-10-11.
 *
 * LIVE: a merge-conflict round merged main and pushed, and CI then ran red on acceptance-author-gate,
 * ci-shard and rule-checks. The rung kept merge-conflict mode, so ten more rounds each asked the harness
 * to "merge origin/main", which was already in the branch. Each was refused, and the progress judge
 * stopped the loop only after that. Checks that run red show GitHub could compute the merge ref: the
 * next round must target that red, and the pre-strike gate re-probes mergeability before it does.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import { MERGE_UP_TO_DATE_REASON, runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { FixProgressInput } from "../src/lib/fix-progress-judge.js";
import { withTempDir } from "../src/lib/tmp.js";
import type { WorkerResult } from "../src/lib/worker.js";

type Run = Parameters<typeof runFixRung>[0];
type Row = { step: string } & Record<string, unknown>;
const MOUNT = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
// The live set also held acceptance-author-gate; its body-repair path reads GitHub, so it is left out here.
const RED = ["ci-shard", "rule-checks"];
const CI_FAILURES = RED.map((name) => ({ name, logTail: `${name}: failed` }));

function review(state: "success" | "failure"): Run["initialReview"] {
  return {
    state, criteria: [{ claim: "the census check reads one scan", proof: "proof", met: state === "success",
      reason: "dirty", proof_exec: "not_executable" }], summary: state, headSha: "branch-head",
    testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    reviewerOutcome: "success",
  };
}

function fixture(root: string) {
  const rows: Row[] = [];
  const judged: FixProgressInput[] = [];
  const counts = { starts: 0, spawns: 0, pushes: 0, mergeFacts: 0 };
  const run: Run = {
    taskId: "W1-T6087X", runId: "W1-T6087X-run",
    task: { id: "W1-T6087X", title: "check the gate admission population", files: ["scripts/test-tier-manifest.json"] },
    prUrl: "https://github.com/acme/remudero/pull/10787", branch: "run-W1-T6087X-1",
    worktreePath: root, initialSessionId: "initial", mount: MOUNT,
    settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 5, initialReview: review("failure"),
    progressDecision: { verdict: "continue", reason: "the sweep admitted this round" },
    mergeConflict: { files: [{ path: "scripts/test-tier-manifest.json", oursDeleted: 2, theirsDeleted: 302 }],
      oursLog: "ours", theirsLog: "theirs" },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      fixProgressJudge: async (input) => {
        judged.push(input);
        return judged.length < 2
          ? { verdict: "continue", reason: "the next round has new evidence" }
          : { verdict: "escalate", loop: "fixture stop", reason: "the fixture ends the rung" };
      },
      spawn: async () => {
        counts.spawns++;
        return {
          sessionId: `fix-${counts.spawns}`, costUsd: 0, numTurns: 1,
          text: "REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(census): repair the round",
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
          tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
          compactionEvents: [], qualitySuspect: false, provider: "claude",
        } satisfies WorkerResult;
      },
      // The first merge starts; any later one finds main already in the branch, as on #10787.
      startShellLessMergeConflictMerge: () => ++counts.starts === 1
        ? { started: true } : { started: false, reason: MERGE_UP_TO_DATE_REASON },
      harnessCommitForShellLessWorker: (input) => { input.onCommit?.(`head-${counts.spawns}`); return 1; },
      worktreeHasUncommittedChanges: () => false,
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => CI_FAILURES,
      readMergeFacts: () => { counts.mergeFacts++; return { mergeable: "MERGEABLE" }; },
      runReview: async () => review("failure"), fetchPrBody: async () => "REPORT",
      push: () => { counts.pushes++; },
      issues: {
        create: () => "https://github.com/acme/remudero/issues/1",
        listOpen: () => [], comment: () => {},
      },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: "W1-T6087X", ...extra }),
      say: () => {}, account: (result) => result,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
    },
  };
  return { run, rows, judged, counts };
}

describe("test/a-merge-round-holding-main-routes-to-the-real-red.test.ts", () => {
  test("a pushed merge round whose checks ran red routes the next round to that red, never another merge", () =>
    withTempDir("pr10787-ci-red", async (root) => {
      const f = fixture(root);
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.equal(f.counts.starts, 1, "the merge is started once; main is never re-merged");
      assert.equal(f.rows.filter((row) => row.step === "fix.merge_start_failed").length, 0);
      assert.deepEqual(f.rows.filter((row) => row.step === "fix.dispatch").map((row) => row.mode),
        ["merge-conflict", "ci-log"]);
      assert.deepEqual(f.judged[0].currentRed, RED, "the judge sees the real red, not the conflict");
      const cleared = f.rows.filter((row) => row.step === "fix.merge_mode_cleared");
      assert.deepEqual(cleared.map((row) => row.site), ["rung.ci_red"]);
      assert.deepEqual(cleared[0].conflicted_files, ["scripts/test-tier-manifest.json"]);
      assert.deepEqual(cleared[0].current_red, RED);
      assert.ok(f.counts.mergeFacts > 0, "the pre-strike gate re-probes mergeability once merge mode ends");
      assert.equal(f.counts.spawns, 2);
    }));

  test("a re-probe that still reads the PR conflicting stands down for the sweep instead of a ci-log worker", () =>
    withTempDir("pr10787-still-dirty", async (root) => {
      const f = fixture(root);
      f.run.deps.readMergeFacts = () => { f.counts.mergeFacts++; return { mergeable: "CONFLICTING" }; };
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "stood_down", outcome.reason);
      assert.match(outcome.reason, /merge state is dirty/);
      assert.equal(f.counts.starts, 1);
      assert.equal(f.counts.spawns, 1, "no ci-log worker is spent on a PR GitHub still reads as conflicting");
      assert.equal(f.counts.mergeFacts, 1);
    }));

  test("a merge that finds main already in the branch routes to the known red with no refused round", () =>
    withTempDir("pr10787-up-to-date", async (root) => {
      const f = fixture(root);
      f.run.ciFailures = CI_FAILURES;
      f.run.deps.startShellLessMergeConflictMerge = () => {
        f.counts.starts++;
        return { started: false, reason: MERGE_UP_TO_DATE_REASON };
      };
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.equal(f.counts.starts, 1, "an up-to-date merge is never retried");
      assert.equal(f.rows.some((row) => String(row.round_id ?? "").includes(":merge-refused:")), false,
        "no refused merge round is recorded");
      assert.equal(f.rows.some((row) => row.step === "fix.commit_refused"), false);
      const dispatches = f.rows.filter((row) => row.step === "fix.dispatch");
      assert.deepEqual(dispatches.map((row) => row.mode), ["ci-log", "ci-log"]);
      assert.equal(dispatches[0].strike, 1, "the up-to-date merge spent no strike");
      assert.deepEqual(f.rows.filter((row) => row.step === "fix.merge_mode_cleared").map((row) => row.site),
        ["rung.merge_up_to_date"]);
      assert.ok(f.counts.mergeFacts > 0, "mergeability is re-probed before the ci-log round");
    }));

  test("control: an up-to-date merge with no known red keeps the refused round for the judge", () =>
    withTempDir("pr10787-no-red", async (root) => {
      const f = fixture(root);
      f.run.deps.startShellLessMergeConflictMerge = () => {
        f.counts.starts++;
        return { started: false, reason: MERGE_UP_TO_DATE_REASON };
      };
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.equal(f.counts.spawns, 0);
      assert.equal(f.rows.filter((row) => row.step === "fix.merge_start_failed").length, 2);
      assert.equal(f.rows.some((row) => row.step === "fix.merge_mode_cleared"), false);
    }));
});
