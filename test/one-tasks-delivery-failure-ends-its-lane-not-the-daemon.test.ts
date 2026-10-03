// test/one-tasks-delivery-failure-ends-its-lane-not-the-daemon.test.ts — W1-T5344.
//
// THE DEFECT: the dispatch settle loop in `runDaemon` sent every rejection it did not positively
// recognise to `fatalError`, so one task's DELIVERY failure — a pre-push hook refusal, a PR-create
// 422, a commit-hook refusal (all `Command failed: ` from a spawned command), or
// `openPullRequestChecked`'s merge-base proof refusal (a `PrOpenRefusedError`, no `Command failed:`
// prefix at all) — ended the whole process. MEASURED 2026-09-25..10-02: 47 exit-76 boots and 6
// exit-1 crashes, and because the next boot re-dispatched the same task at once, W1-T3116 and
// W1-T4627 each ended the daemon four times in a row.
//
// THE FIX: a delivery-failure arm, after the transient / spawn-infra / gh-read arms and before
// `fatalError`. It logs `daemon.lane_failed`, ends that lane only, keeps sibling refill open, and
// parks the task behind a per-task backoff (30 min doubling to a 6 h ceiling) rebuilt from those
// rows on boot. An unprefixed throw — rmd's own TypeError — still ends the pass with `error` and
// still exits 1, so the crash budget keeps meaning something (W1-T2546 criterion 3). drain.ts's lane
// settle carries the same arm through the same classifier, so `rmd drain` and the daemon agree.

import assert from "node:assert/strict";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";

