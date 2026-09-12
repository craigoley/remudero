import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { gitRepo } from "./helpers/git-repo.js";
import {
  LOCAL_MERGE_CHECK_ROUTES,
  localMergeRouteContractErrors,
  runIsolatedLocalMergeRoute,
} from "../src/lib/ci-parity.js";
import { rollupFromRest } from "../src/lib/open-prs-rest.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type CiFailure, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";

const NOW = Date.parse("2026-09-12T12:00:00Z");
const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const MAIN_REPAIR = { sha: MAIN, committedAt: "2026-09-12T10:00:00.000Z" };
const FAILURE_TIME = "2026-09-12T09:00:00.000Z";

function failure(over: Partial<CiFailure> = {}): CiFailure {
  return {
    name: "comment-load-ratchet",
    logTail: "AssertionError: fixture was stale",
    conclusion: "FAILURE",
    completedAt: FAILURE_TIME,
    ...over,
  };
}

function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3422,
    prUrl: "https://github.com/acme/remudero/pull/3422",
    taskId: "W1-T3422",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    lastActivityAt: "2026-09-01T09:00:00.000Z", // expiring-fixture: exempt -- this test pins NOW and asserts a stale-window decision, never the wall clock; suite passes with the fixture aged past the live threshold
    headSha: HEAD,
    headRefName: "run-W1-T3422-1",
    autoMergeArmed: false,
    ciFailures: [failure()],
    redRequiredChecks: ["comment-load-ratchet"],
    ...over,
  };
}

function greenPeer(): OpenPrView {
  return {
    ...redPr({
      prNumber: 3423,
      prUrl: "https://github.com/acme/remudero/pull/3423",
      checksState: "green",
      priorStrikes: 0,
      headSha: "c".repeat(40),
      ciFailures: undefined,
      redRequiredChecks: undefined,
    }),
  };
}

async function sweep(
  candidate: OpenPrView,
  over: Partial<SweepDeps> = {},
  prior: Record<string, unknown>[] = [],
) {
  const appended: Record<string, unknown>[] = [];
  const released: string[] = [];
  const routed: string[] = [];
  let workflowReads = 0;
  await runSweep(
    [candidate, greenPeer()],
    {
      arm: () => {},
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      postReview: async () => {},
      ledgerPath: "/dev/null/w1-t3422.ndjson",
      runId: "W1-T3422-test",
      readLedger: () => prior,
      appendLine: (_path, line) => appended.push(line),
      now: () => NOW,
      readMainRepair: () => MAIN_REPAIR,
      readLiveState: (pr) => ({ ok: true, state: "OPEN", headSha: pr.headSha }),
      readStaleRedWorkflowRuns: () => {
        workflowReads += 1;
        return [];
      },
      runStaleRedLocalRoute: (target) => {
        routed.push(target.failure.name);
        return { outcome: "passed", detail: "fixture route passed" };
      },
      releaseStaleRed: () => {
        const newHead = "d".repeat(40);
        released.push(newHead);
        return newHead;
      },
      ...over,
    },
    DEFAULT_SWEEP_POLICY,
  );
  return { appended, released, routed, workflowReads };
}

test("W1-T3422: REST rollup preserves terminal check and status timestamps without substituting a start time", () => {
  const rollup = rollupFromRest(
    [{ name: "comment-load-ratchet", status: "completed", conclusion: "failure", started_at: "2026-09-12T08:00:00Z", completed_at: FAILURE_TIME }],
    [{ context: "legacy", state: "failure", created_at: "2026-09-12T08:00:00Z", updated_at: "2026-09-12T09:30:00Z" }],
  );
  assert.equal(rollup[0]?.completedAt, FAILURE_TIME);
  assert.equal(rollup[1]?.completedAt, "2026-09-12T09:30:00Z");
});

test("W1-T3422: only a terminal required failure completed before main is a stale-red candidate", async () => {
  const afterRepair = redPr({ ciFailures: [failure({ completedAt: "2026-09-12T11:00:00.000Z" })] });
  const result = await sweep(afterRepair);
  assert.equal(result.workflowReads, 0, "a start-before/main-after completion must not even pay for a workflow read");
  assert.deepEqual(result.released, []);

  const malformed = await sweep(redPr({ ciFailures: [failure({ completedAt: "not-a-time" })] }));
  assert.equal(malformed.workflowReads, 0, "malformed evidence declines rather than estimating");
  assert.deepEqual(malformed.released, []);
});

