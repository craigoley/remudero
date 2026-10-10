/**
 * W1-T7445 — a diff-coverage red whose uncovered lines the PR itself added takes a strike, not a
 * base refresh. A refresh merges main's lines, never the PR's, so on a hot file (main changes it
 * every CI cycle) refreshing on that evidence repeats forever and no strike ever runs (#10250,
 * #10441). An uncovered line the PR did NOT add, or unreadable added-line evidence, keeps the
 * W1-T2782 refresh.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import { addedLinesFromPatch, prAddedLinesFromPullFiles } from "../src/lib/sweep.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { decideRedBaseRefresh, redBaseRefreshFactsFromRest, runFixRung } from "../src/run-task.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOT = "src/lib/affected-suites.ts";

function coverageRed(...lines: string[]) {
  return [{
    name: "coverage-ratchet",
    logTail: ["diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests:", ...lines].join("\n"),
  }];
}

function criterion(met: boolean): CriterionVerdict {
  return { claim: "the repair works", proof: "unit test", met, reason: met ? "" : "not yet", proof_exec: "not_executable" };
}

function review(state: "success" | "failure", headSha = "old-head"): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria: [criterion(state === "success")],
    testTheater: false,
    summary: state === "success" ? "passed" : "blocked by CI",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: state,
  };
}

function worker(): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false,
  };
}

async function rung(facts: () => Promise<Record<string, unknown>>, ciFailures: ReturnType<typeof coverageRed>) {
  const events: string[] = [];
  let checked: Record<string, unknown> | undefined;
  const outcome = await runFixRung({
    taskId: "W1-T7445",
    runId: "W1-T7445-1791594431288",
    task: { id: "W1-T7445", title: "diff-coverage red on the PR's own lines takes a strike" },
    prUrl: "https://github.com/acme/remudero/pull/10250",
    branch: "run-W1-T7445-1791594431288",
    worktreePath: REPO_ROOT,
    initialSessionId: "implement-session",
    mount: MOUNT,
    settingsFile: "/tmp/w1-t7445-settings.json",
    config: {} as Config,
    budgetUsd: 5,
    strikeCap: 1,
    initialReview: review("failure"),
    ciFailures,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: REPO_ROOT, reviewerMount: MOUNT },
    deps: {
      spawn: async () => {
        events.push("spawn");
        return worker();
      },
      waitForCiGreen: async () => "green" as const,
      fetchPrBody: async () => "PR body",
      runReview: async () => review("success", "fixed-head"),
      push: () => events.push("push"),
      issues: {} as IssueGateway,
      ledgerPath: "/tmp/w1-t7445-ledger.ndjson",
      log: (step: string, extra?: Record<string, unknown>) => {
        events.push(step);
        if (step === "fix.base_refresh_checked") checked = extra;
      },
      say: () => {},
      account: (result: WorkerResult) => result,
      readRedBaseRefreshFacts: facts,
      updateBranch: async () => {
        events.push("update-branch");
        return { ok: true };
      },
    },
  });
  return { outcome, events, checked };
}

test("W1-T7445: a diff-coverage red on lines the PR added goes to a strike, not a base refresh", async () => {
  // The REST read: pulls/{n}/files is paginated, and each patch's hunk headers give head-side lines.
  const calls: string[][] = [];
  const facts = redBaseRefreshFactsFromRest("acme", "remudero", 10250, (args) => {
    calls.push(args);
    if (calls.length === 1) return { base: { ref: "main" }, head: { sha: "pr-head" } };
    if (calls.length === 2) return { ahead_by: 3, files: [{ filename: HOT }] };
    return [
      [{ filename: HOT, patch: "@@ -409,3 +409,5 @@ export const EDGES = [\n   a,\n   b,\n+  c,\n+  d,\n   e," }],
      [{ filename: "test/affected-suites.test.ts", patch: "@@ -0,0 +1,2 @@\n+one\n+two" }, { filename: "bin.png" }],
    ];
  });
  assert.deepEqual(calls[2], ["api", "--paginate", "--slurp", "repos/acme/remudero/pulls/10250/files?per_page=100"]);
  assert.deepEqual(facts, {
    behindBy: 3,
    baseChangedFiles: [HOT],
    prAddedLines: { [HOT]: [411, 412], "test/affected-suites.test.ts": [1, 2] },
  });

  // The falsifier fixture: behind by 3, base changed the hot file, the only uncovered line is PR-added.
  const red = coverageRed(`  - ${HOT}:412`);
  const decision = decideRedBaseRefresh(red, facts);
  assert.equal(decision.refresh, false);
  assert.deepEqual(decision.matchingBaseFiles, []);
  assert.deepEqual(decision.failingSourceFiles, [HOT]);
  assert.equal(decision.prAddedUncoveredLines, 1);

  // An absolute checkout path is the same PR-added line.
  const absolute = decideRedBaseRefresh(coverageRed(`  - /workspace/remudero/${HOT}:411`), facts);
  assert.equal(absolute.refresh, false);
  assert.equal(absolute.prAddedUncoveredLines, 1);

  // Through the fix rung: no update-branch, a strike is spent, and the ledger row counts the line.
  const { outcome, events, checked } = await rung(async () => facts, red);
  assert.notEqual(outcome.outcome, "base_refreshed");
  assert.equal(outcome.strikes, 1);
  assert.equal(events.includes("update-branch"), false);
  assert.ok(events.includes("spawn"));
  assert.equal(checked?.refresh, false);
  assert.equal(checked?.pr_added_uncovered_lines, 1);
});

test("W1-T7445: an uncovered line outside the PR diff still refreshes, and unreadable added lines keep the refresh", async () => {
  const added = { [HOT]: [411, 412] };
  // A line the PR did not add (merged in from main) can be covered by a refresh.
  const outside = decideRedBaseRefresh(coverageRed(`  - ${HOT}:900`), { behindBy: 3, baseChangedFiles: [HOT], prAddedLines: added });
  assert.equal(outside.refresh, true);
  assert.deepEqual(outside.matchingBaseFiles, [HOT]);
  assert.equal(outside.prAddedUncoveredLines, 0);

  // One non-PR line is enough; the PR-added one is still counted.
  const mixed = decideRedBaseRefresh(coverageRed(`  - ${HOT}:412`, `  - ${HOT}:900`), { behindBy: 3, baseChangedFiles: [HOT], prAddedLines: added });
  assert.equal(mixed.refresh, true);
  assert.equal(mixed.prAddedUncoveredLines, 1);

  // Unreadable evidence — the whole map, or one path with no patch — keeps today's refresh.
  const unreadable = decideRedBaseRefresh(coverageRed(`  - ${HOT}:412`), { behindBy: 3, baseChangedFiles: [HOT] });
  assert.equal(unreadable.refresh, true);
  assert.equal(unreadable.prAddedUncoveredLines, undefined);
  const noPatch = decideRedBaseRefresh(coverageRed(`  - ${HOT}:412`), { behindBy: 3, baseChangedFiles: [HOT], prAddedLines: {} });
  assert.equal(noPatch.refresh, true);
  assert.equal(noPatch.prAddedUncoveredLines, 0);

  // A failed PR-files read leaves prAddedLines absent but keeps the compare facts.
  let n = 0;
  const failedRead = redBaseRefreshFactsFromRest("acme", "remudero", 10441, () => {
    n++;
    if (n === 1) return { base: { ref: "main" }, head: { sha: "pr-head" } };
    if (n === 2) return { ahead_by: 3, files: [{ filename: HOT }] };
    throw new Error("pulls/files unavailable");
  });
  assert.deepEqual(failedRead, { behindBy: 3, baseChangedFiles: [HOT] });
  assert.equal(prAddedLinesFromPullFiles({ message: "Not Found" }), undefined);
  assert.equal(addedLinesFromPatch("Binary files differ"), undefined);

  const { outcome, events, checked } = await rung(async () => failedRead, coverageRed(`  - ${HOT}:412`));
  assert.equal(outcome.outcome, "base_refreshed");
  assert.equal(outcome.strikes, 0);
  assert.ok(events.includes("update-branch"));
  assert.equal(checked?.refresh, true);
  assert.equal("pr_added_uncovered_lines" in (checked ?? {}), false);
});
