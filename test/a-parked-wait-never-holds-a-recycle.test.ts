import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { requestPause } from "../src/lib/fleet-control.js";
import { acquireInflightLock } from "../src/lib/inflight-lock.js";
import { recyclePauseDetail } from "../src/lib/recycle-yield.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, type OpenPrView } from "../src/lib/sweep.js";
import { fixBranchClaimKey, pollToGate, runFixRung, waitForCiGreen, withInflightRunLock, type PollDeps } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Task } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TASK_ID = "W1-T5140";
const RUN_ID = "SWEEP-W1-T5140";
const BRANCH = "run-W1-T5140-1790862539457";
const HEAD = "c".repeat(40);
const URL = "https://github.com/acme/remudero/pull/1";
const RECYCLE = "container recycle (deploy/recycle-container.sh)";
type Row = { step: string; extra?: Record<string, unknown> };
const task = { id: TASK_ID, title: "release at the wait", repo: "remudero", type: "implement", risk: "low", acceptance: [], files: ["src/lib/sweep.ts"], verify: "auto", status: "queued", depends_on: [], attempts: 0 } as Task;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-parked-wait-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Row[] = [];
  return { root, rows, log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); } };
}

function pending(root: string, options: { onPoll?: (n: number) => void; doneAt?: number; pr?: boolean } = {}): PollDeps {
  let polls = 0;
  return {
    readJson: async (args) => {
      const path = args[1];
      if (path.includes("/pulls/1")) {
        polls++;
        options.onPoll?.(polls);
        return { number: 1, state: "open", merged: !!options.pr && polls === options.doneAt, head: { sha: HEAD } };
      }
      if (path.includes("/check-runs")) return { check_runs: [{ name: "ci", status: polls === options.doneAt ? "completed" : "in_progress", conclusion: polls === options.doneAt ? "success" : null }] };
      if (path.includes("/status")) return { statuses: [] };
      throw new Error(`unexpected request: ${path}`);
    },
    sleep: async () => {},
    requiredContexts: () => ["ci"],
    externalWaitRecycle: () => recyclePauseDetail(root),
  };
}

async function sweepWait(root: string, log: (step: string, extra?: Record<string, unknown>) => void, pollDeps: PollDeps, working?: () => Promise<void>) {
  const { externalWaitRecycle: _fixtureRecycle, ...pollIo } = pollDeps;
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", config: { root } as Config, repoRoot: REPO_ROOT,
    ledgerPath: join(root, "ledger.ndjson"), runId: RUN_ID,
    plan: { tasks: [task], byId: new Map([[task.id, task]]) }, log, policy: DEFAULT_SWEEP_POLICY,
    dispatchFixPreflightStandDownImpl: async () => undefined,
    ghJsonImpl: () => ({ headRefName: BRANCH, headRefOid: HEAD, body: "" }),
    registeredWorktreeOwnerImpl: () => undefined,
    fixBranchClaimKeyImpl: fixBranchClaimKey,
    createFixRungWorktreeImpl: () => undefined,
    captureWorktreeSnapshotImpl: () => undefined,
    buildFixRungDispatchArgsImpl: () => ({}),
    openTaskIdsFromPlanImpl: () => new Set(),
    readPackageScriptsImpl: () => ({}),
    worktreeRemoveImpl: () => {},
    waitForCiGreenImpl: (url, waitLog, everySec, deps) => waitForCiGreen(url, waitLog, everySec, { ...pollIo, ...deps }),
    runFixRungImpl: async (opts) => {
      await working?.();
      const ci = await opts.deps.waitForCiGreen(URL, opts.deps.log);
      assert.equal(ci.state, working ? "green" : "freshness_handoff");
      return { outcome: ci.state === "freshness_handoff" ? "handed_off" : "fixed" };
    },
  });
  await effects.dispatchFix({ prNumber: 1, prUrl: URL, taskId: TASK_ID, headSha: HEAD, headRefName: BRANCH, priorStrikes: 0, checksState: "red" } as OpenPrView, { unmetCriteria: [], ciFailures: [] });
}

test("W1-T5140: a fix-branch claim whose round is only waiting on CI does not hold a recycle", async (t) => {
  const { root, log } = fixture(t);
  let polls = 0;
  await sweepWait(root, log, pending(root, { doneAt: 5, onPoll: (n) => {
    polls = n;
    assert.equal(readdirSync(join(root, "state", "inflight")).length, 1);
    if (n === 3) requestPause(root, RECYCLE);
  } }));
  assert.equal(polls, 3, "a pause engaged mid-wait is seen at the next poll");
  assert.deepEqual(readdirSync(join(root, "state", "inflight")), []);
});

test("W1-T5140: a run waiting on its PR to merge does not hold a recycle", async (t) => {
  const { root, rows, log } = fixture(t);
  const lock = acquireInflightLock(join(root, "state", "inflight"), TASK_ID, { run_id: RUN_ID });
  let polls = 0;
  const result = await withInflightRunLock(lock, TASK_ID, log, (runLog) => pollToGate(URL, runLog, 0, pending(root, { pr: true, doneAt: 5, onPoll: (n) => {
    polls = n;
    assert.ok(existsSync(lock.path));
    if (n === 3) requestPause(root, RECYCLE);
  } })));
  assert.equal(polls, 3);
  assert.equal(result.verdict, "handed_off");
  assert.equal(result.reason, "recycle_yield");
  assert.equal(result.headSha, HEAD);
  assert.equal(existsSync(lock.path), false);
  assert.equal(rows.find((r) => r.step === "run.freshness_handoff")?.extra?.waiting_on, "pr");
});

