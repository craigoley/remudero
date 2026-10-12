import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { runDaemon, type DaemonDeps, type DaemonFreshness } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { daemonCommand, runTask, type RunResult } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

const minute = 60_000;
const stale = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: refresh", files: ["src/lib/daemon.ts", "package.json"] }] };
type BoundaryOptions = { restartAtWorkerBoundary: () => Extract<DaemonFreshness, { stale: true }> | undefined };
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
  const boundaries = new Map<string, BoundaryOptions>();
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
    runOne: (id: string, options?: BoundaryOptions) => {
      started.push({ id, age: nowMs - start });
      if (options) boundaries.set(id, options);
      return releases.get(id)!.promise;
    },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    ...extra,
  } as DaemonDeps, { laneCount: 3, max: 12 });
  return {
    run, started, rows, boundaries,
    boundary: (id: string) => {
      const options = boundaries.get(id);
      assert.ok(options, "the daemon supplies its live restart to every run");
      return options.restartAtWorkerBoundary();
    },
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

async function latch(h: ReturnType<typeof phase>) {
  await flush();
  await h.tick(5, true);
  assert.equal(h.rows.some(({ step, extra }) => step === "daemon.freshness_decision" && extra?.action === "restart"), true);
}

test("W1-T7806: a freed lane refills while a young lane has no yield boundary since the latch", async () => {
  const h = phase(true, {}, 3);
  try {
    await latch(h);
    assert.equal(h.rows.find(({ step }) => step === "dispatch.refill_bound")?.extra?.bound_ms, 16 * minute);
    await h.settle("B", 6);
    await h.settle("C", 8);
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "B", "C", "D", "E"]);
    assert.deepEqual(h.rows.filter(({ step }) => step === "dispatch.lane_refilled").map(({ extra }) => extra?.waiting_on),
      [["A", "C"], ["A"]]);
    await h.tick(10);
    const lanes = h.rows.findLast(({ step }) => step === "daemon.freshness_restart_waiting")?.extra?.lanes;
    assert.deepEqual(lanes, [
      { task: "A", age_ms: 7 * minute, holdout: true, admitted_under_latch: false },
      { task: "D", age_ms: 4 * minute, holdout: false, admitted_under_latch: true },
      { task: "E", age_ms: 2 * minute, holdout: false, admitted_under_latch: true },
    ]);
  } finally { await h.cleanup(); }
});

test("W1-T7806: refill stays open under a latch with no run history", async () => {
  const h = phase(false, {}, 3);
  try {
    await latch(h);
    assert.equal(h.rows.find(({ step }) => step === "dispatch.refill_bound")?.extra?.source, "no_history_fallback");
    await h.settle("B", 6);
    await h.settle("C", 8);
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "B", "C", "D", "E"]);
  } finally { await h.cleanup(); }
});

function worker(text: string, isError = false): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "",
    subtype: isError ? "error_max_turns" : "success",
    isError, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

