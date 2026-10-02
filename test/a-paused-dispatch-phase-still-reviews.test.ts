import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps, type LightPassScope } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { buildSweepLightHook } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean, message: string) {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}

function harness(overrides: Partial<DaemonDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-paused-phase-"));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, ["A", "B"].map((id) => `
- id: ${id}
  title: ${id}
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/${id}.ts]
`).join(""));
  const workers = [deferred<void>(), deferred<void>()];
  const review = deferred<void>();
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const scopes: Array<LightPassScope | undefined> = [];
  const waits: Array<() => void> = [];
  let paused = false;
  let stopped = false;
  let started = 0;
  let fullPasses = 0;
  const daemon = runDaemon(loadPlan(path), {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      started++;
      await workers[id === "A" ? 0 : 1]!.promise;
      return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" };
    },
    sleep: () => new Promise<void>((resolve) => { waits.push(resolve); }),
    checkPause: () => paused ? "recycle pause" : undefined,
    checkStop: () => stopped ? "operator stop" : undefined,
    sweep: async () => { fullPasses++; },
    sweepLight: async (scope) => {
      scopes.push(scope);
      await review.promise;
    },
    log: (step, extra = {}) => { rows.push({ step, extra }); },
    ...overrides,
  }, { max: 2, laneCount: 2, pollIntervalMs: 1, sweepRetriggerIntervalMs: 0 });
  const tick = async () => {
    await eventually(() => waits.length > 0, "ticker never waited");
    waits.splice(0).forEach((resolve) => resolve());
    await settle();
  };
  return {
    daemon, rows, scopes, review, tick,
    ready: () => eventually(() => started === 2, "both dispatch lanes must start"),
    pause: () => { paused = true; },
    stop: () => { stopped = true; },
    fullPasses: () => fullPasses,
    drain: () => workers.forEach((worker) => worker.resolve()),
    cleanup: async () => {
      stopped = true;
      workers.forEach((worker) => worker.resolve());
      review.resolve();
      waits.splice(0).forEach((resolve) => resolve());
      await daemon;
      waits.splice(0).forEach((resolve) => resolve());
      await settle();
    },
  };
}

test("W1-T5343: PAUSE reviews during dispatch and keeps the full sweep held", async () => {
  const h = harness();
  try {
    await h.ready();
    const before = h.fullPasses();
    h.pause();
    await h.tick();
    assert.deepEqual(h.scopes, [{ reviewOnly: true }]);
    assert.equal(h.fullPasses(), before);
    assert.ok(h.rows.some((row) => row.step === "daemon.sweep.retrigger_held"));
    assert.deepEqual(h.rows.filter((row) => row.step === "daemon.sweep_light.review_only").map((row) => row.extra),
      [{ phase: "dispatch", detail: "recycle pause" }]);
    assert.equal(h.rows.some((row) => row.step === "daemon.sweep_light.held"), false);
  } finally { await h.cleanup(); }
});

for (const paused of [false, true]) {
  test(`W1-T5343: STOP holds every dispatch pass${paused ? " even with PAUSE" : ""}`, async () => {
    const h = harness();
    try {
      await h.ready();
      const before = h.fullPasses();
      if (paused) h.pause();
      h.stop();
      await h.tick();
      assert.deepEqual(h.scopes, []);
      assert.equal(h.fullPasses(), before);
      assert.deepEqual(h.rows.filter((row) => row.step === "daemon.sweep_light.held").map((row) => row.extra),
        [{ phase: "dispatch", detail: "operator stop" }]);
      assert.equal(h.rows.some((row) => row.step === "daemon.sweep_light.review_only"), false);
    } finally { await h.cleanup(); }
  });
}

test("W1-T5343: one PAUSE review slot stays occupied until its pass settles", async () => {
  const h = harness();
  try {
    await h.ready();
    h.pause();
    await h.tick();
    assert.equal(h.scopes.length, 1);
    for (let i = 0; i < 3; i++) await h.tick();
    assert.equal(h.scopes.length, 1, "a slow review cannot admit a second pass");
    assert.equal(h.rows.filter((row) => row.step === "daemon.alive" && row.extra.phase === "dispatch").length, 4);
    assert.equal(h.rows.filter((row) => row.step === "daemon.sweep_light.held").length, 3);
    h.review.resolve();
    await settle();
    await h.tick();
    assert.equal(h.scopes.length, 2, "the slot opens when the review settles");
    assert.ok(h.scopes.every((scope) => scope?.reviewOnly === true));
  } finally { await h.cleanup(); }
});

test("W1-T5343: a PAUSE review cannot extend the dispatch lane drain", async () => {
  const h = harness();
  try {
    await h.ready();
    h.pause();
    await h.tick();
    assert.equal(h.scopes.length, 1);
    h.drain();
    let exited = false;
    void h.daemon.then(() => { exited = true; });
    await eventually(() => exited, "dispatch awaited an unresolved review after its lanes drained");
    assert.equal(h.scopes.length, 1);
  } finally { await h.cleanup(); }
});

test("W1-T5343: no PAUSE pass starts after the last lane settles during a ticker await", async () => {
  const probe = deferred<void>();
  let probing = false;
  const h = harness({
    readDiskHeadroom: () => ({ freeBytes: 1, verdict: "FAIL" }),
    onDiskHeadroomBreach: async () => { probing = true; await probe.promise; },
  });
  try {
    await h.ready();
    h.pause();
    await h.tick();
    assert.equal(probing, true);
    h.drain();
    await h.daemon;
    probe.resolve();
    await settle();
    assert.deepEqual(h.scopes, [], "the late ticker must observe empty lanes");
    assert.ok(h.rows.some((row) => row.step === "daemon.sweep_light.held" && /no lane/.test(String(row.extra.detail))));
    assert.equal(h.rows.some((row) => row.step === "daemon.sweep_light.review_only"), false);
  } finally { probe.resolve(); await h.cleanup(); }
});

test("W1-T5343: a failed PAUSE review names its error and releases the slot", async () => {
  let calls = 0;
  const h = harness({ sweepLight: async () => { calls++; throw new Error("review unavailable"); } });
  try {
    await h.ready();
    h.pause();
    await h.tick();
    await h.tick();
    assert.equal(calls, 2);
    assert.equal(h.rows.filter((row) => row.step === "daemon.sweep_light.failed" && row.extra.error === "review unavailable").length, 2);
    assert.equal(h.rows.filter((row) => row.step === "daemon.sweep_light.review_only").length, 2);
    assert.equal(h.rows.some((row) => row.step === "daemon.sweep_light.held"), false);
  } finally { await h.cleanup(); }
});

test("W1-T5343: PAUSE holds a sweep ticker without dispatch lane state and names that absence", async () => {
  const sweep = deferred<void>();
  let sweeping = false;
  const h = harness({ sweep: async () => { sweeping = true; await sweep.promise; } });
  try {
    await eventually(() => sweeping, "the full sweep must start before dispatch");
    h.pause();
    await h.tick();
    assert.deepEqual(h.scopes, []);
    assert.deepEqual(h.rows.filter((row) => row.step === "daemon.sweep_light.held").map((row) => row.extra),
      [{ phase: "sweep", detail: "no dispatch lane state" }]);
  } finally { h.stop(); sweep.resolve(); await h.cleanup(); }
});

test("W1-T5343: an unpaused dispatch retains its ordinary light pass", async () => {
  const h = harness();
  try {
    await h.ready();
    await h.tick();
    assert.deepEqual(h.scopes, [undefined]);
    assert.equal(h.rows.some((row) => row.step === "daemon.sweep_light.review_only"), false);
  } finally { await h.cleanup(); }
});

test("W1-T5343: the dispatch PAUSE scope closes the production fix and requeue rungs", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-paused-light-hook-"));
  const head = { ref: "run-W1-T5343-1", sha: "a".repeat(40) };
  const pr = { number: 5343, html_url: "https://github.com/o/r/pull/5343", state: "open", head };
  const json = JSON.stringify;
  const shim = ghShim([
    { when: "required_status_checks", stdout: json({ contexts: ["ci-gate", "remudero-review"] }) },
    { when: "pulls?state=open", stdout: json([{ ...pr, body: "Remudero-Task: W1-T5343", updated_at: "2026-10-01T12:00:00Z", auto_merge: null }]) },
    { when: "/pulls/5343/files", stdout: "[]" },
    { when: "/pulls/5343", stdout: json({ ...pr, merged_at: null }) },
    { when: "check-runs", stdout: json({ check_runs: [
      { name: "ci-gate", status: "completed", conclusion: "failure" },
      { name: "coverage-ratchet", status: "completed", conclusion: "cancelled", details_url: "https://github.com/o/r/actions/runs/1/job/534300" },
    ] }) },
    { when: "/status", stdout: json({ statuses: [{ context: "remudero-review", state: "success" }] }) },
    { when: "", stdout: "{}" },
  ], { kind: "paused-light-gh" });
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${priorPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const hook = () => buildSweepLightHook(
    "o", "r", { root } as never, join(root, "ledger.ndjson"), "RUN-T5343",
    { tasks: [] } as never, (step, extra) => { logs.push({ step, extra }); },
    { loadedCodeSha: "boot-loaded-sha", isLoadedCodeAtOrAfter: () => false },
  );
  let h: ReturnType<typeof harness> | undefined;
  try {
    await hook()();
    assert.ok(logs.some((row) => row.step === "sweep.check_requeue.dispatched"), "ordinary control reaches the requeue rung");
    assert.ok(shim.calls().some((call) => call.includes("actions/jobs/534300/rerun")));
    const callsBeforePause = shim.calls().length;
    logs.length = 0;
    const completed = deferred<void>();
    const lightPass = hook();
    h = harness({ sweepLight: async (scope) => { await lightPass(scope); completed.resolve(); } });
    await h.ready();
    h.pause();
    await h.tick();
    assert.ok(h.rows.some((row) => row.step === "daemon.sweep_light.review_only"));
    await completed.promise;
    assert.equal(logs.filter((row) => row.step === "sweep.summary").length, 1, "no requeue batch forms");
    assert.equal(logs.some((row) => row.step === "sweep_light.error"), false);
    assert.equal(logs.some((row) => row.step === "sweep.check_requeue.dispatched" || row.step === "sweep.fix.dispatched"), false);
    assert.equal(shim.calls().slice(callsBeforePause).some((call) => call.includes("/rerun") || call.includes("update-branch")), false);
  } finally {
    if (h) await h.cleanup();
    process.env.PATH = priorPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