test("W1-T5140: a lock whose holder is still working keeps holding the recycle", async (t) => {
  const { root, rows, log } = fixture(t);
  let finish!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const work = new Promise<void>((resolve) => { finish = resolve; });
  const dispatch = sweepWait(root, log, pending(root, { doneAt: 1 }), async () => { started(); await work; });
  await running;
  requestPause(root, RECYCLE);
  assert.equal(readdirSync(join(root, "state", "inflight")).length, 1, "an active worker keeps its claim");
  assert.ok(!rows.some((r) => r.step === "inflight.recycle_yield"));
  finish();
  await dispatch;
  assert.ok(!rows.some((r) => r.step === "inflight.recycle_yield"), "terminal CI is work completed, not a parked wait");
});

test("W1-T5140: the ledger names each lock the recycle treated as parked", async (t) => {
  const { root, rows, log } = fixture(t);
  requestPause(root, RECYCLE);
  await sweepWait(root, log, pending(root, { doneAt: 3 }));
  const lock = acquireInflightLock(join(root, "state", "inflight"), TASK_ID, { run_id: RUN_ID });
  await withInflightRunLock(lock, TASK_ID, log, (runLog) => pollToGate(URL, runLog, 0, pending(root)));
  const parked = rows.filter((r) => r.step === "inflight.recycle_yield").map((r) => r.extra);
  assert.deepEqual(parked, [
    { lock_key: fixBranchClaimKey("acme", "remudero", BRANCH), task_id: TASK_ID, run_id: RUN_ID, waiting_on: "ci" },
    { lock_key: TASK_ID, task_id: TASK_ID, run_id: RUN_ID, waiting_on: "pr" },
  ]);
});

test("W1-T5140: an operator pause keeps the PR wait and its lock until merge", async (t) => {
  const { root, rows, log } = fixture(t);
  requestPause(root, "investigating deploy/recycle-container.sh");
  const lock = acquireInflightLock(join(root, "state", "inflight"), TASK_ID, { run_id: RUN_ID });
  const result = await withInflightRunLock(lock, TASK_ID, log, (runLog) => pollToGate(URL, runLog, 0, pending(root, { pr: true, doneAt: 3, onPoll: () => assert.ok(existsSync(lock.path)) })));
  assert.equal(result.merged, true);
  assert.ok(!rows.some((r) => r.step === "inflight.recycle_yield"));
  assert.equal(existsSync(lock.path), false);
});

test("W1-T5140: task locks release even when the run or the parked-lock logger throws", async (t) => {
  const { root, log } = fixture(t);
  for (const parked of [false, true]) {
    const lock = acquireInflightLock(join(root, "state", "inflight"), TASK_ID, { run_id: RUN_ID });
    await assert.rejects(withInflightRunLock(lock, TASK_ID, (step, extra) => {
      if (step === "inflight.recycle_yield") throw new Error("log failed");
      log(step, extra);
    }, async (runLog) => {
      if (!parked) throw new Error("run failed");
      runLog("run.freshness_handoff", { trigger: "recycle", waiting_on: "ci" });
    }), parked ? /log failed/ : /run failed/);
    assert.equal(existsSync(lock.path), false);
  }
});

test("W1-T5140: a fix rung hands pending CI off without another worker, review or escalation", async (t) => {
  const { root, rows, log } = fixture(t);
  let spawns = 0;
  const mount = { model: "claude-sonnet-4-6", effort: "high", maxTurns: 4, contextBudget: 100_000 };
  const worker = {
    sessionId: "fix-session", costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: mount.model,
    effort: mount.effort, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  } as WorkerResult;
  const result = await runFixRung({
    taskId: TASK_ID, runId: RUN_ID, task, prUrl: URL, branch: BRANCH, worktreePath: root,
    initialSessionId: "", mount, settingsFile: join(root, "settings.json"), config: { root } as Config,
    budgetUsd: 1, strikeCap: 2, ciFailures: [{ name: "ci", logTail: "Error: build failed" }],
    initialReview: { state: "failure", criteria: [], testTheater: false, summary: "CI red", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: HEAD, reviewerOutcome: "sweep-reconstructed-ci-log" },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async () => { assert.equal(++spawns, 1); return worker; },
      harnessCommitForShellLessWorker: () => 1,
      commitsAhead: () => 1,
      worktreeHasUncommittedChanges: () => false,
      waitForCiGreen: async () => ({ state: "freshness_handoff", sha: HEAD, recycle: `PAUSE requested: ${RECYCLE}` }),
      fetchCiFailures: async () => { assert.fail("a recycle must not mine more CI evidence"); },
      runReview: async () => { assert.fail("pending CI cannot be reviewed"); },
      push: () => {},
      issues: { create: () => { assert.fail("a recycle cannot escalate"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), log, say: () => {}, account: (result) => result,
    },
  });
  assert.equal(result.outcome, "handed_off");
  assert.equal(result.reason, "recycle_yield");
  assert.equal(result.strikes, 1, "the completed worker remains a spent strike");
  assert.equal(spawns, 1);
  assert.equal(rows.find((r) => r.step === "fix.ci_not_green")?.extra?.ci, "freshness_handoff");
});

test("W1-T5140: an operator pause keeps the sweep CI wait until it turns green", async (t) => {
  const { root, rows, log } = fixture(t);
  requestPause(root, "investigating deploy/recycle-container.sh");
  let polls = 0;
  await sweepWait(root, log, pending(root, { doneAt: 3, onPoll: (n) => { polls = n; } }), async () => {});
  assert.equal(polls, 3);
  assert.ok(!rows.some((r) => r.step === "inflight.recycle_yield"));
  assert.deepEqual(readdirSync(join(root, "state", "inflight")), []);
});