test("W1-T3422: a live or unreadable workflow run stands a stale-red candidate down", async () => {
  const live = await sweep(redPr(), {
    readStaleRedWorkflowRuns: () => [{ conclusion: undefined }],
  });
  assert.deepEqual(live.released, []);
  assert.deepEqual(live.routed, []);

  const unreadable = await sweep(redPr(), {
    readStaleRedWorkflowRuns: () => {
      throw new Error("rate limited");
    },
  });
  assert.deepEqual(unreadable.released, []);
  assert.deepEqual(unreadable.routed, []);
});

test("W1-T3422: a passing isolated merge route redrives one candidate once", async () => {
  const first = await sweep(redPr());
  assert.deepEqual(first.routed, ["comment-load-ratchet"]);
  assert.equal(first.released.length, 1);
  const release = first.appended.find((line) => line.step === "sweep.stale_red_redrive.released");
  assert.equal(release?.failed_completed_at, FAILURE_TIME);
  assert.equal(release?.main_sha, MAIN);
  assert.equal(release?.new_head_sha, "d".repeat(40));

  const duplicate = await sweep(redPr(), {}, first.appended);
  assert.deepEqual(duplicate.routed, [], "the exact PR/head/main/check release is durable-deduped");
  assert.deepEqual(duplicate.released, []);
});

test("W1-T3422: an unregistered or failing local route never mints a new head", async () => {
  const unregistered = await sweep(
    redPr({ ciFailures: [failure({ name: "unknown-required-check" })], redRequiredChecks: ["unknown-required-check"] }),
  );
  assert.equal(unregistered.workflowReads, 0, "an unknown check never reaches the live workflow route");
  assert.deepEqual(unregistered.released, []);

  const failed = await sweep(redPr(), {
    runStaleRedLocalRoute: () => ({ outcome: "route-failed", detail: "fixture still fails" }),
  });
  assert.deepEqual(failed.released, []);
  assert.ok(failed.appended.some((line) => line.step === "sweep.stale_red_redrive.local_route" && line.outcome === "route-failed"));
});

test("W1-T3422: the check route is declared against ci.yml and executes in a real isolated merge", () => {
  const repoRoot = join(process.cwd());
  assert.deepEqual(localMergeRouteContractErrors(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")), []);
  const remote = gitRepo({ bare: true, kind: "stale-red-origin" });
  const source = gitRepo({ cloneFrom: remote.dir, kind: "stale-red-source" });
  const savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  const savedSystemConfig = process.env.GIT_CONFIG_SYSTEM;
  try {
    writeFileSync(join(source.dir, "package.json"), JSON.stringify({ private: true, scripts: { "comment-load-signal": "node -e \"process.exit(0)\"" } }));
    writeFileSync(join(source.dir, "README.md"), "base\n");
    source.git("add", ".");
    source.git("commit", "-m", "seed");
    source.git("push", "origin", "main");
    source.git("checkout", "-b", "pr-head");
    writeFileSync(join(source.dir, "pr.txt"), "head\n");
    source.git("add", ".");
    source.git("commit", "-m", "head");
    const head = source.git("rev-parse", "HEAD");
    source.git("push", "origin", "HEAD:refs/pull/1/head");
    source.git("checkout", "main");
    writeFileSync(join(source.dir, "README.md"), "main repair\n");
    source.git("add", ".");
    source.git("commit", "-m", "main repair");
    const main = source.git("rev-parse", "HEAD");
    source.git("push", "origin", "main");
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    const result = runIsolatedLocalMergeRoute(source.dir, { prNumber: 1, headSha: head, mainSha: main, route: LOCAL_MERGE_CHECK_ROUTES[0]! });
    assert.equal(result.outcome, "passed", result.detail);
  } finally {
    if (savedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig;
    if (savedSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = savedSystemConfig;
    source.cleanup();
    remote.cleanup();
  }
});
