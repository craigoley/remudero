import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import { conflictRoundProgressVerdict, type FixProgressInput } from "#src/lib/fix-progress-judge.js";
import type { Config } from "#src/lib/config.js";
import { withTempDir } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

type Run = Parameters<typeof runFixRung>[0];
type Row = { step: string } & Record<string, unknown>;
const TASK = "W1-T12541X";
const MOUNT = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
const HEAD = "branch-head";

function review(state: "success" | "failure"): Run["initialReview"] {
  return {
    state, criteria: [{ claim: "the conflict resolves", proof: "proof", met: state === "success",
      reason: "dirty", proof_exec: "not_executable" }], summary: state, headSha: HEAD,
    testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    reviewerOutcome: "success",
  };
}

/** An earlier CI round and an earlier review round on this PR, so the first-round skip (W1-T10039) does not apply. */
const EARLIER: Row[] = [
  { step: "fix.dispatch", task_id: TASK, round_id: "earlier-ci", mode: "ci-log", head_sha: "old-head",
    ci_failures: [{ check: "ci" }] },
  { step: "fix.done", task_id: TASK, round_id: "earlier-ci", head_sha: "old-head", pushed_head_sha: "mid-head",
    fix_outcome: "FIXED", subtype: "success" },
  { step: "fix.dispatch", task_id: TASK, round_id: "earlier-review", mode: "reviewer-unmet", head_sha: "mid-head",
    unmet_claims: ["a claim"] },
  { step: "fix.done", task_id: TASK, round_id: "earlier-review", head_sha: "mid-head", pushed_head_sha: HEAD,
    fix_outcome: "FIXED", subtype: "success" },
];

function fixture(root: string, judge: (input: FixProgressInput) => Promise<unknown>) {
  const rows: Row[] = [];
  const judged: FixProgressInput[] = [];
  const issues: string[] = [];
  let spawns = 0;
  let pushes = 0;
  const run: Run = {
    taskId: TASK, runId: `${TASK}-run`,
    task: { id: TASK, title: "resolve the merge", files: ["conflict.txt"] },
    prUrl: "https://github.com/acme/remudero/pull/12541", branch: `run-${TASK}-1`,
    worktreePath: root, initialSessionId: "initial", mount: MOUNT,
    settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 5, initialReview: review("failure"), baseSha: "base-1",
    mergeConflict: { files: [{ path: "conflict.txt", oursDeleted: 1, theirsDeleted: 1 }],
      oursLog: "ours", theirsLog: "theirs" },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      fixProgressJudge: async (input) => { judged.push(input); return await judge(input) as never; },
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
      startShellLessMergeConflictMerge: () => ({ started: true }),
      harnessCommitForShellLessWorker: (input) => { input.onCommit?.("merged-head"); return 1; },
      worktreeHasUncommittedChanges: () => false,
      waitForCiGreen: async () => "green",
      runReview: async () => review("success"), fetchPrBody: async () => "REPORT",
      push: () => { pushes++; },
      issues: {
        create: (title) => { issues.push(title); return "https://github.com/acme/remudero/issues/1"; },
        listOpen: () => [], comment: () => {},
      },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => [...EARLIER, ...rows],
      log: (step, extra) => rows.push({ step, task_id: TASK, ...extra }),
      say: () => {}, account: (result) => result,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      captureWorktreeSnapshot: () => ({ status: "", diff: "", untrackedHash: "unchanged" }),
    },
  };
  return { run, rows, judged, issues, counts: () => ({ spawns, pushes }) };
}

const progressRows = (rows: Row[]) => rows.filter((row) => row.step === "fix.progress_judged");

/** One merge-conflict round at `head`, with or without a pushed head. */
function conflictRound(id: string, head: string, base: string | undefined, files: string[], pushed?: string): Row[] {
  return [
    { step: "fix.dispatch", task_id: TASK, round_id: id, mode: "merge-conflict", head_sha: head,
      conflicted_files: files, ...(base === undefined ? {} : { base_sha: base }) },
    { step: "fix.done", task_id: TASK, round_id: id, head_sha: head, subtype: pushed ? "success" : "commit_refused",
      ...(pushed ? { pushed_head_sha: pushed } : {}) },
  ];
}

