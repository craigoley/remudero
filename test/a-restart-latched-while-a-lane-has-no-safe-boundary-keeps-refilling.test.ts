// W1-T7806 built a restart latch: a freed lane refilled while an in-flight run had no yield boundary, and each run was
// asked to yield or held out at its next boundary. W1-T9089 (ADR 0007 A.10) retires it: once runs are children a restart
// waits for nothing it does not own. A restart decided mid-phase now holds only a refill that would not run as a child,
// awaits an in-process lane to its end, and never reaches into a run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { daemonCommand, type RunResult } from "../src/run-task.js";

const minute = 60_000;
const stale = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: refresh", files: ["src/lib/daemon.ts", "package.json"] }],
  // W1-T9089: the daemon's own code weighs as any source advance, so a busy restart is decided on staleness pressure.
  staleSinceMs: Date.now() - 120 * minute };
const result = (id: string): RunResult => ({ taskId: id, runId: id, merged: true, verdict: "merged", costUsd: 0 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function phase(history = true, extra: Partial<DaemonDeps> = {}, startingMinute = 0) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t7806-phase-"));
  const path = join(dir, "tasks.yaml");
  const ids = "ABCDEFGHIJKL".split("");
  writeFileSync(path, ids.map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const releases = new Map(ids.map((id) => [id, deferred<RunResult>()]));
  const offered: Array<Record<string, unknown>> = [];
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const started: Array<{ id: string; age: number }> = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const start = Date.now();
  let nowMs = start + startingMinute * minute;
  let isStale = false;
  let cleaning = false;
  const merged = new Set<string>();
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    readLedgerLines: () => history ? [
      JSON.stringify({ step: "run.start", run_id: "observed", ts: new Date(start - 16 * minute).toISOString() }),
      JSON.stringify({ step: "verdict", run_id: "observed", ts: new Date(start).toISOString(), verdict: "merged" }),
    ] : [],
    refreshMerged: () => (id) => merged.has(id),
    checkFreshness: () => isStale ? stale : { stale: false },
    checkStop: () => cleaning ? "cleanup" : undefined,
    log: (step, fields) => rows.push({ step, extra: fields }),
    runOne: (id, options) => {
      started.push({ id, age: nowMs - start });
      offered.push({ ...options });
      return releases.get(id)!.promise;
    },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    ...extra,
  } as DaemonDeps, { freshnessMinLifetimeMs: 0, laneCount: 3, max: 12 });
  return {
    run, started, rows, offered,
    settle: async (id: string, age: number) => {
      nowMs = start + age * minute;
      merged.add(id);
      releases.get(id)!.resolve(result(id));
      await flush();
    },
    tick: async (age: number, staleNow = false) => {
      nowMs = start + age * minute;
      isStale ||= staleNow;
      await flush();
      sleeps.shift()?.resolve();
      await flush();
      await flush();
    },
    cleanup: async () => {
      cleaning = true;
      for (const release of releases.values()) release.resolve(result("cleanup"));
      for (const sleep of sleeps) sleep.resolve();
      await run;
    },
  };
}

async function decide(h: ReturnType<typeof phase>) {
  await flush();
  await h.tick(5, true);
  assert.equal(h.rows.some(({ step, extra }) => step === "daemon.freshness_decision" && extra?.action === "restart"), true);
}

test("W1-T9089: a restart decided mid-phase holds an in-process refill and awaits its lanes", async () => {
  const h = phase();
  try {
    await decide(h);
    await h.settle("B", 6);
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "B", "C"], "no refill starts on the old code in-process");
    assert.equal(h.rows.find(({ step }) => step === "dispatch.lane_refill_held")?.extra?.reason,
      "restart decided: no candidate runs as a child");
    await h.settle("A", 30);
    await h.settle("C", 40);
    assert.equal((await h.run).stopReason, "stale", "the restart fires once its in-process lanes have settled");
    for (const step of ["daemon.restart_yield_asked", "daemon.restart_holdout", "daemon.freshness_restart_waiting", "daemon.restart_latch_cost"]) {
      assert.equal(h.rows.some((row) => row.step === step), false, step);
    }
    for (const options of h.offered) assert.equal("restartAtWorkerBoundary" in options, false);
  } finally { await h.cleanup(); }
});

test("a pending restart keeps the existing pause gate on lane refill", async () => {
  let paused = false;
  const h = phase(true, { checkPause: () => paused ? "operator pause" : undefined });
  try {
    await decide(h);
    paused = true;
    await h.settle("B", 6);
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "B", "C"]);
    assert.equal(h.rows.find(({ step }) => step === "dispatch.lane_refill_held")?.extra?.reason, "pause: operator pause");
  } finally { paused = false; await h.cleanup(); }
});

test("the daemon command threads the recycle reader, never a restart latch, into runTask", async (t) => {
  const fixtureHome = mkdtempSync(join(tmpdir(), "rmd-t7806-wiring-"));
  const root = join(fixtureHome, "Remudero");
  mkdirSync(join(fixtureHome, ".config", "remudero"), { recursive: true });
  writeFileSync(join(fixtureHome, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(fixtureHome, "tasks.yaml");
  writeFileSync(planPath, "- id: D\n  title: fixture\n  repo: widgets\n  type: implement\n  status: queued\n  files: [src/D.ts]\n");
  const originalHomedir = os.homedir;
  t.mock.method(os, "homedir", () => fixtureHome);
  syncBuiltinESMExports();
  t.after(() => { os.homedir = originalHomedir; syncBuiltinESMExports(); });
  let invoked = false;
  const code = await daemonCommand(["--repo", "foreign-owner/widgets", "--plan", planPath, "--max", "0"], {
    runDaemon: async (_plan, deps) => {
      await deps.runOne("D", {});
      return { attempted: ["D"], merged: [], stopReason: "stopped", costUsd: 0, ticks: 1 };
    },
    runTask: async (id, options) => {
      invoked = true;
      assert.equal(id, "D");
      assert.ok(options);
      assert.equal("restartAtWorkerBoundary" in options, false, "W1-T9089: no run reads a daemon restart latch");
      assert.equal(typeof options.externalWaitRecycle, "function", "a recycle still reaches the run");
      return result(id);
    },
  });
  assert.equal(code, 0);
  assert.equal(invoked, true);
});
