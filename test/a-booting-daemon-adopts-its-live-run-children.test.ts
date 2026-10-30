import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush, setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { daemonBoot, runDaemon, runLanePool, type LanePoolControl } from "#src/lib/daemon.js";
import { adoptRunChildren } from "#src/lib/run-child.js";
import { childIdentity, readSpec, RUN_CHILD_SCHEMA, toRunChildFailure, writeSpec, writeStatus, type RunChildStatus } from "#src/lib/run-child-contract.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { daemonCommand, ledgerPathFor, orphanSweepRunActive, runInChildWhenOn } from "#src/run-task.js";
import { defaultInstance } from "#src/lib/host-memory-ledger.js";
import { captureSelectedRegistryIntent, type SelectedRegistryIntent } from "#src/lib/selected-registry-consumers.js";
import { detachSweepAction } from "#src/lib/sweep.js";
import {
  defaultReadMarkers, killProcessGroup, RUN_ID_ENV, spawnDetachedGroup, sweepOrphanWorkers,
  TASK_ID_ENV, workerInstallationScope, WORKER_SCOPE_ENV,
} from "#src/lib/worker-containment.js";
import { acquireInflightLock, readInflightLock } from "#src/lib/inflight-lock.js";
import { sweepInflightLocksWithReceipts } from "#src/lib/benchmark-run.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import type { RunChildHandle } from "#src/lib/run-child.js";

const { buildChildEntries } = createRequire(import.meta.url)("../scripts/build-child-entries.mjs") as {
  buildChildEntries(options: { root: string; entries: { name: string; source: string }[]; workers: string[] }): Promise<{ sourceHash: string }>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const result = (id: string): RunResult => ({ taskId: id, runId: id, merged: false, verdict: "no_pr", costUsd: 0 });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-child-adoption-"));
  const stateRoot = join(root, "state");
  const rows: Array<Record<string, unknown>> = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); };
  const identity = childIdentity(process.pid)!;
  const add = (id: string, over: Partial<RunChildStatus> = {}, taskId = id) => {
    const dir = join(stateRoot, "runs", id);
    writeSpec(dir, { schema: RUN_CHILD_SCHEMA, runId: id, taskId, instance: "fixture", engine: { sha: "abc", sourceHash: "hash" },
      planSnapshotPath: join(stateRoot, "plan.json"), reservationId: "", options: {} });
    const status: RunChildStatus = { schema: RUN_CHILD_SCHEMA, runId: id, identity, engineSha: "abc", entryKind: "bundle",
      phase: "implement", heartbeatAt: Date.now(), state: "running", ...over };
    writeStatus(dir, status);
    return { dir, status };
  };
  const adopt = () => adoptRunChildren({ stateRoot, instance: "fixture", log,
    settledRunIds: new Set(rows.filter((r) => r.step === "run_child.settled").map((r) => String(r.run_id))) }, { pollMs: 5, watch: false });
  return { root, stateRoot, rows, log, add, adopt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("selected child admission fallback preserves shadow intent and owner holds", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const text = (name = "fixture") => `instances:\n  ${name}:\n    github_repo: owner/repo\n    mode: shadow\n    state_dir: /private/registry-material-sentinel\n`;
  const path = join(f.root, "private-selected.yaml"), other = join(f.root, "other.yaml");
  writeFileSync(path, text()); writeFileSync(other, text("other"));
  const settings = { mode: "shadow" as const, registryPath: path, instanceName: "fixture" };
  const config = { root: f.root, selectedRegistryMode: settings } as Parameters<typeof runInChildWhenOn>[0]["config"];
  const input: Parameters<typeof runInChildWhenOn>[0] = { taskId: "W1-T9796", config, repoDir: f.root,
    allowStale: false, options: { owner: "human" }, planSync: async () => ({ plan: { tasks: [], byId: new Map() }, staleDispatch: false }),
    log: f.log };
  const receipts = () => f.rows.filter(row => row.step === "instance_registry.consumer_shadow_observed");
  const supplied = captureSelectedRegistryIntent({ settings });
  input.options.selectedRegistryIntent = supplied;
  let captured: SelectedRegistryIntent | undefined;
  let invoked = false;
  input.onSelectedRegistryIntent = intent => { invoked = true; captured = intent; };
  assert.equal(await runInChildWhenOn(input, { readMode: () => "on", spawn: async forwarded => {
    assert.equal(forwarded.options.selectedRegistryIntent?.kind, "shadow");
    assert.equal(forwarded.options.owner, "human");
    assert.equal(invoked, true, "the daemon fallback callback runs before admission yields");
    assert.equal(captured, forwarded.options.selectedRegistryIntent);
    assert.ok(captured?.kind === "shadow" && captured.input.expectedDigest);
    assert.ok(Object.isFrozen(captured));
    assert.ok(Object.isFrozen(captured.input));
    writeFileSync(path, text("changed-during-admission")); settings.registryPath = other;
    return { started: false, reason: "fixture startup failed" };
  } }), undefined);
  assert.equal(receipts().at(-1)?.selected_state, "unknown");
  assert.ok(captured?.kind === "shadow");
  assert.equal(captured.input.configuredPath, path);
  assert.equal(input.options.selectedRegistryIntent, supplied, "caller transport remains untouched");
  assert.equal(captured.input.expectedDigest, createHash("sha256").update(text()).digest("hex"));
  for (const value of [undefined, { version: 1, kind: "unknown" } as const]) {
    input.options.selectedRegistryIntent = value;
    invoked = false;
    assert.equal(await runInChildWhenOn(input, { readMode: () => "off" }), undefined);
    assert.equal(invoked, true);
    assert.deepEqual(captured, value, "explicit absence and unknown never borrow global shadow config");
  }
  input.mayRunInProcess = () => false;
  await assert.rejects(runInChildWhenOn(input, { readMode: () => "off" }), /cannot run in-process/);
  assert.equal(receipts().at(-1)?.legacy_outcome, "threw");
});