import * as daemonModule from "../src/lib/daemon.js";
import { PER_TASK_FAILURE_RE, daemonExitCodeForSummary, runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import * as drainModule from "../src/lib/drain.js";
import { runDrain, type DrainDeps } from "../src/lib/drain.js";
import { preDispatchContractRevision } from "../src/lib/dispatch-repair.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import { PrOpenRefusedError } from "../src/lib/pr-open.js";
import type { RunResult } from "../src/lib/run-result.js";

// This task's NEW symbols are read off the module namespaces rather than named in the import list,
// so at the merge base (where they do not exist) the file still LOADS and its subtests are what
// fail — `rmd check-proof --base` can only call a proof discriminating when a real subtest fails.
const { LANE_DELIVERY_BACKOFF_CEILING_MS, LANE_DELIVERY_BACKOFF_FLOOR_MS, laneDeliveryBackoffMs, priorLaneDeliveryParks } = daemonModule;
const { CREDENTIAL_REFUSAL_RE, SPAWNED_COMMAND_FAILED_RE, laneDeliveryFailure } = drainModule;

const MIN = 60_000;

function planOf(ids: readonly string[], titleSuffix = ""): Plan {
  return loadPlanFromYaml(
    ids
      .map(
        (id) =>
          `- id: ${id}\n  title: ${id} fixture${titleSuffix}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`,
      )
      .join(""),
    "one-tasks-delivery-failure.fixture.yaml",
  );
}

function okResult(id: string): RunResult {
  return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" } as RunResult;
}

/** The shape `execFileSync` throws when this repo's own pre-push gate refuses a push. */
function prePushRefusal(): Error {
  return Object.assign(new Error("Command failed: git push origin HEAD\npre-push REFUSED: census-precheck"), {
    status: 1,
    stderr: "pre-push REFUSED: census-precheck — 1 suite red",
  });
}

/** The `gh api POST pulls` 422 the fleet measured 14 times in 8 days. */
function prCreate422(): Error {
  return Object.assign(new Error("Command failed: gh api --method POST repos/craigoley/remudero/pulls"), {
    status: 1,
    stderr: 'gh: Validation Failed (HTTP 422)\n{"message":"Validation Failed","errors":[{"field":"base","code":"invalid"}]}',
  });
}

function mergeBaseRefusal(id: string): PrOpenRefusedError {
  return new PrOpenRefusedError("branch-gap", `${id} proof did not pass against merge base (unit test: test/x.test.ts): exit 1`);
}

type Row = { step: string; extra: Record<string, unknown> };

// ── the pure classifier, both arms (negative-reachability) ──────────────────────────────────────

test("W1-T5344: the delivery classifier matches a spawned command's failure and the PR-open refusal, and stops at rmd's own throws", () => {
  assert.equal(laneDeliveryFailure(prePushRefusal())?.failureClass, "command_failed");
  assert.equal(laneDeliveryFailure(prePushRefusal())?.firstLine, "Command failed: git push origin HEAD", "only the first line is carried");
  assert.equal(laneDeliveryFailure(prCreate422())?.failureClass, "command_failed");
  assert.equal(laneDeliveryFailure(new Error("Command failed: git -C /w commit -m x"))?.failureClass, "command_failed");
  assert.equal(laneDeliveryFailure(new Error("Command failed: git rev-parse HEAD\nfatal: not a git repository"))?.failureClass, "command_failed");
  assert.equal(laneDeliveryFailure(mergeBaseRefusal("W9-T1"))?.failureClass, "pr_open_refused");
  assert.match(laneDeliveryFailure(mergeBaseRefusal("W9-T1"))?.firstLine ?? "", /^openPullRequestChecked: W9-T1 proof did not pass against merge base/);

  for (const stopping of [
    new TypeError("Cannot read properties of undefined (reading 'id')"),
    new Error("worker spawned with no pid"),
    new Error("TypeError: Command failed: is not at the start"),
    new Error(" Command failed: a leading space breaks the anchor"),
    new Error("command failed: lower case is not the spawn shape"),
    // a dead credential is the FLEET's failure, not the task's — it keeps today's fatal path
    Object.assign(new Error("Command failed: gh api repos/craigoley/remudero/pulls"), { stderr: "gh: Bad credentials (HTTP 401)" }),
    Object.assign(new Error("Command failed: git push origin HEAD"), { stderr: "fatal: Authentication failed for 'https://github.com/x/y.git/'" }),
    "Command failed: a bare string is not an Error a spawn threw",
    undefined,
  ]) {
    assert.equal(laneDeliveryFailure(stopping), undefined, `expected NO match: ${String((stopping as Error)?.message ?? stopping)}`);
  }
});

test("W1-T5344: both patterns are driven directly — where they match and where they stop", () => {
  assert.equal(SPAWNED_COMMAND_FAILED_RE.test("Command failed: git push origin HEAD"), true);
  assert.equal(SPAWNED_COMMAND_FAILED_RE.test("W9-T1: Command failed: git push"), false, "the task prefix is the daemon summary's, not the spawn's");
  assert.equal(SPAWNED_COMMAND_FAILED_RE.test("Command failed:git push"), false);
  assert.equal(SPAWNED_COMMAND_FAILED_RE.test("TypeError: Command failed: "), false);
  assert.equal(CREDENTIAL_REFUSAL_RE.test("gh: Bad credentials (HTTP 401)"), true);
  assert.equal(CREDENTIAL_REFUSAL_RE.test("fatal: Authentication failed for 'https://github.com/o/r.git/'"), true);
  assert.equal(CREDENTIAL_REFUSAL_RE.test("fatal: could not read Username for 'https://github.com'"), true);
  assert.equal(CREDENTIAL_REFUSAL_RE.test("git@github.com: Permission denied (publickey)."), true);
  assert.equal(CREDENTIAL_REFUSAL_RE.test("gh: Validation Failed (HTTP 422)"), false, "a 422 is the task's, not the credential's");
  assert.equal(CREDENTIAL_REFUSAL_RE.test("pre-push REFUSED: census-precheck"), false);
});

test("W1-T5344: a lookalike error that is not pr-open.ts's refusal class is not matched as one", () => {
  const lookalike = Object.assign(new Error("openPullRequestChecked: W9-T1 proof did not pass against merge base"), { refusalClass: "branch-gap" });
  assert.equal(laneDeliveryFailure(lookalike), undefined, "the prose alone never matches — only the class does");
  const untagged = Object.assign(new Error("x"), { name: "PrOpenRefusedError" });
  assert.equal(laneDeliveryFailure(untagged), undefined, "the class name without its refusalClass tag is not the class");
});

test("W1-T5344: the classifier's Command-failed arm agrees with PER_TASK_FAILURE_RE on the detail the daemon would have built", () => {
  for (const message of [
    "Command failed: git push origin HEAD",
    "Command failed: gh api --method POST repos/o/r/pulls",
    "TypeError: x is not a function",
    "AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
    "Command failed:no space",
    "",
  ]) {
    assert.equal(
      laneDeliveryFailure(new Error(message)) !== undefined,
      PER_TASK_FAILURE_RE.test(`W9-T1: ${message}`),
      `the two disagree on ${JSON.stringify(message)}`,
    );
  }
});

test("W1-T5344: the backoff doubles from 30 minutes to a 6 hour ceiling", () => {
  assert.equal(LANE_DELIVERY_BACKOFF_FLOOR_MS, 30 * MIN);
  assert.equal(LANE_DELIVERY_BACKOFF_CEILING_MS, 6 * 60 * MIN);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 40].map(laneDeliveryBackoffMs),
    [30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN, 360 * MIN, 360 * MIN, 360 * MIN],
  );
  assert.equal(laneDeliveryBackoffMs(0), 30 * MIN, "a non-positive streak is floored, never a zero-length park");
});

