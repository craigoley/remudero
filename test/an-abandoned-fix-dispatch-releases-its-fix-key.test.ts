import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { awaitMemoryAdmission, resetMemoryAdmissionStateForTests, waitingStarts, type AdmissionPorts } from "../src/lib/host-memory-admission.js";
import { MEMORY_ADMISSION_LOCK_BUSY } from "../src/lib/host-memory-ledger.js";
import type { HostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";
import { readLedgerLines } from "../src/lib/status.js";
import * as sweep from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import { activeWorkerCount, spawnWorker, type SpawnWorkerArgs } from "../src/lib/worker.js";

const NOW = Date.now();
const KEY = "W1-T9969@waiting-head";
const policy = { mode: "enforce" } as HostMemoryBudgetPolicy;
function gate(controller: AbortController, now: () => number, sleep: AdmissionPorts["sleep"]): Partial<AdmissionPorts> {
  return {
    clock: { now, date: () => new Date(now()), iso: () => new Date(now()).toISOString() }, policy: () => policy,
    enforceHere: () => true, random: () => 0.5, sleep,
    withLock: () => { throw Object.assign(new Error("lock busy"), { code: MEMORY_ADMISSION_LOCK_BUSY }); },
    write: () => {}, stderr: () => {},
  };
}
function fixture(t: TestContext, phase: sweep.DetachedFixPhase = "admission") {
  resetMemoryAdmissionStateForTests();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9969-`));
  let now = NOW;
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const controls: Array<{ signal: AbortSignal; admissionSinceMs?: number }> = [];
  let startedWorkers = 0;
  const pr: sweep.OpenPrView = {
    prNumber: 9969, taskId: "W1-T9969", prUrl: "https://github.com/o/r/pull/9969", headSha: "waiting-head",
    checksState: "green", reviewState: "failure", autoMergeArmed: false, priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    unmetCriteria: [{ claim: "repair", proof: "unit test: repair", met: false, reason: "broken", proof_exec: "executed_fail" }],
  };
  const deps: sweep.SweepDeps = {
    runId: "SWEEP-T9969", ledgerPath: join(root, "ledger.ndjson"), now: () => now, detachFixWait: true,
    arm: () => assert.fail("no arm"), close: () => assert.fail("no close"), escalate: () => assert.fail("no escalation"),
    actionable: d => d === "blocked-fixable", claimFixAdmission: () => ({ admitted: true }),
    dispatchFix: async (_pr, _evidence, onPhase, control) => {
      assert.ok(control, "the detached claim supplies its cancellation and retained age");
      controls.push(control);
      onPhase?.(phase, phase === "admission" ? { sinceMs: control.admissionSinceMs ?? now, attempts: 44 } : undefined);
      await Promise.race([waiting, new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), { once: true }))]);
      if (!control.signal.aborted) startedWorkers++;
      return false;
    },
  };
  const pass = () => sweep.runSweep([pr], deps);
  t.after(async () => { finish(); await sweep.drainDetachedSweepActions(); rmSync(root, { recursive: true, force: true }); });
  return { deps, pass, controls, finish, workers: () => startedWorkers, advance: (ms: number) => { now += ms; },
    rows: () => readLedgerLines(deps.ledgerPath),
    action: async () => (await sweep.drainDetachedSweepActions({ boundMs: 0 }))[0]! };
}

test("W1-T9969: a duplicate fix claim names its own waiting dispatch and that wait age", async t => {
  const f = fixture(t);
  await f.pass();
  assert.equal(f.controls.length, 1);
  f.advance(1_800_000);
  await f.pass();
  const row = f.rows().filter(r => r.step === "sweep.disposed").at(-1)!;
  assert.match(String(row.stand_down_reason), /held by its own detached fix dispatch, admission for 1800s \(44 admission attempts\)/);
  assert.equal(row.in_flight_action, "fix-dispatch");
  assert.equal(row.in_flight_phase, "admission");
  assert.equal(row.in_flight_age_ms, 1_800_000);
  assert.equal(f.controls.length, 1);
});

test("W1-T9969: abandoning a fix dispatch still waiting for memory admission releases its key", async t => {
  const f = fixture(t);
  await f.pass();
  const action = await f.action();
  assert.ok(action, "freshness drains must keep awaiting admission");
  assert.equal((await sweep.drainDetachedSweepActions({ boundMs: 0, freshness: true })).length, 1);
  const result = await sweep.abandonDetachedSweepAction(action);
  assert.equal(result.released_fix_key, KEY);
  assert.equal(f.controls[0].signal.aborted, true);
  assert.equal(sweep.detachedSweepActionCount(), 0);
  assert.equal(f.workers(), 0);
});

test("W1-T9969: a released fix key re-admits on the next pass", async t => {
  const f = fixture(t);
  await f.pass();
  const stale = await f.action();
  await sweep.abandonDetachedSweepAction(stale);
  await f.pass();
  assert.equal(f.controls.length, 2, "the next pass actually dispatches again");
  assert.equal(f.controls[1].signal.aborted, false);
  await sweep.abandonDetachedSweepAction(stale);
  assert.equal(f.controls[1].signal.aborted, false, "an old descriptor cannot cancel its replacement");
});

test("W1-T9969: an abandoned fix dispatch whose worker is running keeps its key", async t => {
  for (const phase of ["worker", "ci-wait"] as const) {
    const f = fixture(t, phase);
    await f.pass();
    const result = await sweep.abandonDetachedSweepAction(await f.action());
    assert.equal(result.released_fix_key, null);
    assert.equal(result.held_by, phase === "worker" ? "live-worker" : "ci-wait");
    assert.equal(f.controls[0].signal.aborted, false);
    await f.pass();
    assert.equal(f.controls.length, 1);
    f.finish();
    await sweep.drainDetachedSweepActions();
  }
});

test("W1-T9969: an abandoned admission wait spends no strike and starts no worker", async () => {
  resetMemoryAdmissionStateForTests();
  const controller = new AbortController();
  let attempts = 0;
  const occupancy = activeWorkerCount();
  const result = await spawnWorker({
    prompt: "never start", cwd: process.cwd(), settingsFile: "/missing-settings-must-never-be-read",
    model: "sonnet", effort: "low", signal: controller.signal,
    memoryShadow: gate(controller, () => NOW, async () => { attempts++; controller.abort(); }),
  } as SpawnWorkerArgs);
  assert.equal(result.subtype, "admission_abandoned");
  assert.equal(result.notStarted, "admission-abandoned");
  assert.equal(result.numTurns, 0);
  assert.equal(attempts, 1, "positive control: this spawn reached memory admission");
  assert.equal(activeWorkerCount(), occupancy);
  const dispatch = { task_id: "W1-T9969", step: "fix.dispatch", round_id: "abandoned", head_sha: "h", verdict_regime: "executed" };
  const done = { ...dispatch, step: "fix.done", subtype: result.subtype, worker_exit: "not_spawned", pushed_head_sha: "new" };
  assert.equal(sweep.fixRoundTally([dispatch, done], "W1-T9969", "h", "executed").strikes, 0);
  assert.equal(sweep.fixRoundTally([dispatch, { ...done, subtype: "success", worker_exit: "exited" }], "W1-T9969", "h", "executed").strikes, 1);
});

test("W1-T9969: a re-admitted dispatch keeps the admission age of the wait it replaced", async t => {
  const f = fixture(t);
  await f.pass();
  await sweep.abandonDetachedSweepAction(await f.action());
  f.advance(2_640_000);
  await f.pass();
  assert.equal(f.controls.length, 2);
  assert.equal(f.controls[1].admissionSinceMs, NOW);
  const controller = new AbortController();
  let rankedSince: number | undefined;
  await awaitMemoryAdmission({ workerClass: "fix", root: "/unused", signal: controller.signal,
    sinceMs: f.controls[1].admissionSinceMs }, gate(controller, () => NOW + 2_640_000, async () => {
    rankedSince = waitingStarts()[0]?.waitingSinceMs;
    controller.abort();
  }));
  assert.equal(rankedSince, NOW, "the actual admission queue ranks from the original wait");
});

test("W1-T9969: an abort interrupts sleeping admission without admitting on error", async () => {
  resetMemoryAdmissionStateForTests();
  const controller = new AbortController();
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let now = NOW;
  const pending = awaitMemoryAdmission({ workerClass: "fix", root: "/unused", signal: controller.signal },
    gate(controller, () => now, () => { enter(); return new Promise(() => {}); }));
  await entered;
  now += 5000;
  controller.abort();
  assert.deepEqual(await pending, { kind: "abandoned", reason: "admission-abandoned", waitedMs: 5000, attempts: 1 });
  assert.equal(waitingStarts().length, 0);
  const before = awaitMemoryAdmission({ workerClass: "fix", root: "/unused", signal: controller.signal },
    { policy: () => { assert.fail("an already aborted wait must not even read policy"); } });
  assert.equal((await before).kind, "abandoned");
});


test("W1-T9969: the daemon drain cancels an unstarted fix and reports its released key", async t => {
  const f = fixture(t);
  const planPath = join(f.deps.ledgerPath, "..", "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const rows: Record<string, unknown>[] = [];
  const result = await runDaemon(loadPlan(planPath), {
    refreshMerged: () => () => false,
    runOne: async taskId => ({ taskId, runId: "unused", merged: false, costUsd: 0, verdict: "blocked" }),
    sleep: async () => {},
    checkFreshness: () => ({ stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }),
    sweep: async () => { await f.pass(); },
    log: (step, fields) => { rows.push({ step, ...fields }); },
  }, { sweepWallClockBoundMs: 10 });
  assert.equal(result.stopReason, "stale");
  const abandoned = rows.find(row => row.step === "daemon.detached_action_abandoned");
  assert.equal(abandoned?.released_fix_key, KEY);
  assert.equal(f.controls[0].signal.aborted, true);
  assert.equal(f.workers(), 0);
  await f.pass();
  assert.equal(f.controls.length, 2);
});

test("W1-T9969: the real fix round records admission abandonment before commit or push", async t => {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return "waiting-head";
    if (args.includes("--show-scope")) return "";
    throw new Error("test: subprocess reads unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9969-round-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Record<string, unknown>[] = [];
  const controller = new AbortController();
  let released = false;
  const mount = { model: "sonnet", effort: "high", maxTurns: 20, contextBudget: 120000 } as const;
  const review = { state: "failure", criteria: [{ claim: "repair", proof: "unit test: repair", met: false,
    reason: "broken", proof_exec: "not_executable" }], testTheater: false, summary: "broken", floorDegraded: false,
    capped: false, keywordOnly: false, planOnly: false, headSha: "waiting-head", reviewerOutcome: "failure" } as ReviewVerdict & { headSha: string; reviewerOutcome: string };
  const outcome = await runFixRung({
    taskId: "W1-T9969", runId: "ROUND-T9969", task: { id: "W1-T9969", title: "repair", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/o/r/pull/9969", branch: "run-W1-T9969-1", worktreePath: process.cwd(),
    initialSessionId: "writer", mount, settingsFile: "/must-not-read-settings", config: { root } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "ci", logTail: "assertion failed" }],
    reviewBase: { owner: "o", repo: "r", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: args => spawnWorker({ ...args, signal: controller.signal, memoryAdmissionSinceMs: NOW,
        memoryShadow: gate(controller, () => NOW, async () => { controller.abort(); }) }),
      waitForCiGreen: async () => assert.fail("no CI wait"), runReview: async () => assert.fail("no review"),
      push: () => assert.fail("no push"), issues: { create: () => assert.fail("no escalation") },
      ledgerPath: join(root, "ledger.ndjson"), log: (step, fields) => { rows.push({ step, task_id: "W1-T9969", ...fields }); },
      readHeadShaForProvenance: () => "waiting-head", say: () => {}, account: r => r,
      branchClaim: { id: () => "branch-claim", release: () => { released = true; }, reacquire: () => undefined, last: () => assert.fail("no live branch handle needed before admission") },
    },
  });
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 0);
  assert.equal(released, true);
  assert.equal(rows.find(row => row.step === "fix.done")?.subtype, "admission_abandoned");
  assert.equal(rows.find(row => row.step === "fix.done")?.worker_exit, "not_spawned");
  assert.equal(rows.find(row => row.step === "fix.done")?.admission_since_ms, NOW);
  assert.equal(rows.some(row => row.step === "fix.dispatch"), false);
  assert.equal(sweep.fixRoundTally(rows, "W1-T9969", "waiting-head").strikes, 0);
});


test("W1-T9969: the production dispatch threads admission phase, cancellation and retained age to spawn", async t => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9969-effects-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state/inflight", "repos/fixture", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
  const controller = new AbortController();
  const phases: string[] = [];
  let spawned = false;
  const task = { id: "W1-T9969", title: "repair", files: [], acceptance: [], verify: "auto", status: "queued", risk: "low" };
  const effects = sweep.buildSweepEffects({
    owner: "o", repo: "fixture", localRepoName: "remudero", repoRoot: process.cwd(), config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state/ledger.ndjson"), runId: "SWEEP-T9969-EFFECTS",
    plan: { tasks: [task], byId: new Map([[task.id, task]]) }, policy: sweep.DEFAULT_SWEEP_POLICY,
    log: () => {}, say: () => {}, reviewRunner: async () => 0, issuesImpl: { create: () => assert.fail("no issue") },
    stallNotice: () => {}, armImpl: () => "armed", armSessionPrsOverride: false, updateBranchImpl: async () => "updated",
    captureRepairFeedbackImpl: () => {}, ghRunImpl: () => {}, disarmImpl: () => undefined,
    readJsonImpl: async () => ({}), updatePrBodyImpl: async () => {}, registeredWorktreeOwnerImpl: () => undefined,
    registeredOwnerRecovery: { capture: () => undefined, remove: () => undefined },
    dispatchFixPreflightStandDownImpl: async () => undefined, fixBranchClaimKeyImpl: () => "t9969-claim",
    createFixRungWorktreeImpl: () => undefined, captureWorktreeSnapshotImpl: () => ({ headSha: "waiting-head" }),
    buildFixRungDispatchArgsImpl: () => ({}), openTaskIdsFromPlanImpl: () => new Set([task.id]),
    readPackageScriptsImpl: () => ({}), worktreeRemoveImpl: () => {},
    ghJsonImpl: () => ({ headRefName: "run-W1-T9969-1", headRefOid: "waiting-head", body: "", files: [] }),
    spawnImpl: async (args: SpawnWorkerArgs) => {
      spawned = true;
      assert.equal(args.memoryAdmissionSinceMs, NOW - 60000);
      assert.equal(args.signal, controller.signal);
      return spawnWorker({ ...args, prompt: "never start", cwd: root, settingsFile: "/missing-settings", model: "sonnet",
        memoryShadow: { ...gate(controller, () => NOW, async () => {}), ...args.memoryShadow } });
    },
    runFixRungImpl: async (args: { deps: { spawn: typeof spawnWorker } }) => {
      const result = await args.deps.spawn({ prompt: "never start", cwd: root, settingsFile: "/missing-settings", model: "sonnet", permissionMode: "bypassPermissions" });
      assert.equal(result.notStarted, "admission-abandoned");
      return { outcome: "stood_down", strikes: 0, retriggers: 0 };
    },
  } as unknown as sweep.BuildSweepEffectsDeps);
  await effects.dispatchFix!({ prNumber: 9969, taskId: task.id, headSha: "waiting-head", priorStrikes: 0,
    prUrl: "https://github.com/o/r/pull/9969", checksState: "red", mergeState: "clean" } as sweep.OpenPrView,
    { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "assertion failed" }] },
    (phase, wait) => {
      phases.push(phase);
      if (phase === "admission") {
        assert.deepEqual(wait, { sinceMs: NOW - 60000, attempts: 1 });
        controller.abort();
      }
    }, { signal: controller.signal, admissionSinceMs: NOW - 60000 });
  assert.equal(spawned, true);
  assert.deepEqual(phases, ["admission", "worker"]);
});


test("W1-T9969: a fresh process can seed admission age from the abandoned round receipt", async t => {
  const f = fixture(t);
  const since = NOW - 300000;
  f.deps.readLedger = () => [{ task_id: "W1-T9969", step: "fix.done", head_sha: "waiting-head",
    subtype: "admission_abandoned", worker_exit: "not_spawned", admission_since_ms: since }];
  await f.pass();
  assert.equal(f.controls.length, 1);
  assert.equal(f.controls[0].admissionSinceMs, since);
});

test("W1-T9969: cancellation wakes the real admission backoff and removes its listener", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const ports = gate(controller, () => NOW, async () => {});
  delete ports.sleep;
  ports.write = () => { entered(); };
  const result = awaitMemoryAdmission({ workerClass: "fix", root: "/unused", signal: controller.signal }, ports);
  await waiting;
  controller.abort();
  assert.deepEqual(await result, { kind: "abandoned", reason: "admission-abandoned", waitedMs: 0, attempts: 1 });
  assert.equal(waitingStarts().length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("W1-T9969: an error after cancellation cannot become a fail-open admission", async () => {
  const controller = new AbortController();
  const errors: string[] = [];
  const result = await awaitMemoryAdmission({ workerClass: "fix", root: "/unused", signal: controller.signal }, {
    policy: () => { controller.abort(); throw new Error("policy interrupted"); },
    stderr: line => { errors.push(line); },
  });
  assert.deepEqual(result, { kind: "abandoned", reason: "admission-abandoned", waitedMs: 0, attempts: 0 });
  assert.deepEqual(errors, []);
});
