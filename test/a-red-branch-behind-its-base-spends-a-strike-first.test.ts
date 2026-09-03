/**
 * W1-T2671 — a blocked_ci PR whose failing test changed on the base refreshes before spending.
 *
 * The positive case is deliberately paired with two controls: a current branch and a behind
 * branch whose failing file is absent from the base gap. The final integration case proves a
 * refresh that stays red reaches the ordinary strike after the local checkout is fast-forwarded
 * to GitHub's merge commit; the refresh itself never masquerades as a fix.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";
import {
  decideRedBaseRefresh,
  failingTestFilesFromCiFailures,
  fixRungTerminationVerdict,
  ghUpdateBranchArgv,
  redBaseRefreshFactsFromRest,
  runFixRung,
} from "../src/run-task.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
    sessionId: "fix-session",
    costUsd: 0,
    numTurns: 1,
    text: "fixed",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

function baseOpts() {
  return {
    taskId: "W1-T2671",
    runId: "W1-T2671-1788451800000",
    task: { id: "W1-T2671", title: "refresh stale red branches" },
    prUrl: "https://github.com/acme/remudero/pull/2671",
    branch: "run-W1-T2671-1788451800000",
    worktreePath: REPO_ROOT,
    initialSessionId: "implement-session",
    mount: MOUNT,
    settingsFile: "/tmp/w1-t2671-settings.json",
    config: {} as Config,
    budgetUsd: 5,
    strikeCap: 1,
    initialReview: review("failure"),
    ciFailures: [
      {
        name: "ci",
        logTail: "not ok 7 - buildSweepHook builds once\n    at TestContext.<anonymous> (file:///workspace/remudero/test/sweep-gateway-warm.test.ts:88:3)",
      },
    ],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: REPO_ROOT, reviewerMount: MOUNT },
  };
}

function deps(events: string[], waits: Array<"green" | "red" | "timeout">) {
  return {
    spawn: async () => {
      events.push("spawn");
      return worker();
    },
    waitForCiGreen: async () => {
      events.push("wait");
      return waits.shift() ?? "green";
    },
    runReview: async () => review("success", "fixed-head"),
    push: () => events.push("push"),
    issues: {} as IssueGateway,
    ledgerPath: "/tmp/w1-t2671-ledger.ndjson",
    log: (step: string) => events.push(step),
    say: () => {},
    account: (result: WorkerResult) => result,
  };
}

test("W1-T2671: the reversed compare maps the base-only gap and exact failing test path to a refresh decision", () => {
  const calls: string[][] = [];
  const facts = redBaseRefreshFactsFromRest("acme", "remudero", 2671, (args) => {
    calls.push(args);
    return calls.length === 1
      ? { base: { ref: "main" }, head: { sha: "branch-head" } }
      : { ahead_by: 7, files: [{ filename: "src/run-task.ts" }, { filename: "test/sweep-gateway-warm.test.ts" }] };
  });

  assert.deepEqual(calls, [
    ["api", "repos/acme/remudero/pulls/2671"],
    ["api", "repos/acme/remudero/compare/branch-head...main"],
  ]);
  assert.deepEqual(facts, {
    behindBy: 7,
    baseChangedFiles: ["src/run-task.ts", "test/sweep-gateway-warm.test.ts"],
  });
  assert.deepEqual(
    decideRedBaseRefresh(baseOpts().ciFailures, facts),
    {
      refresh: true,
      behindBy: 7,
      failingTestFiles: ["/workspace/remudero/test/sweep-gateway-warm.test.ts"],
      matchingBaseFiles: ["test/sweep-gateway-warm.test.ts"],
    },
  );
});

test("W1-T2671: CI test-path extraction preserves supported roots without treating delimiter noise as path segments", () => {
  const noise = "!/".repeat(10_000);
  assert.deepEqual(
    failingTestFilesFromCiFailures([
      {
        name: `ci ${noise} test/name.test.ts`,
        logTail: [
          "at file:///workspace/remudero/test/posix.test.ts:4:2",
          "at C:\\workspace\\remudero\\tests\\windows.spec.ts:7:1",
          "not a test path: src/test-helper.ts",
        ].join("\n"),
      },
    ]),
    ["test/name.test.ts", "/workspace/remudero/test/posix.test.ts", "C:/workspace/remudero/tests/windows.spec.ts"],
  );
});

test("W1-T2671: malformed or failed REST evidence is unavailable, never a fabricated zero-gap", () => {
  assert.deepEqual(
    redBaseRefreshFactsFromRest("acme", "remudero", 2671, () => ({ base: {}, head: {} })),
    {},
  );
  assert.deepEqual(
    redBaseRefreshFactsFromRest("acme", "remudero", 2671, () => {
      throw new Error("core quota unavailable");
    }),
    {},
  );
  let calls = 0;
  assert.deepEqual(
    redBaseRefreshFactsFromRest("acme", "remudero", 2671, () => {
      calls++;
      return calls === 1
        ? { base: { ref: "main" }, head: { sha: "head" } }
        : { ahead_by: "7", files: "not-an-array" };
    }),
    { behindBy: undefined, baseChangedFiles: undefined },
  );
});

test("W1-T2671: behind plus a failing test changed in the gap refreshes before any strike", async () => {
  const events: string[] = [];
  const outcome = await runFixRung({
    ...baseOpts(),
    deps: {
      ...deps(events, ["green"]),
      readRedBaseRefreshFacts: async () => ({
        behindBy: 5,
        baseChangedFiles: ["test/sweep-gateway-warm.test.ts"],
      }),
      updateBranch: async () => {
        events.push("update-branch");
        return { ok: true };
      },
    },
  });

  assert.equal(outcome.outcome, "base_refreshed");
  assert.equal(outcome.strikes, 0);
  assert.deepEqual(events.filter((e) => ["update-branch", "wait", "spawn"].includes(e)), ["update-branch"]);
  assert.ok(events.includes("fix.base_refreshed"));
  assert.ok(!events.includes("fix.dispatch"));
  assert.deepEqual(
    fixRungTerminationVerdict(outcome),
    {
      reason: outcome.reason,
      extra: {},
      phrase: "base refreshed without spending a strike",
    },
  );
});

test("W1-T2671: a current red branch goes straight to the ordinary fix strike", async () => {
  const events: string[] = [];
  const outcome = await runFixRung({
    ...baseOpts(),
    deps: {
      ...deps(events, ["green"]),
      readRedBaseRefreshFacts: async () => ({ behindBy: 0, baseChangedFiles: ["test/sweep-gateway-warm.test.ts"] }),
      updateBranch: async () => {
        events.push("update-branch");
        return { ok: true };
      },
    },
  });

  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);
  assert.equal(events.includes("update-branch"), false);
  assert.ok(events.indexOf("spawn") < events.indexOf("fix.dispatch"));
});

test("W1-T2671: an unrelated base gap still goes straight to the ordinary fix strike", async () => {
  const events: string[] = [];
  const outcome = await runFixRung({
    ...baseOpts(),
    deps: {
      ...deps(events, ["green"]),
      readRedBaseRefreshFacts: async () => ({ behindBy: 9, baseChangedFiles: ["test/unrelated.test.ts"] }),
      updateBranch: async () => {
        events.push("update-branch");
        return { ok: true };
      },
    },
  });

  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);
  assert.equal(events.includes("update-branch"), false);
  assert.ok(events.includes("spawn"));
});

test("W1-T2671: an unreadable comparison or failed merge request preserves the ordinary fix path", async () => {
  for (const failure of ["read", "write"] as const) {
    const events: string[] = [];
    const outcome = await runFixRung({
      ...baseOpts(),
      deps: {
        ...deps(events, ["green"]),
        readRedBaseRefreshFacts: async () => {
          if (failure === "read") throw new Error("compare failed");
          return { behindBy: 4, baseChangedFiles: ["test/sweep-gateway-warm.test.ts"] };
        },
        updateBranch: async () => {
          events.push("update-branch");
          return { ok: false, error: "merge refused" };
        },
      },
    });

    assert.equal(outcome.outcome, "fixed", `${failure}: the ordinary strike still resolves the PR`);
    assert.equal(outcome.strikes, 1);
    assert.ok(events.includes(failure === "read" ? "fix.base_refresh_read_error" : "fix.base_refresh_failed"));
    assert.ok(events.includes("spawn"));
  }
});

test("W1-T2671: refresh uses GitHub's merge endpoint, never rebase", () => {
  assert.deepEqual(ghUpdateBranchArgv("acme", "remudero", 2671), [
    "api",
    "--method",
    "PUT",
    "repos/acme/remudero/pulls/2671/update-branch",
  ]);

  assert.equal(ghUpdateBranchArgv("acme", "remudero", 2671).includes("rebase"), false);
});

test("W1-T2671: a refresh that remains red falls through to a real strike on the next fresh sweep", async () => {
  const events: string[] = [];
  const first = await runFixRung({
    ...baseOpts(),
    deps: {
      ...deps(events, ["green"]),
      readRedBaseRefreshFacts: async () => ({
        behindBy: 13,
        baseChangedFiles: ["test/sweep-gateway-warm.test.ts"],
      }),
      updateBranch: async () => {
        events.push("update-branch");
        return { ok: true };
      },
    },
  });

  assert.equal(first.outcome, "base_refreshed");
  assert.equal(first.strikes, 0);
  assert.deepEqual(events.filter((e) => ["update-branch", "wait", "spawn"].includes(e)), ["update-branch"]);

  // GitHub's update-branch response is asynchronous. The next sweep reconstructs a NEW worktree
  // at the merged head. If CI stayed red, the reversed compare is now level and the ordinary
  // fix rung runs; the base refresh was not credited as a fix or a strike.
  const second = await runFixRung({
    ...baseOpts(),
    initialReview: review("failure", "merged-head"),
    deps: {
      ...deps(events, ["green"]),
      readRedBaseRefreshFacts: async () => ({ behindBy: 0, baseChangedFiles: [] }),
      updateBranch: async () => {
        events.push("update-branch");
        return { ok: true };
      },
    },
  });

  assert.equal(second.outcome, "fixed");
  assert.equal(second.strikes, 1);
  assert.deepEqual(events.filter((e) => ["update-branch", "spawn", "wait"].includes(e)), [
    "update-branch",
    "spawn",
    "wait",
  ]);
  assert.ok(events.includes("fix.dispatch"));
});