test("selected registry shadow intent survives actual trusted child transport - daemon fallback", async t => {
  const f = fixture(); t.after(f.cleanup);
  const shim = ghShim([{ when: "", exit: 1, stderr: "fixture GitHub unavailable" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldHome = process.env.HOME, oldPath = process.env.PATH;
  process.env.HOME = f.root; process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  });
  const selected = join(f.root, "selected.yaml"), plan = join(f.root, "tasks.yaml");
  writeFileSync(selected, "instances:\n  fixture:\n    github_repo: owner/repo\n    mode: shadow\n");
  writeFileSync(plan, "[]\n");
  mkdirSync(join(f.root, ".config/remudero"), { recursive: true });
  writeFileSync(join(f.root, ".config/remudero/config.json"), JSON.stringify({ root: f.root, claudeBin: "/bin/true",
    selectedRegistryMode: { mode: "shadow", registryPath: selected, instanceName: "fixture" } }));
  for (const mode of ["on", "off"] as const) {
    let runs = 0;
    assert.equal(await daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], {
      readRunChildMode: () => mode, checkStop: () => undefined, checkPause: () => undefined,
      startGithubAppRefresh: () => ({ armed: false }),
      runTask: async (_taskId, opts) => {
        runs++;
        const intent = opts?.selectedRegistryIntent;
        assert.ok(intent?.kind === "shadow", "real daemon fallback receives dispatch's qualified intent");
        assert.equal(intent.input.configuredPath, selected); assert.ok(intent.input.expectedDigest);
        assert.ok(Object.isFrozen(intent));
        return result("A");
      },
      runDaemon: async (_plan, deps) => {
        await deps.runOne("A");
        return { attempted: ["A"], merged: [], costUsd: 0, ticks: 1, stopReason: "max_reached" };
      },
    }), 0);
    assert.equal(runs, 1);
  }
});

