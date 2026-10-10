import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { captureWorktreeSnapshotViaGit, runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const worker: WorkerResult = {
  sessionId: "fixture", costUsd: 0, numTurns: 0, text: "", blocks: [], stderr: "", subtype: "success",
  isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "fixture",
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
};
const verdict = (state: "success" | "failure", headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } => ({
  state, headSha, reviewerOutcome: "success", criteria: [], testTheater: false, summary: "fixture",
  floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
});

for (const scenario of [
  { title: "a settled green repair dispatches no worker on a real Git tree", settled: true, nextCheck: "check-a", expected: 0 },
  { title: "the same failed gate spends one no-op attempt on a real Git tree", settled: false, nextCheck: "check-a", expected: 1 },
  { title: "a newly attributable failed gate dispatches again on the unchanged real Git tree", settled: false, nextCheck: "check-b", expected: 2 },
]) {
  test(scenario.title, async () => {
    const repo = gitRepo({ kind: "real-git-fix-noop" });
    try {
      writeFileSync(join(repo.dir, "feature.ts"), "export const value = 1;\n");
      repo.git("add", "feature.ts"); repo.git("commit", "-q", "-m", "seed feature");
      const head = repo.git("rev-parse", "HEAD");
      const review = verdict(scenario.settled ? "success" : "failure", head);
      const snapshots: ReturnType<typeof captureWorktreeSnapshotViaGit>[] = [];
      let dispatches = 0;
      const outcome = await runFixRung({
        taskId: "T-REAL-GIT-NOOP", runId: "T-REAL-GIT-NOOP-1", task: { id: "T-REAL-GIT-NOOP", title: "fixture repair" },
        prUrl: "https://github.com/fixture/repo/pull/1", branch: "run-T-REAL-GIT-NOOP-1", worktreePath: repo.dir,
        initialSessionId: "fixture", mount: { model: "fixture", effort: "medium", maxTurns: 2, contextBudget: 1_000 },
        settingsFile: join(repo.dir, "settings.json"), config: {} as Config, budgetUsd: 0, strikeCap: 2,
        reviewBase: { owner: "fixture", repo: "repo", headCheckoutDir: repo.dir, reviewerMount: { model: "fixture", effort: "medium", maxTurns: 2, contextBudget: 1_000 } },
        initialReview: review, ...(scenario.settled ? {} : { ciFailures: [{ name: "check-a", logTail: "fixture attributable failure" }] }),
        deps: {
          spawn: async () => { dispatches++; return worker; },
          waitForCiGreen: async () => "red", fetchCiFailures: async () => [{ name: scenario.nextCheck, logTail: "fixture attributable failure" }],
          runReview: async () => review, push: () => {},
          issues: { create: () => "https://github.com/fixture/repo/issues/1", listOpen: () => [] },
          ledgerPath: join(repo.dir, ".git/fixture-ledger.ndjson"), log: () => {}, say: () => {}, account: r => r,
          readLiveState: async () => ({ ok: true, state: "OPEN" }),
          captureWorktreeSnapshot: async path => { const snapshot = captureWorktreeSnapshotViaGit(path); snapshots.push(snapshot); return snapshot; },
        },
      });
      assert.equal(dispatches, scenario.expected);
      assert.equal(outcome.strikes, scenario.expected);
      assert.equal(repo.git("rev-parse", "HEAD"), head, "none of the controlled no-op workers fabricates a commit");
      assert.ok(snapshots.every(snapshot => snapshot !== undefined), "each requested Git capture was actually readable");
      if (scenario.expected === 1) {
        assert.equal(outcome.outcome, "stood_down");
        assert.match(outcome.standDownReason ?? "", /byte-identical/);
        assert.deepEqual(snapshots[0], snapshots[1], "stand-down is grounded in unchanged Git bytes");
      }
    } finally { repo.cleanup(); }
  });
}
