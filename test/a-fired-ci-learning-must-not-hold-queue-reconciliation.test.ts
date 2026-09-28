/**
 * W1-T3997 — CI learning must improve the fleet without becoming its serial bottleneck.
 *
 * The corpus reader observes a whole recent PR window. Before this repair the daemon awaited that
 * reader between its cadence checks and the ordinary sweep/dispatch work, so a healthy daemon
 * could keep heartbeating while reviews and builds stopped. These tests use a promise that cannot
 * settle until the assertion has proved the rest of the tick proceeded.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon } from "../src/lib/daemon.js";
import { collectCiFailureCorpus } from "../src/lib/ci-failure-corpus.js";
import { measureGateFireRates } from "../src/lib/gate-fire-rate.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { drainDetachedSweepActions, detachedActionInFlight } from "../src/lib/sweep.js";
import {
  loadCiFailureWindowAsync,
  buildCiLearningCadenceRunner,
  buildCiLearningDaemonHooks,
  type RunResult,
} from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3997-`));
  const path = join(directory, "tasks.yaml");
  writeFileSync(path, YAML);
  return loadPlan(path);
}

function result(id: string): RunResult {
  return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
}

function emptyCadenceResult() {
  return {
    status: "clear" as const,
    draftCount: 0,
    excludedCount: 0,
    unreadableCount: 0,
    filedCount: 0,
    skippedCount: 0,
    refusedCount: 0,
    lessonRecurrences: { status: "unreadable" as const },
  };
}

test("W1-T3997: a fired ci-learning action does not hold queue reconciliation", { timeout: 1_000 }, async () => {
  assert.equal(detachedActionInFlight("ci-learning"), false, "precondition: another test leaked no CI-learning action");
  const plan = fixturePlan();
  const lines: string[] = [];
  const merged = new Set<string>();
  let sweepCount = 0;
  let releaseCorpus: () => void = () => {};
  const corpusBlocked = new Promise<void>((resolve) => { releaseCorpus = resolve; });

  const summary = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => { merged.add(id); return result(id); },
    sleep: async () => {},
    sweep: async () => { sweepCount += 1; },
    log: (step) => lines.push(step),
    checkCiLearningCadence: () => ({ fire: true, reason: "due" }),
    runCiLearningCadence: async () => { await corpusBlocked; return emptyCadenceResult(); },
  }, { max: 1 });

  assert.ok(lines.includes("ci_learning_cadence.fired"), "control: the learning cadence really fired");
  assert.ok(lines.includes("ci_learning_cadence.detached"), "the fired corpus is detached rather than awaited inline");
  assert.ok(sweepCount > 0, "THE CLAIM: reconciliation still runs while the corpus is pending");
  assert.deepEqual(summary.attempted, ["A"], "and dispatch still reaches the runnable task before the corpus settles");
  assert.equal(detachedActionInFlight("ci-learning"), true, "control: the assertion ran while learning was in flight");

  releaseCorpus();
  await drainDetachedSweepActions({ boundMs: 5_000 });
});

test("W1-T3997: a second fired ci-learning action is refused while the first is detached", async () => {
  assert.equal(detachedActionInFlight("ci-learning"), false, "precondition: the prior action settled");
  const plan = fixturePlan();
  const lines: string[] = [];
  let releaseCorpus: () => void = () => {};
  const corpusBlocked = new Promise<void>((resolve) => { releaseCorpus = resolve; });
  let started = 0;
  let checks = 0;

  await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id) => result(id),
    sleep: async () => {},
    log: (step) => lines.push(step),
    checkCiLearningCadence: () => ({ fire: true, reason: "still due" }),
    runCiLearningCadence: async () => { started += 1; await corpusBlocked; return emptyCadenceResult(); },
    checkStop: () => (++checks >= 4 ? "test complete" : undefined),
  });

  assert.equal(started, 1, "only one corpus action may hold the cadence marker at once");
  assert.ok(
    lines.includes("ci_learning_cadence.already_detached"),
    "the duplicate fire is an explicit in-flight refusal, never a silent skip",
  );

  releaseCorpus();
  await drainDetachedSweepActions({ boundMs: 5_000 });
  assert.equal(detachedActionInFlight("ci-learning"), false, "the registry releases after the corpus settles");
});

test("W1-T3997: an unreadable detached ci-learning corpus preserves the daily allowance", async () => {
  assert.equal(detachedActionInFlight("ci-learning"), false, "precondition: no prior detached corpus remains");
  const fires: string[] = [];
  const attempts: string[] = [];
  const lines: string[] = [];
  const runCiLearningCadence = buildCiLearningCadenceRunner({
    root: "/tmp/w1t3997-state",
    checkoutRoot: "/tmp/w1t3997-checkout",
    loadWindow: async () => { throw new Error("GitHub corpus unreadable"); },
    recordFire: () => fires.push("fired"),
    recordAttempt: () => attempts.push("attempted"),
  });

  await runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => result(id),
    sleep: async () => {},
    log: (step) => lines.push(step),
    checkCiLearningCadence: () => ({ fire: true, reason: "due" }),
    runCiLearningCadence,
  }, { max: 1 });
  await drainDetachedSweepActions({ boundMs: 5_000 });

  assert.deepEqual(attempts, ["attempted"], "a failed read still gets a bounded retry marker");
  assert.deepEqual(fires, [], "unreadable input never spends the successful daily allowance");
  assert.ok(lines.includes("ci_learning_cadence.run_failed"), "the failed detached run is ledger-visible");
  assert.equal(lines.includes("ci_learning_cadence.ran"), false, "missing evidence never emits a successful lesson result");
});

test("W1-T3997: a runner that throws before returning a promise remains a visible best-effort failure", async () => {
  const lines: string[] = [];
  const summary = await runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => result(id),
    sleep: async () => {},
    log: (step) => lines.push(step),
    checkCiLearningCadence: () => ({ fire: true, reason: "due" }),
    runCiLearningCadence: (() => { throw new Error("legacy runner failed synchronously"); }) as never,
  }, { max: 1 });

  assert.deepEqual(summary.attempted, ["A"], "a cadence fault cannot stop the ordinary dispatch path");
  assert.ok(lines.includes("ci_learning_cadence.run_failed"), "the synchronous fault remains ledger-visible");
  assert.equal(lines.includes("ci_learning_cadence.detached"), false, "a runner that never returned a promise is not registered");
});

test("W1-T3997: asynchronous CI-learning collection yields between unreadable and readable observations", async () => {
  const calls: string[] = [];
  let yields = 0;
  const corpus = await loadCiFailureWindowAsync(1, {
    read: async (args) => {
      const request = args[1] ?? "";
      calls.push(request);
      if (request.includes("pulls?state=all")) {
        return [
          {},
          { number: 11, updated_at: "2000-01-01T00:00:00.000Z" },
          { number: 12, updated_at: "2999-01-01T00:00:00.000Z" },
          { number: 13, updated_at: "2999-01-01T00:00:00.000Z" },
          { number: 14, updated_at: "2999-01-01T00:00:00.000Z" },
        ];
      }
      if (request.includes("pulls/12/commits")) throw new Error("commit list unavailable");
      if (request.includes("pulls/13/commits")) return [{ sha: "head13" }];
      if (request.includes("pulls/14/commits")) return [{ sha: "head14" }];
      if (request.includes("check-runs") && request.includes("head13")) throw new Error("rollup unavailable");
      if (request.includes("commits/head13")) throw new Error("changed files unavailable");
      if (request.includes("commits/head14")) return { files: [{ filename: "src/lib/learn.ts" }] };
      if (request.includes("statuses/head14")) return { statuses: [] };
      if (request.includes("check-runs")) return { check_runs: [] };
      throw new Error(`unexpected request ${request}`);
    },
    yieldBetweenObservation: async () => { yields += 1; },
  });

  assert.deepEqual(corpus, {
    prs: [
      // W1-T4115: the window also says whether each pull request merged (none of these carry merged_at).
      { number: 13, merged: false, commits: [{ sha: "head13" }] },
      { number: 14, merged: false, commits: [{ sha: "head14", rollup: [] }] },
    ],
    unreadablePrs: [12],
  });
  assert.equal(yields, 5, "the reader yields once per eligible PR and once per observed commit");
  assert.ok(calls.some((request) => request.includes("pulls/12/commits")), "control: the unreadable PR branch executed");
  assert.ok(calls.some((request) => request.includes("check-runs")), "control: the unreadable rollup branch executed");
  assert.equal(calls.some((request) => request.endsWith("/commits/head14")), false, "no repair pair means no commit-detail read");
});

test("CI learning reads commit files only for a proven red-to-green repair", async () => {
  const calls: string[] = [];
  const window = await loadCiFailureWindowAsync(1, {
    read: async (args) => {
      const request = args[1] ?? "";
      calls.push(request);
      if (request.includes("pulls?state=all")) return [{ number: 41, updated_at: "2999-01-01T00:00:00Z" }];
      if (request.includes("pulls/41/commits")) return [{ sha: "red" }, { sha: "green" }];
      if (request.includes("check-runs")) return { check_runs: [{ name: "ci", status: "completed", conclusion: request.includes("red") ? "failure" : "success" }] };
      if (request.endsWith("/status")) return { statuses: [] };
      if (request.endsWith("/commits/green")) return { files: [{ filename: "src/fix.ts" }] };
      throw new Error(`unexpected request: ${request}`);
    },
    yieldBetweenObservation: async () => {},
  });
  assert.equal(calls.filter((call) => call.endsWith("/commits/green")).length, 1);
  assert.equal(calls.some((call) => call.endsWith("/commits/red")), false);
  assert.deepEqual(collectCiFailureCorpus(window).pairs.map((pair) => [pair.state, pair.repairFiles]), [["repaired", ["src/fix.ts"]]]);
});

test("a saturated first PR page is explicitly partial, never a clean three-day census", async () => {
  let pages = 0;
  const window = await loadCiFailureWindowAsync(3, {
    read: async () => { pages += 1; return Array.from({ length: 100 }, () => ({ updated_at: "2999-01-01T00:00:00Z" })); },
    yieldBetweenObservation: async () => {},
  });
  assert.equal(pages, 5, "the page budget is explicit and bounded");
  assert.equal(window.windowComplete, false);
  assert.equal(collectCiFailureCorpus(window).status, "unreadable");
  assert.equal(measureGateFireRates(window).status, "partial");
});

test("CI learning paginates until the requested time boundary is actually observed", async () => {
  const pages: string[] = [];
  const window = await loadCiFailureWindowAsync(3, {
    read: async (args) => {
      pages.push(args[1] ?? "");
      return args[1]?.endsWith("&page=1")
        ? Array.from({ length: 100 }, () => ({ updated_at: "2999-01-01T00:00:00Z" }))
        : [{ updated_at: "2000-01-01T00:00:00Z" }];
    },
    yieldBetweenObservation: async () => {},
  });
  assert.equal(pages.length, 2);
  assert.equal(window.windowComplete, undefined, "a proven complete window carries no partial marker");
  assert.equal(collectCiFailureCorpus(window).status, "clear");
});

test("the first PR listing retries once after reauthentication and names a repeated failure", async () => {
  let calls = 0;
  let refreshes = 0;
  const reader = {
    read: async () => { calls += 1; throw Object.assign(new Error("Command failed: gh api"), { stderr: "Bad credentials (HTTP 401)", code: 1 }); },
    refreshAuth: async () => { refreshes += 1; },
    yieldBetweenObservation: async () => {},
  };
  await assert.rejects(loadCiFailureWindowAsync(1, reader), /first authentication .* second authentication/);
  assert.equal(calls, 2, "one initial read plus one retry, never an unbounded loop");
  assert.equal(refreshes, 1);
});

test("a repeated PR-list failure names rate limit, timeout, and response-buffer causes", async () => {
  for (const [detail, reason] of [
    ["API rate limit exceeded (HTTP 403)", "rate-limit"],
    ["request timed out (ETIMEDOUT)", "timeout"],
    ["stdout maxBuffer exceeded (ENOBUFS)", "response-buffer"],
  ] as const) {
    let reads = 0;
    await assert.rejects(
      loadCiFailureWindowAsync(1, {
        read: async () => { reads++; throw Object.assign(new Error("gh api failed"), { stderr: detail }); },
        yieldBetweenObservation: async () => {},
      }),
      new RegExp(`first ${reason} .* second ${reason}`),
    );
    assert.equal(reads, 2, `${reason}: one retry and a named refusal`);
  }
});

test("W1-T3997: the daemon's own production wiring reaches the real async reader, not just a test double", async () => {
  // Every OTHER test above drives buildCiLearningCadenceRunner directly, or supplies its own
  // loadWindow to buildCiLearningDaemonHooks — neither exercises the wiring's own fallback
  // (buildCiLearningDaemonHooks with no injected loadWindow), which is what production runs.
  // Injecting only the transport (readJson, the same seam shape PollDeps.readJson already takes)
  // reaches that real fallback with zero network, rather than standing in for it entirely.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3997-wiring-`));
  try {
    const requests: string[] = [];
    const hooks = buildCiLearningDaemonHooks({
      config: { root } as Config,
      checkoutRoot: root,
      planOrigins: [],
      readJson: async (args) => {
        requests.push(args.join(" "));
        return [];
      },
    });
    const result = await hooks.runCiLearningCadence();

    assert.equal(result.draftCount, 0, "an empty real-reader window drafts nothing");
    assert.ok(
      requests.some((request) => request.includes("pulls?state=all")),
      "the production wiring's own fallback reached the injected transport, never a stand-in loadWindow",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI-learning daemon wiring uses one GraphQL commit read instead of per-commit REST rollups", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ci-graphql-wiring-`));
  try {
    const rest: string[] = [];
    const graphql: string[] = [];
    const hooks = buildCiLearningDaemonHooks({
      config: { root } as Config,
      checkoutRoot: root,
      planOrigins: [],
      readJson: async (args) => {
        rest.push(args[1] ?? "");
        if (args[1]?.includes("pulls?state=all")) return [{ number: 42, updated_at: "2999-01-01T00:00:00Z" }];
        throw new Error("per-commit REST read was not expected");
      },
      readGraphql: async (args) => {
        graphql.push(args.join(" "));
        return { data: { repository: { pullRequest: { commits: {
          nodes: [{ commit: { oid: "head", statusCheckRollup: null } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } } };
      },
    });
    const result = await hooks.runCiLearningCadence();
    assert.equal(result.status, "clear");
    assert.equal(graphql.length, 1);
    assert.equal(rest.filter((request) => request.includes("pulls/42/commits") || request.includes("check-runs")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI learning retries after a PR-level authentication failure instead of recording a partial success", async () => {
  await assert.rejects(loadCiFailureWindowAsync(1, {
    read: async (args) => args[1]?.includes("pulls?state=all")
      ? [{ number: 42, updated_at: "2999-01-01T00:00:00Z" }]
      : [],
    readPr: async () => { throw Object.assign(new Error("HTTP 401 Bad credentials"), { code: 1 }); },
    yieldBetweenObservation: async () => {},
  }), /HTTP 401/);
});