describe("test/fix-lane/a-merge-conflict-round-never-asks-the-ci-progress-judge.test.ts", () => {
  test("W1-T12541 criterion 1: a conflict round after earlier CI and review rounds does not ask the judge and continues", () =>
    withTempDir("w1-t12541-c1", async (root) => {
      const f = fixture(root, async () => ({ verdict: "escalate", loop: "ci loop", reason: "the CI red did not move" }));
      const outcome = await runFixRung(f.run);
      assert.equal(f.judged.length, 0);
      assert.equal(outcome.outcome, "fixed", outcome.reason);
      assert.deepEqual(f.counts(), { spawns: 1, pushes: 1 });
      const judgedRows = progressRows(f.rows);
      assert.ok(judgedRows.length >= 1);
      assert.equal(judgedRows[0].judge_skipped, "conflict-round");
      assert.equal(judgedRows[0].verdict, "continue");
      assert.equal(f.issues.length, 0);
    }));

  test("W1-T12541 criterion 2: no answer, an unparseable answer or an unproven harness answer never hands off a conflict round", async () => {
    const answers: unknown[] = [undefined, { verdict: "maybe" }, { verdict: "harness", reason: "passes off-host" }];
    for (const answer of answers) {
      await withTempDir("w1-t12541-c2", async (root) => {
        const f = fixture(root, async () => answer);
        const outcome = await runFixRung(f.run);
        assert.notEqual(outcome.outcome, "handed_off", `${JSON.stringify(answer)}: ${outcome.reason}`);
        assert.equal(outcome.outcome, "fixed", outcome.reason);
        assert.equal(f.judged.length, 0);
        assert.equal(f.counts().spawns, 1);
      });
    }
  });

  test("W1-T12541 criterion 3: two stuck conflict rounds at one head, base and file set escalate; a new base or file set continues", async () => {
    const files = ["b.ts", "a.ts"];
    const stuck = [...conflictRound("r1", HEAD, "base-1", files), ...conflictRound("r2", HEAD, "base-1", ["a.ts", "b.ts"])];
    const facts = { taskId: TASK, prNumber: 12541, headSha: HEAD, baseSha: "base-1", conflictedFiles: files };
    const escalated = conflictRoundProgressVerdict(facts, stuck);
    assert.equal(escalated.verdict, "escalate");
    assert.equal(escalated.verdict === "escalate" && escalated.loop, "conflict");
    assert.match(escalated.reason, /r1/);
    assert.match(escalated.reason, /r2/);
    assert.equal(conflictRoundProgressVerdict({ ...facts, baseSha: "base-2" }, stuck).verdict, "continue");
    assert.equal(conflictRoundProgressVerdict({ ...facts, conflictedFiles: ["a.ts"] }, stuck).verdict, "continue");
    assert.equal(conflictRoundProgressVerdict({ ...facts, headSha: "new-head" }, [...conflictRound("r1", HEAD, "base-1", files),
      ...conflictRound("r2", HEAD, "base-1", files, "new-head")]).verdict, "continue");
    assert.equal(conflictRoundProgressVerdict(facts, stuck.slice(0, 2)).judge_skipped, "conflict-round");

    await withTempDir("w1-t12541-c3", async (root) => {
      let asked = 0;
      const f = fixture(root, async () => ++asked < 3 ? { verdict: "continue", reason: "keep going" }
        : { verdict: "escalate", loop: "judge loop", reason: "the judge stopped it" });
      f.run.deps.startShellLessMergeConflictMerge = () => ({ started: false, reason: "fetch of origin main failed" });
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "escalated", outcome.reason);
      assert.match(outcome.reason, /fix progress loop: conflict/);
      assert.equal(outcome.strikes, 2);
      assert.equal(f.judged.length, 0);
      assert.deepEqual(f.rows.filter((row) => row.step === "fix.dispatch").map((row) => row.base_sha), ["base-1", "base-1"]);
    });
  });

  test("W1-T12541 criterion 3: a landed push observed by CI timeout prevents an old-head conflict loop", () =>
    withTempDir("w1-t12541-landed-timeout", async (root) => {
      const f = fixture(root, async () => ({ verdict: "escalate", loop: "ci", reason: "should not be asked" }));
      f.run.deps.ledgerLines = () => [...EARLIER, ...conflictRound("prior-refusal", HEAD, "base-1", ["conflict.txt"]), ...f.rows];
      f.run.deps.harnessCommitForShellLessWorker = (input) => { input.onCommit?.("new-head"); return 1; };
      let mergeStarts = 0;
      f.run.deps.startShellLessMergeConflictMerge = () => ++mergeStarts === 2
        ? { started: false, reason: "fetch of origin main failed" } : { started: true };
      let ciReads = 0;
      f.run.deps.waitForCiGreen = async () => ++ciReads === 1
        ? { state: "timeout", sha: "new-head" } : "green";

      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "fixed", outcome.reason);
      assert.equal(mergeStarts, 3, "one refusal follows the landed push, then another round can proceed");
      assert.equal(f.rows.find((row) => row.step === "fix.done" && row.pushed_head_sha === "new-head")?.head_sha, HEAD);
      assert.equal(f.judged.length, 0);
      assert.equal(progressRows(f.rows).filter((row) => row.head_sha === "new-head" && row.verdict === "continue").length, 2);
      assert.equal(progressRows(f.rows).some((row) => row.verdict === "escalate"), false);
    }));

  test("W1-T12541 criterion 4: a round outside merge-conflict mode asks the judge as before, and its unavailable verdict hands off", () =>
    withTempDir("w1-t12541-c4", async (root) => {
      const f = fixture(root, async () => undefined);
      f.run.mergeConflict = undefined;
      f.run.ciFailures = [{ name: "ci", logTail: "tsc: error TS2322" }];
      f.run.deps.waitForCiGreen = async () => "red";
      f.run.deps.fetchCiFailures = async () => [{ name: "ci", logTail: "tsc: error TS2322" }];
      f.run.deps.runReview = async () => review("failure");
      const outcome = await runFixRung(f.run);
      assert.equal(outcome.outcome, "handed_off", outcome.reason);
      assert.match(outcome.reason, /absent or unparseable/);
      assert.equal(f.judged.length, 1);
      assert.ok(f.judged[0].rounds.length >= 2);
      assert.equal(progressRows(f.rows).some((row) => row.judge_skipped === "conflict-round"), false);
      assert.equal(f.counts().spawns, 0);
    }));
});