/** Drives the REAL runTask for task D through its first implement worker to the first worker boundary. */
async function boundaryRun(t: TestContext, restartAtWorkerBoundary: BoundaryOptions["restartAtWorkerBoundary"] | undefined,
  ownRead: () => Extract<DaemonFreshness, { stale: true }> | undefined) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t7806-boundary-"));
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.addRemote("origin", origin.dir);
  seed.git("push", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repo = gitRepo({ cloneFrom: origin.dir });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@remudero.invalid");
  renameSync(repo.dir, join(root, "repos", "remudero"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- id: D\n  title: boundary fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  origin: test\n  status: queued\n  files: [src/D.ts]\n");
  const githubStub = ghShim([{ when: "pr create", stdout: "https://github.com/acme/remudero/pull/1" }]);
  const priorPath = process.env.PATH;
  process.env.PATH = `${githubStub.dir}:${priorPath}`;
  t.after(() => { process.env.PATH = priorPath; });
  let calls = 0;
  let gates = 0;
  const options: NonNullable<Parameters<typeof runTask>[1]> & Partial<BoundaryOptions> = {
    config: { claudeBin: "/bin/true", root, installRoot: process.cwd(), workerProviders: { harnessCommitsImplement: true } },
    skipGitSync: true, planPath,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "boundary-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    restartAtWorkerBoundary,
    externalWaitFreshness: ownRead,
    spawn: async (args) => {
      if (++calls === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      if (calls > 2) return worker("fixture stops after reaching the preopen gate", true);
      mkdirSync(join(args.cwd, "src"), { recursive: true });
      writeFileSync(join(args.cwd, "src/D.ts"), "export const value = 42;\n");
      return worker("REPORT\nCOMMIT_MESSAGE: fix(test): retain boundary work\n");
    },
    preopenGate: async () => { gates++; return { kind: "fail", failedSteps: ["fixture"], durationMs: 1 }; },
  };
  const outcome = await withLiveWritesAllowed(() => runTask("D", options));
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { outcome, calls, gates, rows };
}

test("W1-T7806: a refill admitted under the latch yields at its first boundary", async (t) => {
  const h = phase(true, {}, 3);
  try {
    await latch(h);
    await h.settle("B", 6);
    const latchRead = h.boundaries.get("D")?.restartAtWorkerBoundary;
    assert.equal(typeof latchRead, "function");
    // The run's own read reports fresh: only the daemon's latch can yield this boundary.
    const { outcome, calls, gates, rows } = await boundaryRun(t, latchRead, () => undefined);
    assert.equal(outcome.verdict, "handed_off");
    assert.equal(outcome.prUrl, undefined);
    assert.equal(calls, 2);
    assert.equal(gates, 0, "the first worker boundary yields before the preopen gate");
    assert.equal(rows.find(({ step }) => step === "run.freshness_handoff")?.new_sha, stale.newSha);
    assert.equal(rows.find(({ step }) => step === "verdict")?.reason, "freshness_yield");
    assert.equal(h.boundary("A"), stale);
    assert.equal(h.boundary("C"), stale);
    const count = h.started.length;
    await h.settle("D", 7);
    assert.equal(h.started.length, count, "the refill cannot renew the hold");
  } finally { await h.cleanup(); }
});

test("W1-T8198: a clear latch reaches the preopen gate without reading its own freshness", async (t) => {
  const ownStale = { ...stale, newSha: "c".repeat(40) };
  let ownReads = 0;
  const { outcome, calls, gates, rows } = await boundaryRun(t, () => undefined, () => {
    ownReads++;
    return ownStale;
  });
  assert.equal(gates, 1, "the clear latch lets the first worker boundary reach the preopen gate");
  assert.equal(calls, 3, "the run continues to the injected gate repair worker");
  assert.equal(outcome.verdict, "failed", "the injected repair worker stops the fixture");
  assert.equal(ownReads, 0, "a daemon run never falls back to its own freshness read");
  assert.equal(rows.some(({ step }) => step === "run.freshness_handoff"), false);
  assert.equal(rows.some(({ step, reason }) => step === "verdict" && reason === "freshness_yield"), false);
});

test("W1-T7806: refill closes as stale code once every holdout can yield", async () => {
  const h = phase();
  try {
    await flush();
    assert.equal(h.boundary("A"), undefined, "a boundary before the latch does not release a future holdout");
    await latch(h);
    await h.settle("B", 6);
    await h.settle("C", 8);
    assert.equal(h.boundary("D"), stale, "a refill reads the latch without joining the holdouts");
    await h.settle("D", 9);
    assert.equal(h.started.at(-1)?.id, "F", "A still has no post-latch boundary");
    assert.equal(h.boundary("A"), stale);
    assert.equal(h.boundary("A"), stale, "repeated boundaries do not renew the hold");
    const count = h.started.length;
    await h.settle("E", 10);
    await h.settle("F", 11);
    assert.equal(h.started.length, count, "A is still in flight, but every holdout can yield");
    assert.equal(h.rows.some(({ step, extra }) => step === "dispatch.lane_refill_held" && extra?.reason === "stale code"), true);
    await h.settle("A", 12);
    assert.equal((await h.run).stopReason, "stale");
  } finally { await h.cleanup(); }
});

test("W1-T7806: a holdout that settles stops holding refill", async () => {
  const h = phase();
  try {
    await latch(h);
    await h.settle("B", 6);
    await h.settle("C", 8);
    await h.settle("A", 9);
    const count = h.started.length;
    await h.settle("D", 10);
    await h.settle("E", 11);
    assert.equal(count, 5);
    assert.equal(h.started.length, count, "settlement also drains the holdout set");
    assert.equal((await h.run).stopReason, "stale");
  } finally { await h.cleanup(); }
});

test("a refill read finishing after the last holdout's boundary starts no run", async () => {
  const read = deferred<string>();
  let blockRead = false;
  let reading = false;
  const h = phase(true, { readPushedRunBranches: () => {
    if (!blockRead) return "";
    reading = true;
    return read.promise;
  } });
  try {
    await latch(h);
    assert.equal(h.boundary("C"), stale);
    blockRead = true;
    await h.settle("B", 6);
    assert.equal(reading, true, "the refill is awaiting its own branch read");
    assert.equal(h.boundary("A"), stale);
    read.resolve("");
    await flush();
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "B", "C"]);
    assert.equal(h.rows.find(({ step }) => step === "dispatch.lane_refill_held")?.extra?.reason,
      "stale code (decided while the refill read was in flight)");
  } finally { read.resolve(""); await h.cleanup(); }
});

test("a restart wakes phase-bound parked lanes while a young holdout still runs", async () => {
  const h = phase();
  try {
    await flush();
    await h.settle("A", 2);
    await h.settle("B", 4);
    await h.settle("C", 10);
    await h.settle("D", 17);
    await h.settle("E", 18);
    assert.equal(h.rows.filter(({ step }) => step === "dispatch.lane_parked").length, 2);
    await h.tick(20, true);
    assert.deepEqual(h.started.slice(6).map(({ id }) => id), ["G", "H"]);
    assert.deepEqual(h.rows.filter(({ step }) => step === "dispatch.lane_refilled").slice(-2)
      .map(({ extra }) => extra?.waiting_on), [["F"], ["F"]]);
    assert.equal(h.boundary("F"), stale);
    const count = h.started.length;
    await h.settle("G", 21);
    await h.settle("H", 22);
    assert.equal(h.started.length, count);
  } finally { await h.cleanup(); }
});

test("a pending restart keeps the existing pause gate on lane refill", async () => {
  let paused = false;
  const h = phase(true, { checkPause: () => paused ? "operator pause" : undefined });
  try {
    await latch(h);
    paused = true;
    await h.settle("B", 6);
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "B", "C"]);
    assert.equal(h.rows.find(({ step }) => step === "dispatch.lane_refill_held")?.extra?.reason, "pause: operator pause");
  } finally { paused = false; await h.cleanup(); }
});

test("the daemon command threads its lane's boundary reader into runTask", async (t) => {
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
  const boundary = () => stale;
  let invoked = false;
  const code = await daemonCommand(["--repo", "foreign-owner/widgets", "--plan", planPath, "--max", "0"], {
    runDaemon: async (_plan, deps) => {
      await deps.runOne("D", { restartAtWorkerBoundary: boundary });
      return { attempted: ["D"], merged: [], stopReason: "stopped", costUsd: 0, ticks: 1 };
    },
    runTask: async (id, options) => {
      invoked = true;
      assert.equal(id, "D");
      assert.ok(options);
      assert.equal(options.restartAtWorkerBoundary, boundary);
      assert.equal(options.restartAtWorkerBoundary?.(), stale);
      return result(id);
    },
  });
  assert.equal(code, 0);
  assert.equal(invoked, true);
});