test("W1-T9086: a boot adopts a live child before the boot gate", async () => {
  const f = fixture();
  try {
    const child = f.add("A");
    const path = join(f.root, "tasks.yaml");
    writeFileSync(path, ["A", "B"].map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
    let stop = false;
    const sweep = deferred<void>();
    const started: string[] = [];
    const run = runDaemon(loadPlan(path), {
      adoptRunChildren: f.adopt, refreshMerged: () => () => false, openPrCount: () => 0,
      checkStop: () => stop ? "done" : undefined,
      sweep: () => sweep.promise, gardens: [() => ({ stop() {} })],
      runOne: async (id) => { started.push(id); return result(id); },
      log: (step, fields) => { f.log(step, fields); if (step === "dispatch.settled_set") { stop = true; sweep.resolve(); } },
      sleep: async () => { await delay(1); },
    }, { laneCount: 2, wipLimit: 1, pollIntervalMs: 5 });
    await flush();
    assert.equal(f.rows.filter((r) => r.step === "run_child.adopted").length, 1);
    assert.equal(f.rows.some((r) => r.step === "daemon.boot_gate.opened"), false);
    assert.deepEqual(started, []);
    writeStatus(child.dir, { ...child.status, state: "done", result: result("A") });
    await run;
    sweep.resolve();
    assert.deepEqual(started, []);
    assert.equal(f.rows.filter((r) => r.step === "run_child.settled").length, 1);
  } finally { f.cleanup(); }
});

test("W1-T9086: a terminal child settles once and a lost one takes the crash path", async () => {
  const f = fixture();
  try {
    f.add("terminal", { state: "done", result: result("terminal") });
    f.add("lost", { identity: { ...childIdentity(process.pid)!, startTicks: "reused" } });
    const first = f.adopt();
    const outcomes = await Promise.allSettled(first.map((c) => c.settled));
    first.forEach((child, i) => { child.acknowledge!(outcomes[i]); child.acknowledge!(outcomes[i]); });
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
    assert.equal(f.rows.filter((r) => r.step === "run_child.lost").length, 1);
    assert.equal(f.rows.filter((r) => r.step === "run_child.settled").length, 2);
    assert.deepEqual(f.adopt(), []);
  } finally { f.cleanup(); }
});

test("terminal error round-trip regressions exercise the real run-child writer and settler", async () => {
  const f = fixture();
  const repo = gitRepo();
  try {
    let original: unknown;
    try { execFileSync("git", ["-C", repo.dir, "log", "-1", "--format=%H"], { maxBuffer: 8, encoding: "utf8" }); }
    catch (error) { original = error; }
    assert.ok(original instanceof Error);
    assert.equal((original as NodeJS.ErrnoException).code, "ENOBUFS");
    f.add("terminal-error", { state: "failed", failure: toRunChildFailure(original) });
    f.add("done-without-result", { state: "done" });
    f.add("still-running-gone", { identity: { ...childIdentity(process.pid)!, startTicks: "reused" } });
    const children = f.adopt();
    const outcomes = await Promise.allSettled(children.map(child => child.settled));
    const failure = outcomes[children.findIndex(child => child.runId === "terminal-error")];
    assert.ok(failure.status === "rejected");
    assert.equal(failure.reason.name, original.name);
    assert.equal(failure.reason.message, original.message, "an authenticated terminal Error must not become a lost-child message");
    assert.equal(failure.reason.code, "ENOBUFS");
    assert.deepEqual(f.rows.filter(row => row.step === "run_child.lost").map(row => row.run_id).sort(), ["done-without-result", "still-running-gone"]);
    children.forEach((child, i) => child.acknowledge!(outcomes[i]));
    assert.equal(f.rows.filter(row => row.step === "run_child.settled").length, 3);
    assert.deepEqual(f.adopt(), []);
  } finally { repo.cleanup(); f.cleanup(); }
});

test("an adopted live child keeps its occupied lane when its task left the current plan", async () => {
  const f = fixture();
  try {
    const child = f.add("retired-run", {}, "retired-task");
    const path = join(f.root, "tasks.yaml");
    writeFileSync(path, "[]\n");
    let stop = false;
    let finished = false;
    const run = runDaemon(loadPlan(path), {
      adoptRunChildren: f.adopt, refreshMerged: () => () => false,
      checkStop: () => stop ? "done" : undefined,
      runOne: async () => assert.fail("an adopted child must never be dispatched again"),
      log: (step, fields) => { f.log(step, fields); if (step === "dispatch.settled_set") stop = true; },
      sleep: async () => { await delay(1); },
    }, { laneCount: 1, pollIntervalMs: 5 });
    void run.then(() => { finished = true; });
    await flush();
    assert.equal(f.rows.filter((row) => row.step === "run_child.adopted").length, 1);
    assert.equal(finished, false, "the occupied child keeps the otherwise empty daemon pass open");
    writeStatus(child.dir, { ...child.status, state: "done", result: result("retired-task") });
    const outcome = await run;
    assert.deepEqual(outcome.attempted, [], "adoption is not a fresh dispatch attempt");
    const settled = f.rows.filter((row) => row.step === "run_child.settled");
    assert.equal(settled.length, 1);
    assert.equal(settled[0].task_id, "retired-task");
    assert.deepEqual(f.rows.find((row) => row.step === "dispatch.settled_set")!.tasks,
      [{ id: "retired-task", status: "fulfilled" }], "the occupied lane retains the removed task's identity");
  } finally { f.cleanup(); }
});

test("W1-T9086: a restart under mode on exits without waiting on child lanes", async () => {
  const f = fixture();
  const drain = deferred<void>();
  const childA = deferred<RunResult>();
  const childB = deferred<RunResult>();
  const childC = deferred<RunResult>();
  let run: ReturnType<typeof runDaemon> | undefined;
  let stop = false;
  try {
    const path = join(f.root, "tasks.yaml");
    writeFileSync(path, ["A", "B", "C"].map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
    let now = Date.now();
    let stale = false;
    const started: string[] = [];
    detachSweepAction(drain.promise, { actionKind: "fix-dispatch", taskId: "review", phase: "worker" });
    run = runDaemon(loadPlan(path), {
      refreshMerged: () => () => false,
      checkStop: () => stop ? "cleanup" : undefined,
      checkFreshness: () => stale ? { stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40), installNeeded: false,
        changes: [{ sha: "b".repeat(40), subject: "fix(daemon): reload", files: ["src/lib/daemon.ts"] }] } : { stale: false },
      now: () => new Date(now), sleep: async () => { now += 3_600_000; await delay(1); },
      // W1-T9089: under a decided restart only a refill the run-child policy runs as a child starts.
      refillRunsAsChild: () => true,
      runOne: (id, options) => {
        started.push(id);
        assert.equal("restartAtWorkerBoundary" in options!, false, "W1-T9089: a restart never reaches into a run");
        const settled = id === "A" ? childA.promise : id === "B" ? childB.promise : childC.promise;
        options!.onChild!({ started: true, runId: id, dir: f.root, pid: process.pid, settled,
          abort: async () => { throw new Error("freshness must never abort a child"); } });
        return settled;
      }, log: f.log,
    }, { laneCount: 2, pollIntervalMs: 5 });
    const until = async (ready: () => boolean) => {
      for (let i = 0; i < 1000 && !ready(); i++) await delay(2);
      assert.equal(ready(), true, "expected daemon transition");
    };
    await until(() => started.length === 2);
    stale = true;
    await until(() => f.rows.some((r) => r.step === "daemon.freshness_drain.started"));
    childB.resolve(result("B"));
    await until(() => started.includes("C"));
    assert.equal(f.rows.some((r) => r.step === "daemon.freshness_exit"), false);
    drain.resolve();
    const summary = await run;
    assert.equal(summary.stopReason, "stale");
    assert.deepEqual(f.rows.find((r) => r.step === "daemon.freshness_exit")?.children_left_running, ["A", "C"]);
    assert.equal(f.rows.some((r) => r.step === "daemon.restart_yield_asked"), false);
    assert.deepEqual(started, ["A", "B", "C"]);
  } finally {
    stop = true;
    drain.resolve();
    childA.resolve(result("A")); childB.resolve(result("B")); childC.resolve(result("C"));
    await run;
    f.cleanup();
  }
});

test("W1-T9086: the orphan sweep leaves an adopted child worker alone", async () => {
  const f = fixture();
  try {
    const child = f.add("A");
    const adopted = f.adopt();
    const lock = acquireInflightLock(join(f.stateRoot, "inflight"), "A", { run_id: "A" });
    const swept = sweepInflightLocksWithReceipts(join(f.stateRoot, "inflight"), join(f.stateRoot, "ledger.ndjson"));
    assert.deepEqual(swept.live, ["A"]);
    assert.equal(readInflightLock(join(f.stateRoot, "inflight"), "A")!.run_id, "A");
    const active = orphanSweepRunActive("new-daemon", join(f.stateRoot, "inflight"), () => false, new Set(adopted.map((c) => c.runId)));
    assert.equal(active("A"), true);
    assert.equal(active("stray"), false);
    const killed: number[] = [];
    const report = sweepOrphanWorkers({
      listCandidates: () => [{ pid: 101, cmdline: "worker" }, { pid: 102, cmdline: "stray" }],
      readMarkers: (pid) => ({ runId: pid === 101 ? "A" : "stray", taskId: "A" }),
      isRunActive: active, kill: (pid) => { killed.push(pid); }, ledger: () => {},
    });
    assert.deepEqual(killed, [102]);
    assert.deepEqual(report.leftAlone, [{ pid: 101, reason: "run_active" }]);
    writeStatus(child.dir, { ...child.status, state: "done", result: result("A") });
    await adopted[0].settled;
    lock.release();
  } finally { f.cleanup(); }
});

test("an occupied pool lane settles without dispatching or consulting admission", async () => {
  const slot = deferred<RunResult>();
  const tasks = [{ id: "A" }];
  const lanes = { inFlight: 0 };
  const control: LanePoolControl<RunResult> = { occupied: new Map([["A", slot.promise]]) };
  const pool = runLanePool(tasks, async () => { throw new Error("must not dispatch"); }, () => undefined, lanes,
    () => { throw new Error("must not admit"); }, undefined, control);
  assert.equal(lanes.inFlight, 1);
  slot.resolve(result("A"));
  assert.deepEqual((await pool).settled, [{ status: "fulfilled", value: result("A") }]);
  assert.equal(lanes.inFlight, 0);
});

test("a child is detached only after in-process fallback lanes drain", async () => {
  const child = deferred<RunResult>();
  const fallback = deferred<RunResult>();
  const tasks = [{ id: "child" }, { id: "fallback" }];
  const control: LanePoolControl<RunResult> = { occupied: new Map([["child", child.promise]]) };
  const lanes = { inFlight: 0 };
  let settled = false;
  const pool = runLanePool(tasks, () => fallback.promise, () => { throw new Error("exit must not refill"); }, lanes,
    () => true, undefined, control);
  void pool.then(() => { settled = true; });
  control.detach!((id) => id === "child");
  await flush();
  assert.equal(settled, false);
  assert.equal(lanes.inFlight, 2);
  fallback.resolve(result("fallback"));
  const outcome = await pool;
  assert.equal(outcome.settled[0], undefined);
  assert.deepEqual(outcome.settled[1], { status: "fulfilled", value: result("fallback") });
  assert.equal(lanes.inFlight, 0);
  child.resolve(result("child"));
  await flush();
  assert.equal(outcome.settled[0], undefined);
  assert.equal(lanes.inFlight, 0);
});

test("adoption rejects dead generations as an outside kill that ends only its lane", async () => {
  // W1-T10001: a generation gone with its container took the child, not the pass; the daemon goes on instead of ending in error.
  const f = fixture();
  try {
    f.add("A", { identity: { ...childIdentity(process.pid)!, containerGeneration: { containerId: "old", initStart: "old" } } });
    const path = join(f.root, "tasks.yaml");
    writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n");
    const outcome = await runDaemon(loadPlan(path), {
      adoptRunChildren: f.adopt, refreshMerged: () => () => false, log: f.log,
      checkStop: () => (f.rows.some((r) => r.step === "run_child.settled") ? "STOP requested: test over" : undefined),
      sleep: async () => {}, runOne: async () => { throw new Error("must not dispatch"); },
    }, { laneCount: 1, pollIntervalMs: 5 });
    assert.notEqual(outcome.stopReason, "error");
    assert.equal(f.rows.filter((r) => r.step === "run_child.lost").length, 1);
    const settled = f.rows.find((r) => r.step === "run_child.settled")!;
    assert.equal(settled.outcome, "rejected");
    assert.match(String(settled.reason), /run child A lost: status names container old/);
    assert.equal(settled.loss, "container_stop");
    assert.deepEqual(f.adopt(), []);
  } finally { f.cleanup(); }
});

test("detaching a status watch leaves its result for the next boot", async () => {
  const f = fixture();
  try {
    const child = f.add("A");
    const input = { stateRoot: f.stateRoot, instance: "fixture", settledRunIds: new Set<string>(), log: f.log };
    const first = adoptRunChildren(input)[0];
    first.detach!();
    writeStatus(child.dir, { ...child.status, state: "done", result: result("A") });
    const second = adoptRunChildren(input)[0];
    const outcome = await second.settled;
    assert.equal(f.rows.some((r) => r.step === "run_child.settled"), false);
    second.acknowledge!({ status: "fulfilled", value: outcome });
    assert.equal(f.rows.filter((r) => r.step === "run_child.settled").length, 1);
  } finally { f.cleanup(); }
});

test("two completed runs of the same task each settle by run id", async () => {
  const f = fixture();
  try {
    f.add("run-A-1", { state: "done", result: result("A") }, "A");
    f.add("run-A-2", { state: "done", result: result("A") }, "A");
    const path = join(f.root, "tasks.yaml");
    writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n");
    let stop = false;
    await runDaemon(loadPlan(path), {
      adoptRunChildren: f.adopt, refreshMerged: () => () => false,
      checkStop: () => stop ? "done" : undefined,
      log: (step, extra) => { f.log(step, extra); if (step === "dispatch.settled_set") stop = true; },
      sleep: async () => {}, runOne: async () => { throw new Error("must not dispatch"); },
    }, { laneCount: 1, pollIntervalMs: 5 });
    assert.deepEqual(f.rows.filter((r) => r.step === "run_child.settled").map((r) => r.run_id), ["run-A-1", "run-A-2"]);
    assert.deepEqual(f.adopt(), []);
  } finally { f.cleanup(); }
});

test("a failed restart preparation reports its reason without waiting for a child", async () => {
  const f = fixture();
  try {
    f.add("A");
    const path = join(f.root, "tasks.yaml");
    writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n");
    let now = Date.now();
    let stale = false;
    const outcome = await runDaemon(loadPlan(path), {
      adoptRunChildren: f.adopt, refreshMerged: () => () => false, log: f.log,
      checkFreshness: () => stale ? { stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40), installNeeded: true,
        changes: [{ sha: "b".repeat(40), files: ["package-lock.json"] }] } : { stale: false },
      runInstall: () => { throw new Error("install refused"); },
      now: () => new Date(now), sleep: async () => { stale = true; now += 3_600_000; await delay(1); },
      runOne: async () => { throw new Error("must not dispatch"); },
    }, { laneCount: 1, pollIntervalMs: 5 });
    assert.equal(outcome.stopReason, "error");
    assert.match(outcome.stopDetail!, /freshness_drain: install refused/);
    assert.equal(f.rows.some((r) => r.step === "run_child.settled"), false);
  } finally { f.cleanup(); }
});

