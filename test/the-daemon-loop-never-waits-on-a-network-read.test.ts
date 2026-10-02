/**
 * E36 — THE DAEMON LOOP NEVER WAITS ON A NETWORK READ.
 *
 * A live CPU profile of the core daemon (2026-10-02, 10 ms sampling) caught two loop stalls:
 *  1. 13:58:32Z, 49.2 s: `execFileSync` git fetch < fetchOriginRetryingRefLock < checkServiceFreshness
 *     < checkReviewerCodeFreshness — the reviewer-code gate fetched origin synchronously.
 *  2. 14:07:03Z, 144.2 s: `execFileSync` gh < ghJson < the main-health rung — every GitHub read
 *     of the default-branch observer ran synchronously.
 *
 * Each "lets a timer fire" test schedules a timer BEFORE the call, gives the call a network read
 * that settles later, and asserts the timer ran first. A synchronous implementation cannot pass:
 * it holds the loop until its read returns, so the call settles before any timer can run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { IssueGateway } from "../src/lib/escalate.js";
import { fetchOriginRetryingRefLock, fetchOriginRetryingRefLockAsync } from "../src/lib/git-fetch-retry.js";
import { buildMainHealthRung } from "../src/lib/main-health-rung.js";
import {
  checkReviewerCodeFreshness,
  checkReviewerCodeFreshnessAsync,
  checkServiceFreshness,
  checkServiceFreshnessAsync,
  type ServiceFreshness,
} from "../src/lib/self-sync.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildReviewerCodeFreshnessGate } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);

/** Blocks the thread the way `execFileSync` does — used as the SYNC fetch, so a regression that
 *  reaches for it holds the loop exactly as the profiled stall did. */
function holdTheThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function later<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Runs `call` with a timer scheduled first; reports whether that timer fired before `call` settled. */
async function timerFiresBeforeSettle<T>(call: () => Promise<T>): Promise<{ timerFirst: boolean; value: T }> {
  const order: string[] = [];
  const timer = setTimeout(() => order.push("timer"), 5);
  try {
    const value = await call();
    order.push("settled");
    return { timerFirst: order[0] === "timer", value };
  } finally {
    clearTimeout(timer);
  }
}

/** A local-git fake for everything AFTER the fetch, plus a fetch that blocks when called sync. */
function localGit(opts: { head?: string; main?: string; fetchError?: Error } = {}) {
  const calls: string[] = [];
  const git = (args: string[]): string => {
    calls.push(args.join(" "));
    if (args[0] === "fetch") {
      holdTheThread(150);
      if (opts.fetchError) throw opts.fetchError;
      return "";
    }
    if (args.join(" ") === "rev-parse HEAD") return `${opts.head ?? HEAD}\n`;
    if (args.join(" ") === "rev-parse origin/main") return `${opts.main ?? HEAD}\n`;
    if (args[0] === "status") return "";
    if (args[0] === "diff") return "docs/a.md\n";
    if (args[0] === "log") return `\x1e${opts.main ?? HEAD}\x1fdocs: a\n\ndocs/a.md\n`;
    if (args[0] === "merge-base") return `${opts.head ?? HEAD}\n`;
    throw new Error(`unrouted git ${args.join(" ")}`);
  };
  return { git, calls };
}

test("E36: the service freshness read lets a timer fire while git fetch is in flight", async () => {
  const { git } = localGit();
  const { timerFirst, value } = await timerFiresBeforeSettle(() =>
    checkServiceFreshnessAsync("/repo", {}, { ignoreReentrancyGuard: true, git, gitAsync: () => later(60, "") }),
  );
  assert.equal(timerFirst, true, "a timer scheduled before the call must run while the fetch is pending");
  assert.deepEqual(value, { status: "assessed", dirty: false, behind: null });
});

