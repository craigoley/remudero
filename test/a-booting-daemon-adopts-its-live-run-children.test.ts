import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush, setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { daemonBoot, runDaemon, runLanePool, type LanePoolControl } from "../src/lib/daemon.js";
import { adoptRunChildren } from "../src/lib/run-child.js";
import { childIdentity, readSpec, RUN_CHILD_SCHEMA, writeSpec, writeStatus, type RunChildStatus } from "../src/lib/run-child-contract.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { daemonCommand, ledgerPathFor, orphanSweepRunActive } from "../src/run-task.js";
import { defaultInstance } from "../src/lib/host-memory-ledger.js";
import { detachSweepAction } from "../src/lib/sweep.js";
import { sweepOrphanWorkers } from "../src/lib/worker-containment.js";
import { acquireInflightLock, readInflightLock } from "../src/lib/inflight-lock.js";
import { sweepInflightLocksWithReceipts } from "../src/lib/benchmark-run.js";

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
    const boundaries: Array<() => unknown> = [];
    detachSweepAction(drain.promise, { actionKind: "fix-dispatch", taskId: "review", phase: "worker" });
    run = runDaemon(loadPlan(path), {
      refreshMerged: () => () => false,
      checkStop: () => stop ? "cleanup" : undefined,
      checkFreshness: () => stale ? { stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40), installNeeded: false,
        changes: [{ sha: "b".repeat(40), subject: "fix(daemon): reload", files: ["src/lib/daemon.ts"] }] } : { stale: false },
      now: () => new Date(now), sleep: async () => { now += 3_600_000; await delay(1); },
      runOne: (id, options) => {
        started.push(id);
        boundaries.push(() => options!.restartAtWorkerBoundary());
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
    assert.equal(boundaries[0](), undefined);
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

test("adoption rejects dead generations through the daemon's crash classification", async () => {
  const f = fixture();
  try {
    f.add("A", { identity: { ...childIdentity(process.pid)!, containerGeneration: { containerId: "old", initStart: "old" } } });
    const path = join(f.root, "tasks.yaml");
    writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n");
    const outcome = await runDaemon(loadPlan(path), {
      adoptRunChildren: f.adopt, refreshMerged: () => () => false, log: f.log,
      sleep: async () => {}, runOne: async () => { throw new Error("must not dispatch"); },
    }, { laneCount: 1, pollIntervalMs: 5 });
    assert.equal(outcome.stopReason, "error");
    assert.match(outcome.stopDetail!, /run child A lost: status names container old/);
    assert.equal(f.rows.filter((r) => r.step === "run_child.lost").length, 1);
    assert.equal(f.rows.find((r) => r.step === "run_child.settled")!.outcome, "rejected");
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