test("an unreadable child identity is reported instead of adopted as live", () => {
  const f = fixture();
  try {
    f.add("A", { identity: { ...childIdentity(process.pid)!, startTicks: "unknown" } });
    assert.deepEqual(f.adopt(), []);
    assert.equal(f.rows[0].step, "run_child.adoption_unreadable");
    assert.match(String(f.rows[0].reason), /recorded start ticks are unknown/);
  } finally { f.cleanup(); }
});

test("daemonCommand adopts before the boot lock sweep and reads settlement receipts on its next boot", async () => {
  const f = fixture();
  const oldHome = process.env.HOME;
  try {
    mkdirSync(join(f.root, ".config", "remudero"), { recursive: true });
    writeFileSync(join(f.root, ".config", "remudero", "config.json"), JSON.stringify({ root: f.root, claudeBin: "/bin/true" }));
    process.env.HOME = f.root;
    const child = f.add("A");
    const spec = readSpec(child.dir);
    if (!spec.ok) throw new Error(spec.detail);
    writeSpec(child.dir, { ...spec.value, instance: defaultInstance(f.root).name });
    const lock = acquireInflightLock(join(f.stateRoot, "inflight"), "A", { run_id: "A" });
    const path = join(f.root, "tasks.yaml");
    writeFileSync(path, "[]\n");
    const ledgerPath = ledgerPathFor({ root: f.root } as never);
    const archivePath = join(f.stateRoot, "ledger.2026-10-01.ndjson");
    const rows = () => [archivePath, ledgerPath].filter(existsSync).flatMap((path) =>
      readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
    let boot = 0;
    for (const expectedChildren of [1, 0]) {
      const code = await daemonCommand(["--allow-self-target", "--plan", path, "--max", "0"], {
        readRunChildMode: () => "on", checkStop: () => undefined, checkPause: () => undefined,
        daemonBoot: (...args) => {
          assert.equal(rows().filter((row) => row.step === "run_child.adopted").length, 1);
          assert.deepEqual(args[3]!().live, ["A"]);
          boot++;
          return daemonBoot(args[0], args[1]);
        },
        runDaemon: async (_plan, deps) => {
          const children = deps.adoptRunChildren!();
          assert.equal(children.length, expectedChildren);
          if (children.length) {
            writeStatus(child.dir, { ...child.status, state: "done", result: result("A") });
            const value = await children[0].settled;
            children[0].acknowledge!({ status: "fulfilled", value });
          }
          return { attempted: [], merged: [], costUsd: 0, ticks: 0, stopReason: "max_reached" };
        },
      });
      assert.equal(code, 0);
      if (expectedChildren === 1) renameSync(ledgerPath, archivePath);
    }
    assert.equal(boot, 2);
    assert.equal(rows().filter((row) => row.step === "run_child.settled").length, 1);
    lock.release();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    f.cleanup();
  }
});

test("daemonCommand forwards a real spawned child's handle and settles from that child, not the in-process fallback", async () => {
  const f = fixture();
  const repo = gitRepo({ kind: "adoption-cli-repo" });
  const origin = gitRepo({ bare: true, kind: "adoption-cli-origin" });
  const shim = ghShim([{ when: "", exit: 1, stderr: "fixture: GitHub is unavailable" }]);
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  let child: RunChildHandle | undefined;
  try {
    mkdirSync(join(f.root, ".config", "remudero"), { recursive: true });
    writeFileSync(join(f.root, ".config", "remudero", "config.json"), JSON.stringify({ root: f.root, claudeBin: "/bin/true" }));
    process.env.HOME = f.root;
    process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
    mkdirSync(join(repo.dir, "plan"));
    writeFileSync(join(repo.dir, "plan", "tasks.yaml"),
      "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n");
    repo.git("add", "plan/tasks.yaml");
    repo.git("commit", "-qm", "fixture plan");
    repo.addRemote("origin", origin.dir);
    repo.git("push", "-qu", "origin", "main");
    const engine = join(f.root, "engine-build");
    mkdirSync(join(engine, "src"), { recursive: true });
    // A checkout may borrow its install. Exercise that shape even on a host with a real
    // node_modules directory, then give the engine the one-hop canonical link its real
    // trust guard requires. Never relax that guard or copy the shared dependency tree.
    const borrowedModules = join(f.root, "borrowed-node-modules");
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), borrowedModules, "dir");
    symlinkSync(realpathSync(borrowedModules), join(engine, "node_modules"), "dir");
    // Build a bounded entry with the real contract writer, not a worker/provider. The production
    // engine-currency check, spawn, status watcher and CLI runOne wiring remain unmocked.
    const contract = fileURLToPath(new URL("../src/lib/run-child-contract.ts", import.meta.url));
    writeFileSync(join(engine, "src", "run-child-main.ts"), `
import { readSpec, writeStatus, childIdentity, RUN_CHILD_SCHEMA } from ${JSON.stringify(contract)};
const dir = process.argv[process.argv.indexOf("--run-dir") + 1];
const spec = readSpec(dir);
if (!spec.ok) throw new Error(spec.detail);
writeStatus(dir, { schema: RUN_CHILD_SCHEMA, runId: spec.value.runId, identity: childIdentity(process.pid),
  engineSha: spec.value.engine.sha, entryKind: "bundle", phase: "implement", heartbeatAt: Date.now(), state: "done",
  result: { taskId: spec.value.taskId, runId: spec.value.runId, merged: false, verdict: "no_pr", costUsd: 0 } });
`);
    const built = await buildChildEntries({ root: engine, entries: [{ name: "run-child", source: "src/run-child-main.ts" }], workers: [] });
    writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha: repo.git("rev-parse", "HEAD"), sourceHash: built.sourceHash, builtAt: Date.now() }));
    mkdirSync(join(f.stateRoot, "engines"), { recursive: true });
    renameSync(engine, join(f.stateRoot, "engines", built.sourceHash));
    const code = await daemonCommand(["--allow-self-target", "--max", "0"], {
      repoRoot: repo.dir, readRunChildMode: () => "on",
      checkStop: () => undefined, checkPause: () => undefined,
      startGithubAppRefresh: () => ({ armed: false }),
      daemonBoot: (log, env) => daemonBoot(log, env),
      runTask: async () => assert.fail("a spawned child must not fall through to runTask"),
      runDaemon: async (_plan, deps) => {
        let forwarded = 0;
        const value = await deps.runOne("A", {
          onChild: (handle) => { forwarded++; child = handle; } });
        assert.equal(forwarded, 1, "the actual daemonCommand closure must forward the full handle exactly once");
        assert.ok(child?.started);
        assert.equal(value, await child.settled, "runOne returns the child's settlement, not a fabricated result");
        assert.equal(value.taskId, "A");
        assert.equal(value.runId, child.runId);
        assert.notEqual(child.pid, process.pid, "the default spawn really started a separate process");
        assert.equal(typeof child.detach, "function");
        child.acknowledge!({ status: "fulfilled", value });
        return { attempted: ["A"], merged: [], costUsd: 0, ticks: 1, stopReason: "max_reached" };
      },
    });
    assert.equal(code, 0);
  } finally {
    child?.detach?.();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    repo.cleanup(); origin.cleanup();
    rmSync(shim.dir, { recursive: true, force: true });
    f.cleanup();
  }
});