// ── the daemon: the lane ends, the pass continues ───────────────────────────────────────────────

test("W1-T5344: a lane whose push is refused is ledgered and parked while its sibling lane and the pass continue", async () => {
  const rows: Row[] = [];
  const calls: string[] = [];
  const s = await runDaemon(
    planOf(["W9-T1", "W9-T2"]),
    {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        calls.push(id);
        if (id === "W9-T1") throw prePushRefusal();
        return okResult(id);
      },
      sleep: async () => {},
      now: () => new Date(Date.UTC(2026, 9, 2, 12)),
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { laneCount: 2, max: 2, pollIntervalMs: 1 },
  );

  assert.notEqual(s.stopReason, "error", `one task's refused push ended the pass: ${s.stopDetail}`);
  assert.deepEqual([...calls].sort(), ["W9-T1", "W9-T2"], "the sibling lane ran in the same pass");
  assert.deepEqual(s.merged, ["W9-T2"]);
  const failed = rows.filter((r) => r.step === "daemon.lane_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].extra.task, "W9-T1");
  assert.equal(failed[0].extra.class, "command_failed");
  assert.equal(failed[0].extra.error, "Command failed: git push origin HEAD");
  assert.equal(failed[0].extra.consecutive, 1);
  assert.equal(failed[0].extra.backoff_ms, 30 * MIN);
  assert.equal(failed[0].extra.parked_until_ms, Date.UTC(2026, 9, 2, 12) + 30 * MIN);
  assert.equal(failed[0].extra.revision, preDispatchContractRevision(planOf(["W9-T1"]).byId.get("W9-T1")!));
});

test("W1-T5344: a merge-base proof refusal (no `Command failed:` prefix) ends its lane, not the daemon", async () => {
  const rows: Row[] = [];
  const s = await runDaemon(
    planOf(["W9-T1", "W9-T2"]),
    {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        if (id === "W9-T1") throw mergeBaseRefusal(id);
        return okResult(id);
      },
      sleep: async () => {},
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { laneCount: 2, max: 2, pollIntervalMs: 1 },
  );
  assert.notEqual(s.stopReason, "error", `the merge-base refusal ended the pass: ${s.stopDetail}`);
  const failed = rows.find((r) => r.step === "daemon.lane_failed");
  assert.equal(failed?.extra.task, "W9-T1");
  assert.equal(failed?.extra.class, "pr_open_refused");
});

test("W1-T5344: the parked task is not re-picked on the next tick, and each consecutive failure doubles its park", async () => {
  const rows: Row[] = [];
  const dispatchedAtMin: number[] = [];
  const t0 = Date.UTC(2026, 9, 2, 12);
  let nowMs = t0;
  let stop = false;
  const s = await runDaemon(
    planOf(["W9-T1"]),
    {
      refreshMerged: () => () => false,
      runOne: async () => {
        dispatchedAtMin.push((nowMs - t0) / MIN);
        if (dispatchedAtMin.length === 3) stop = true;
        throw prePushRefusal();
      },
      checkStop: () => (stop ? "test complete" : undefined),
      sleep: async (ms) => {
        nowMs += ms;
      },
      now: () => new Date(nowMs),
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { pollIntervalMs: 20 * MIN },
  );

  assert.equal(s.stopReason, "stopped", `the loop must keep running through every failure: ${s.stopDetail}`);
  // t0 fails (parked to +30). +20 is still parked. +40 re-dispatches, fails (parked to +100). +60 and
  // +80 are parked. +100 re-dispatches. Without the park the task is re-admitted on every tick.
  assert.deepEqual(dispatchedAtMin, [0, 40, 100], "the next tick re-admitted a parked task");
  const failed = rows.filter((r) => r.step === "daemon.lane_failed");
  assert.deepEqual(failed.map((r) => r.extra.consecutive), [1, 2, 3]);
  assert.deepEqual(failed.map((r) => r.extra.backoff_ms), [30 * MIN, 60 * MIN, 120 * MIN], "the park grows per consecutive failure");
});

test("W1-T5344: the park is rebuilt from the ledger on boot, so a restart neither re-picks the task nor resets its streak", async () => {
  const t0 = Date.UTC(2026, 9, 2, 12);
  const revision = preDispatchContractRevision(planOf(["W9-T1"]).byId.get("W9-T1")!);
  const ledger = [
    JSON.stringify({ step: "daemon.lane_failed", task: "W9-T1", class: "command_failed", consecutive: 1, backoff_ms: 30 * MIN, parked_until_ms: t0 - 60 * MIN, revision }),
    "{torn line",
    JSON.stringify({ step: "daemon.lane_failed", task: "W9-T1", class: "command_failed", consecutive: 2, backoff_ms: 60 * MIN, parked_until_ms: t0 + 30 * MIN, revision }),
  ];
  const parks = priorLaneDeliveryParks(ledger);
  assert.deepEqual(parks.get("W9-T1"), { consecutive: 2, parkedUntilMs: t0 + 30 * MIN, revision });

  const rows: Row[] = [];
  const dispatchedAtMin: number[] = [];
  let nowMs = t0;
  let stop = false;
  await runDaemon(
    planOf(["W9-T1"]),
    {
      refreshMerged: () => () => false,
      readLedgerLines: () => ledger,
      runOne: async () => {
        dispatchedAtMin.push((nowMs - t0) / MIN);
        stop = true;
        throw prePushRefusal();
      },
      checkStop: () => (stop ? "test complete" : undefined),
      sleep: async (ms) => {
        nowMs += ms;
      },
      now: () => new Date(nowMs),
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { pollIntervalMs: 20 * MIN },
  );
  assert.deepEqual(dispatchedAtMin, [40], "the boot tick honoured the ledgered park instead of re-dispatching at once");
  assert.equal(rows.find((r) => r.step === "daemon.lane_failed")?.extra.consecutive, 3, "the streak survived the restart");
});

test("W1-T5344: a successful settlement after the failure ends the streak in the rebuilt state", () => {
  const ledger = [
    JSON.stringify({ step: "daemon.lane_failed", task: "W9-T1", consecutive: 4, parked_until_ms: 5, revision: "r" }),
    JSON.stringify({ step: "daemon.lane_failed", task: "W9-T2", consecutive: 1, parked_until_ms: 5, revision: "r" }),
    JSON.stringify({ step: "dispatch.settled_set", tasks: [{ id: "W9-T1", status: "fulfilled" }, { id: "W9-T2", status: "rejected" }] }),
    JSON.stringify({ step: "daemon.lane_failed", task: "W9-T3", consecutive: "two", parked_until_ms: 5 }),
  ];
  const parks = priorLaneDeliveryParks(ledger);
  assert.equal(parks.has("W9-T1"), false, "a fulfilled lane clears its task's park");
  assert.equal(parks.get("W9-T2")?.consecutive, 1, "a rejected lane in the same set keeps its park");
  assert.equal(parks.has("W9-T3"), false, "a malformed row is skipped, never guessed at");
});

test("W1-T5344: a new shard revision clears the park, so a corrected task is re-admitted at once", async () => {
  const rows: Row[] = [];
  const t0 = Date.UTC(2026, 9, 2, 12);
  const dispatchedAtMin: number[] = [];
  let nowMs = t0;
  let stop = false;
  let reloaded = false;
  await runDaemon(
    planOf(["W9-T1"]),
    {
      refreshMerged: () => () => false,
      reloadPlan: () => {
        if (dispatchedAtMin.length === 0 || reloaded) return null;
        reloaded = true;
        return planOf(["W9-T1"], " revised");
      },
      runOne: async () => {
        dispatchedAtMin.push((nowMs - t0) / MIN);
        if (dispatchedAtMin.length === 2) stop = true;
        throw prePushRefusal();
      },
      checkStop: () => (stop ? "test complete" : undefined),
      sleep: async (ms) => {
        nowMs += ms;
      },
      now: () => new Date(nowMs),
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { pollIntervalMs: 5 * MIN },
  );
  // The dispatch tick does not sleep, so the very next tick reloads the revised shard and admits it
  // at once — an unrevised task waits out its 30 minute park (the streak test above).
  assert.deepEqual(dispatchedAtMin, [0, 0], "the revised shard was not re-admitted until its park ran out");
  const cleared = rows.find((r) => r.step === "daemon.lane_park_cleared");
  assert.equal(cleared?.extra.task, "W9-T1");
  assert.equal(cleared?.extra.reason, "shard revised");
  assert.deepEqual(rows.filter((r) => r.step === "daemon.lane_failed").map((r) => r.extra.consecutive), [1, 1], "a revision restarts the streak");
});

test("W1-T5344: a delivery failure keeps sibling refill open, like a lane-local gh read failure", async () => {
  const rows: Row[] = [];
  const started: string[] = [];
  let releaseSlow!: (r: RunResult) => void;
  const slow = new Promise<RunResult>((r) => (releaseSlow = r));
  const run = runDaemon(
    planOf(["W9-T1", "W9-T2", "W9-T3"]),
    {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        started.push(id);
        if (id === "W9-T1") throw prePushRefusal();
        if (id === "W9-T2") return slow;
        return okResult(id);
      },
      sleep: async () => {},
      log: (step, extra = {}) => rows.push({ step, extra }),
    } as DaemonDeps,
    { laneCount: 2, max: 3, pollIntervalMs: 1 },
  );
  await drainMicrotasks();
  await drainMicrotasks();
  assert.ok(started.includes("W9-T3"), `the failed lane's slot was not refilled while its sibling ran: ${started.join(",")}`);
  releaseSlow(okResult("W9-T2"));
  const s = await run;
  assert.notEqual(s.stopReason, "error");
  assert.ok(
    rows.every((r) => r.step !== "dispatch.lane_refill_held" || r.extra.reason !== "a lane rejected"),
    "the delivery failure closed sibling refill",
  );
});

// ── genuine crashes are unchanged ───────────────────────────────────────────────────────────────

test("W1-T5344: an unprefixed TypeError still ends the pass with the error summary and still exits 1", async () => {
  const rows: Row[] = [];
  const s = await runDaemon(
    planOf(["W9-T1", "W9-T2"]),
    {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        if (id === "W9-T1") throw new TypeError("Cannot read properties of undefined (reading 'id')");
        return okResult(id);
      },
      sleep: async () => {},
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { laneCount: 2, max: 2, pollIntervalMs: 1 },
  );
  assert.equal(s.stopReason, "error");
  assert.match(s.stopDetail ?? "", /^W9-T1: Cannot read properties of undefined/);
  assert.equal(daemonExitCodeForSummary(s), 1, "a genuine crash still spends docker's crash budget");
  assert.equal(rows.some((r) => r.step === "daemon.lane_failed"), false, "rmd's own defect is never parked as the task's");
});

test("W1-T5344: a spawn with no pid and a dead credential stay on the fatal path", async () => {
  for (const rejection of [
    new Error("worker spawned with no pid"),
    Object.assign(new Error("Command failed: gh api --method POST repos/craigoley/remudero/pulls"), { stderr: "gh: Bad credentials (HTTP 401)" }),
  ]) {
    const s = await runDaemon(planOf(["W9-T1"]), {
      refreshMerged: () => () => false,
      runOne: async () => {
        throw rejection;
      },
      sleep: async () => {},
    });
    assert.equal(s.stopReason, "error", rejection.message);
  }
});

// ── drain.ts agrees ─────────────────────────────────────────────────────────────────────────────

function drainDeps(runOne: DrainDeps["runOne"], rows: Row[]): DrainDeps {
  return { refreshMerged: () => () => false, runOne, log: (step, extra = {}) => rows.push({ step, extra }) } as DrainDeps;
}

test("W1-T5344: `rmd drain`'s lane settle ends only the failing lane too, and records it as continued", async () => {
  const rows: Row[] = [];
  const calls: string[] = [];
  const s = await runDrain(
    planOf(["W9-T1", "W9-T2"]),
    drainDeps(async (id) => {
      calls.push(id);
      if (id === "W9-T1") throw prCreate422();
      return okResult(id);
    }, rows),
    { laneCount: 2, max: 2 },
  );
  assert.notEqual(s.stopReason, "error", `drain ended on one task's 422: ${s.stopDetail}`);
  assert.deepEqual([...calls].sort(), ["W9-T1", "W9-T2"]);
  assert.deepEqual(s.merged, ["W9-T2"]);
  assert.deepEqual(s.continued?.map((c) => [c.taskId, c.verdict]), [["W9-T1", "lane_failed"]]);
  const failed = rows.find((r) => r.step === "drain.lane_failed");
  assert.equal(failed?.extra.task, "W9-T1");
  assert.equal(failed?.extra.class, "command_failed");
});

test("W1-T5344: `rmd drain`'s lane settle still stops on an unprefixed TypeError", async () => {
  const s = await runDrain(
    planOf(["W9-T1", "W9-T2"]),
    drainDeps(async (id) => {
      if (id === "W9-T1") throw new TypeError("x is not a function");
      return okResult(id);
    }, []),
    { laneCount: 2, max: 2 },
  );
  assert.equal(s.stopReason, "error");
  assert.match(s.stopDetail ?? "", /^W9-T1: x is not a function/);
});