test("E36: the reviewer code freshness read lets a timer fire while git fetch is in flight", async () => {
  const { git } = localGit();
  const { timerFirst, value } = await timerFiresBeforeSettle(() =>
    checkReviewerCodeFreshnessAsync("/repo", {}, {
      checkServiceFreshnessAsync: async () => ({ status: "guarded" }),
      git,
      gitAsync: () => later(60, ""),
    }),
  );
  assert.equal(timerFirst, true, "the guarded reviewer path's fetch must not hold the loop");
  assert.deepEqual(value, { status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" });
});

test("E36: async service freshness reports exactly what the sync read reports", async () => {
  const cases: Array<{ name: string; head?: string; main?: string; fetchError?: Error }> = [
    { name: "up to date" },
    { name: "behind on an immaterial path", main: MAIN },
    { name: "fetch failed", fetchError: new Error("could not read from remote") },
  ];
  for (const c of cases) {
    const sync = checkServiceFreshness("/repo", {}, { ignoreReentrancyGuard: true, git: localGit(c).git });
    const asyncGitFetch = async (): Promise<string> => {
      if (c.fetchError) throw c.fetchError;
      return "";
    };
    const viaAsync = await checkServiceFreshnessAsync("/repo", {}, { ignoreReentrancyGuard: true, git: localGit(c).git, gitAsync: asyncGitFetch });
    assert.deepEqual(viaAsync, sync, c.name);
  }
  assert.deepEqual(await checkServiceFreshnessAsync("/repo", { CI: "true" }), { status: "guarded" }, "CI stays guarded with no fetch");
  assert.deepEqual(await checkServiceFreshnessAsync("/repo", { RMD_SELF_SYNC_DONE: "1" }), { status: "guarded" }, "the re-exec guard still holds");
});

test("E36: async reviewer code freshness reports exactly what the sync read reports", async () => {
  const services: ServiceFreshness[] = [
    { status: "degraded", reason: "git fetch origin failed in /repo: offline" },
    { status: "assessed", dirty: false, behind: { oldSha: HEAD, newSha: MAIN, changedPaths: ["docs/a.md"] } },
    { status: "guarded" },
  ];
  for (const service of services) {
    const { git } = localGit();
    const sync = checkReviewerCodeFreshness("/repo", {}, { checkServiceFreshness: () => service, git });
    const viaAsync = await checkReviewerCodeFreshnessAsync("/repo", {}, {
      checkServiceFreshnessAsync: async () => service,
      git,
      gitAsync: async () => "",
    });
    assert.deepEqual(viaAsync, sync, service.status);
  }
  const failing = new Error("ssh: connect to host github.com port 22: Operation timed out");
  const syncFail = checkReviewerCodeFreshness("/repo", {}, { checkServiceFreshness: () => ({ status: "guarded" }), git: localGit({ fetchError: failing }).git });
  const asyncFail = await checkReviewerCodeFreshnessAsync("/repo", {}, {
    checkServiceFreshnessAsync: async () => ({ status: "guarded" }),
    git: localGit().git,
    gitAsync: async () => {
      throw failing;
    },
  });
  assert.equal(asyncFail.status, "unreadable");
  assert.deepEqual(asyncFail, syncFail, "a failed fetch reads unreadable with the same reason");
  assert.deepEqual(
    await checkReviewerCodeFreshnessAsync("/repo", { CI: "1" }, { checkServiceFreshnessAsync: async () => ({ status: "guarded" }) }),
    checkReviewerCodeFreshness("/repo", { CI: "1" }, { checkServiceFreshness: () => ({ status: "guarded" }) }),
  );
});

test("E36: the async ref-lock retry keeps the sync retry schedule", async () => {
  const lock = Object.assign(new Error("fetch failed"), { stderr: "error: cannot lock ref 'refs/remotes/origin/main'" });
  const syncSleeps: number[] = [];
  let syncCalls = 0;
  fetchOriginRetryingRefLock(() => {
    syncCalls += 1;
    if (syncCalls < 3) throw lock;
    return "";
  }, (ms) => syncSleeps.push(ms));
  const asyncSleeps: number[] = [];
  let asyncCalls = 0;
  await fetchOriginRetryingRefLockAsync(async () => {
    asyncCalls += 1;
    if (asyncCalls < 3) throw lock;
    return "";
  }, async (ms) => {
    asyncSleeps.push(ms);
  });
  assert.deepEqual([asyncCalls, asyncSleeps], [syncCalls, syncSleeps]);
  await assert.rejects(fetchOriginRetryingRefLockAsync(async () => { throw lock; }, async () => {}), /fetch failed/, "three locks exhaust the retries");
  let other = 0;
  await assert.rejects(
    fetchOriginRetryingRefLockAsync(async () => {
      other += 1;
      throw new Error("Permission denied (publickey)");
    }, async () => {}),
    /publickey/,
  );
  assert.equal(other, 1, "a non-lock failure is never retried");
  let timed = 0;
  await fetchOriginRetryingRefLockAsync(async () => {
    timed += 1;
    if (timed < 2) throw lock;
    return "";
  });
  assert.equal(timed, 2, "the default backoff is a timer, and the retry still lands");
});

test("E36: the async freshness reads really shell out to git", async () => {
  const origin = gitRepo({ kind: "e36-upstream" });
  const local = gitRepo({ cloneFrom: origin.dir, kind: "e36-local" });
  origin.git("commit", "--allow-empty", "-m", "docs: advance");
  const viaAsync = await checkServiceFreshnessAsync(local.dir, {}, { ignoreReentrancyGuard: true });
  assert.equal(viaAsync.status, "assessed");
  assert.deepEqual(viaAsync, checkServiceFreshness(local.dir, {}, { ignoreReentrancyGuard: true }));
  const reviewer = await checkReviewerCodeFreshnessAsync(local.dir, {}, { checkServiceFreshnessAsync: async () => ({ status: "guarded" }) });
  assert.equal(reviewer.status, "stale", "an empty diff is unreadable-as-material, so it fails toward refusing");
  assert.deepEqual(reviewer, checkReviewerCodeFreshness(local.dir, {}, { checkServiceFreshness: () => ({ status: "guarded" }) }));
  const noRemote = gitRepo({ kind: "e36-no-remote" });
  const degraded = await checkServiceFreshnessAsync(noRemote.dir, {}, { ignoreReentrancyGuard: true });
  assert.equal(degraded.status, "degraded");
  assert.match((degraded as { reason: string }).reason, /^git fetch origin failed in /);
});

test("E36: the review gate awaits an async freshness read before it spends", async () => {
  const logs: string[] = [];
  let spent = 0;
  const next = async (): Promise<number> => {
    spent += 1;
    return 7;
  };
  const stale = buildReviewerCodeFreshnessGate(
    () => later(20, { status: "stale" as const, codeSha: HEAD, originMainSha: MAIN, changedPaths: ["src/lib/review.ts"] }),
    (step) => logs.push(step),
    next,
  );
  assert.equal(await stale.call("1", [], {}), 0);
  assert.equal(spent, 0, "a stale reading that arrives later still refuses the spend");
  assert.deepEqual(logs, ["review.skipped_stale_reviewer_code"]);
  assert.deepEqual(stale.staleThisPass(), { oldSha: HEAD, newSha: MAIN });
  const fresh = buildReviewerCodeFreshnessGate(
    () => later(20, { status: "fresh" as const, codeSha: HEAD, originMainSha: HEAD, advance: "none" as const }),
    (step) => logs.push(step),
    next,
  );
  assert.equal(await fresh.call("1", [], {}), 7);
  assert.equal(spent, 1);
});

function mainHealthFixture(conclusion: "success" | "failure") {
  const sha = "36".padEnd(40, "0");
  const routes = new Map<string, unknown>([
    ["repos/o/r", { default_branch: "main" }],
    ["repos/o/r/commits/main", { sha }],
    [`repos/o/r/commits/${sha}/check-runs?per_page=100`, { check_runs: [{ name: "ci", status: "completed", conclusion }] }],
    [`repos/o/r/commits/${sha}/status`, { statuses: [] }],
  ]);
  const reads: string[] = [];
  const fetch = (args: string[]): Promise<unknown> => {
    const path = args[1] ?? "";
    reads.push(path);
    if (path.startsWith("repos/o/r/actions/runs?")) return later(10, { workflow_runs: [{ head_sha: sha, conclusion: "failure" }] });
    if (!routes.has(path)) return Promise.reject(new Error(`unrouted gh api path: ${path}`));
    return later(10, routes.get(path));
  };
  const created: string[] = [];
  const issues: IssueGateway = {
    create: (_title, body) => {
      created.push(body);
      return "https://github.com/o/r/issues/1";
    },
    listOpen: () => [],
    comment: () => {},
    closeWithComment: () => {},
  };
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}e36-main-health-`));
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const rung = buildMainHealthRung("o", "r", {
    fetch,
    issues,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "DAEMON-E36",
    log: (step, extra = {}) => logs.push({ step, extra }),
    readRequiredChecks: () => ["ci"],
  });
  return { sha, rung, reads, created, logs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("E36: the main health rung lets a timer fire while its gh reads are in flight", async () => {
  const f = mainHealthFixture("success");
  try {
    const { timerFirst } = await timerFiresBeforeSettle(() => f.rung());
    assert.equal(timerFirst, true, "the rung must yield the loop while GitHub answers");
    assert.equal(f.logs.some((l) => l.step === "main.health.error"), false, JSON.stringify(f.logs));
  } finally {
    f.cleanup();
  }
});

test("E36: the main health rung judges awaited gh reads exactly as it judged sync ones", async () => {
  const green = mainHealthFixture("success");
  try {
    await green.rung();
    const observed = green.logs.find((l) => l.step === "main.health.observed")?.extra;
    assert.equal(observed?.state, "green", JSON.stringify(green.logs));
    assert.equal(observed?.sha, green.sha);
  } finally {
    green.cleanup();
  }
  const red = mainHealthFixture("failure");
  try {
    await red.rung();
    const observed = red.logs.find((l) => l.step === "main.health.observed")?.extra;
    assert.equal(observed?.state, "red", JSON.stringify(red.logs));
    assert.deepEqual(observed?.failing_checks, ["ci"]);
    assert.equal(red.created.length, 1, "a red main still files its issue");
    assert.ok(red.reads.some((path) => path.startsWith("repos/o/r/actions/runs?")), "the run history is read through the awaited fetch");
    assert.equal(red.logs.some((l) => l.step === "main.health.run_history_unreadable"), false, JSON.stringify(red.logs));
  } finally {
    red.cleanup();
  }
});