test("daemonCommand's real orphan sweep protects an adopted run without an inflight lock", async () => {
  const f = fixture();
  const shim = ghShim([{ when: "", exit: 1, stderr: "fixture: GitHub is unavailable" }]);
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  let worker: ReturnType<typeof spawnDetachedGroup> | undefined;
  let adopted: ReturnType<typeof adoptRunChildren> = [];
  try {
    mkdirSync(join(f.root, ".config", "remudero"), { recursive: true });
    writeFileSync(join(f.root, ".config", "remudero", "config.json"), JSON.stringify({ root: f.root, claudeBin: "/bin/true" }));
    process.env.HOME = f.root;
    process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
    const child = f.add("A");
    const spec = readSpec(child.dir);
    if (!spec.ok) throw new Error(spec.detail);
    writeSpec(child.dir, { ...spec.value, instance: defaultInstance(f.root).name });
    const path = join(f.root, "tasks.yaml");
    writeFileSync(path, "[]\n");
    // Only this test-owned worker carries this unique temporary installation scope. The real
    // candidate/marker readers and per-poll closure stay wired; no live installation can match it.
    worker = spawnDetachedGroup({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: {
      ...process.env, [RUN_ID_ENV]: "A", [TASK_ID_ENV]: "A", [WORKER_SCOPE_ENV]: workerInstallationScope(f.root),
    } });
    const pid = worker.pid;
    const until = Date.now() + 5_000;
    while (!defaultReadMarkers(pid) && Date.now() < until) await delay(20);
    assert.equal(defaultReadMarkers(pid)?.runId, "A", "positive control: the real marker reader sees the owned worker");
    assert.equal(readInflightLock(join(f.stateRoot, "inflight"), "A"), null,
      "no lock may accidentally protect the adopted run");
    const code = await daemonCommand(["--allow-self-target", "--plan", path, "--max", "0"], {
      readRunChildMode: () => "on", checkStop: () => undefined, checkPause: () => undefined,
      startGithubAppRefresh: () => ({ armed: false }),
      daemonBoot: (log, env) => daemonBoot(log, env),
      runDaemon: async (_plan, deps) => {
        const children = deps.adoptRunChildren!();
        adopted = children;
        assert.deepEqual(children.map((entry) => entry.runId), ["A"]);
        const report = await deps.sweepOrphans!();
        assert.ok(report.leftAlone.some((entry) => entry.pid === pid && entry.reason === "run_active"),
          "the actual per-poll closure must pass the adopted run set to its activity guard");
        assert.deepEqual(report.killed, [], "the exact-scope adopted worker must not be killed");
        assert.doesNotThrow(() => process.kill(pid, 0));
        writeStatus(child.dir, { ...child.status, state: "done", result: result("A") });
        const value = await children[0].settled;
        children[0].acknowledge!({ status: "fulfilled", value });
        return { attempted: [], merged: [], costUsd: 0, ticks: 0, stopReason: "max_reached" };
      },
    });
    assert.equal(code, 0);
  } finally {
    for (const child of adopted) child.detach?.();
    if (worker) killProcessGroup(worker.pid);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    f.cleanup();
  }
});

