import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { benchmarkRunLedgerLogger, recordBenchmarkWorkerAttempt, runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { spawnWorker, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";

test("run task wires best effort benchmark attempt receipts for every dispatch spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-attempt-"));
  const bare = gitRepo({ bare: true, kind: "attempt-origin" });
  const seed = gitRepo({ kind: "attempt-seed" });
  seed.addRemote("origin", bare.dir);
  seed.git("push", "--quiet", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bare.dir, join(root, "repos", "remudero")]);
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, `- id: T-ATTEMPTS
  title: attempt fixture
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: fixture
  files: [src/lib/daemon.ts]
  status: queued
`);
  let calls = 0;
  const spawn: typeof spawnWorker = async (args) => {
    calls += 1;
    const id = `assignment-${calls}`;
    const assignment: WorkerSelectionAssignment = {
      version: 1, id, phase: "pre-execution",
      requested: { model: "requested", effort: "high", maxTurns: null },
      selected: { provider: "codex", model: "selected", effort: "high" },
      routing: { mode: "multi-provider", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
      candidates: [],
    };
    args.onSelectionAssignment?.(assignment);
    const result: WorkerResult = {
      sessionId: `session-${calls}`, costUsd: 0.25, numTurns: 1,
      text: calls === 1 ? "RECON REPORT\nOBSERVED: none\nINFERRED: none\nCOULDN'T-VERIFY: none\n" : "REPORT\nno PR opened\n",
      blocks: [], stderr: "", subtype: calls === 1 ? "" : "success", isError: false, apiError: false,
      permissionDenials: [], childEnvKeys: [], model: "selected", servedModel: "served",
      effort: "high", tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {}, compactionEvents: [], qualitySuspect: false,
      selectionAssignmentId: id, workerDurationMs: 27,
    };
    return result;
  };
  try {
    const outcome = await withLiveWritesAllowed(() => runTask("T-ATTEMPTS", {
      skipGitSync: true, planPath,
      config: { claudeBin: "/bin/true", root, installRoot: process.cwd() } as Config,
      github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      spawn,
      containmentExec: async (token) => ({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
      isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    }));
    assert.equal(outcome.verdict, "no_pr");
    assert.ok(calls >= 2);
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const assignments = rows.filter((row) => row.step === "worker.assignment");
    const attempts = rows.filter((row) => row.step === "worker.attempt");
    assert.equal(assignments.length, calls);
    assert.equal(attempts.length, calls);
    assert.deepEqual(attempts.map((row) => row.selection_assignment_id), assignments.map((row) =>
      (row.worker_assignment as WorkerSelectionAssignment).id));
    assert.ok(attempts.every((row) => (row.benchmark_run as Record<string, unknown>)?.phase === "attempt"));
    const firstReceipt = attempts[0]!.benchmark_run as Record<string, unknown>;
    assert.deepEqual(firstReceipt.workerCall, { state: "unavailable", reason: "worker-outcome-not-reported" });
    assert.deepEqual(firstReceipt.tokens, { state: "unavailable", reason: "worker-tokens-not-reported" });
    assert.equal((firstReceipt.accounting as Record<string, { state: string }>).apiCostUsd.state, "unavailable");
    assert.equal(rows.filter((row) => row.step === "verdict" && (row.benchmark_run as Record<string, unknown>)?.phase === "terminal").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    bare.cleanup();
  }
});

test("benchmark attempt telemetry writer failure does not change the worker result", () => {
  let calls = 0;
  const log = benchmarkRunLedgerLogger((step) => {
    calls += 1;
    if (step === "worker.attempt") throw new Error("telemetry unavailable");
  });
  log("worker.assignment", { worker_assignment: {
    id: "a", requested: { model: "asked", effort: "high" },
    selected: { provider: "codex", model: "chosen", effort: "high" },
  } });
  assert.doesNotThrow(() => log("worker.attempt", { selection_assignment_id: "a", success: true }));
  assert.equal(calls, 2);
});

test("benchmark attempt does not claim a join when its assignment write failed", () => {
  let attempt: Record<string, unknown> | undefined;
  const log = benchmarkRunLedgerLogger((step, fields) => {
    if (step === "worker.assignment") throw new Error("assignment ledger unavailable");
    if (step === "worker.attempt") attempt = fields;
  });
  assert.throws(() => log("worker.assignment", { worker_assignment: {
    id: "unwritten", requested: { model: "asked", effort: "high" },
    selected: { provider: "codex", model: "chosen", effort: "high" },
  } }));
  log("worker.attempt", { selection_assignment_id: "unwritten", success: true });
  assert.deepEqual((attempt?.benchmark_run as Record<string, unknown>).assignmentJoin,
    { state: "unavailable", reason: "assignment-not-observed-in-run" });
});

test("benchmark worker attempts preserve synchronous and asynchronous spawn errors", async () => {
  const rows: Record<string, unknown>[] = [];
  let stopped = 0;
  const log = (_step: string, fields: Record<string, unknown>) => rows.push(fields);
  assert.throws(() => recordBenchmarkWorkerAttempt(() => { throw new Error("sync failure"); },
    log, () => ({ id: "sync" }), () => { stopped += 1; }), /sync failure/);
  await assert.rejects(recordBenchmarkWorkerAttempt(() => Promise.reject(new Error("async failure")),
    log, () => ({ id: "async" }), () => { stopped += 1; }), /async failure/);
  assert.equal(stopped, 2);
  assert.deepEqual(rows.map((row) => row.selection_assignment_id), ["sync", "async"]);
  assert.ok(rows.every((row) => row.success === false && row.total_cost_usd === undefined));

  const original = new Error("original worker error");
  await assert.rejects(recordBenchmarkWorkerAttempt(() => Promise.reject(original),
    () => { throw new Error("telemetry failure"); }, () => undefined, () => { stopped += 1; }),
  (error) => error === original);
  assert.equal(stopped, 3);
});

test("benchmark worker attempts record provider error and refuse conflicting assignment IDs", async () => {
  const rows: Record<string, unknown>[] = [];
  const result: WorkerResult = {
    sessionId: "session", costUsd: 0.25, numTurns: 1, text: "", blocks: [], stderr: "",
    subtype: "error_provider", isError: true, apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "selected", servedModel: null, effort: "high",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false, selectionAssignmentId: "other",
  };
  let stopped = 0;
  const returned = await recordBenchmarkWorkerAttempt(() => Promise.resolve(result),
    (_step, fields) => rows.push(fields), () => ({ id: "selected" }), () => { stopped += 1; });
  assert.equal(returned, result);
  assert.equal(stopped, 1);
  assert.equal(rows[0]?.success, false);
  assert.equal(rows[0]?.assignment_observed, false);
  assert.equal(rows[0]?.selection_assignment_id, "other");
});

test("benchmark worker attempt instrumentation failure preserves a successful result", async () => {
  const result: WorkerResult = {
    sessionId: "session", costUsd: 0.25, numTurns: 1, text: "", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "selected", servedModel: "served", effort: "high",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false,
  };
  const withBrokenTokens = Object.defineProperty(result, "tokens", { get: () => { throw new Error("bad usage"); } });
  let stopped = 0;
  const returned = await recordBenchmarkWorkerAttempt(() => Promise.resolve(withBrokenTokens),
    () => { throw new Error("not reached"); }, () => undefined, () => { stopped += 1; });
  assert.equal(returned, result);
  assert.equal(stopped, 1);
});