test("W1-T9924: daemonCommand wires the refill child decision from the run-child mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t9924-cli-"));
  const oldHome = process.env.HOME;
  try {
    mkdirSync(join(root, ".config", "remudero"), { recursive: true });
    writeFileSync(join(root, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
    process.env.HOME = root;
    const path = join(root, "tasks.yaml");
    writeFileSync(path, "[]\n");
    const wired: Array<((task: { id: string }) => boolean) | undefined> = [];
    for (const mode of ["on", "off"] as const) {
      const code = await daemonCommand(["--allow-self-target", "--plan", path, "--max", "0"], {
        readRunChildMode: () => mode, checkStop: () => undefined, checkPause: () => undefined,
        runDaemon: async (_plan, deps) => {
          wired.push(deps.refillRunsAsChild as ((task: { id: string }) => boolean) | undefined);
          return { attempted: [], merged: [], costUsd: 0, ticks: 0, stopReason: "max_reached" };
        },
      } as Parameters<typeof daemonCommand>[1]);
      assert.equal(code, 0);
    }
    assert.equal(typeof wired[0], "function", "child mode wires the decision");
    assert.equal(wired[0]!({ id: "A" }), false, "an explicit --plan keeps the run in-process, as runInChildWhenOn does");
    assert.equal(wired[1], undefined, "with child mode off nothing is wired and the refill reads false");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});
