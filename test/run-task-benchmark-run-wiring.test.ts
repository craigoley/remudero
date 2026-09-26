import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { benchmarkRunLedgerLogger, runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker } from "../src/lib/worker.js";
import type { WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";

test("run task wires benchmark run receipts at assignment and terminal", () => {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const log = benchmarkRunLedgerLogger((step, fields) => rows.push({ step, fields }));
  const assignment = {
    id: "private-assignment", requested: { model: "m-requested", effort: "high" },
    selected: { provider: "codex", model: "m-selected", effort: "medium", accountLabel: "secret" },
  };
  log("run.start", { task_class: "src", risk: "medium" });
  log("worker.assignment", { worker_assignment: assignment });
  log("implement.done", { selection_assignment_id: assignment.id, success: true, total_cost_usd: 3 });
  log("verdict", { selection_assignment_id: "unseen", success: true, total_cost_usd: 4 });
  log("verdict", { selection_assignment_id: assignment.id, success: true, served_model: "m-served",
    tokens: { input: 1, output: 2 }, worker_duration_ms: 11, billing_mode: "api", total_cost_usd: 1.25 });

  const assigned = rows[1]!.fields.benchmark_run as Record<string, unknown>;
  assert.equal(assigned.phase, "assignment");
  assert.deepEqual((assigned.work as Record<string, unknown>).taskClass, { state: "observed", value: "src" });
  assert.equal(rows[2]!.fields.benchmark_run, undefined, "intermediate receipt is not terminal");
  assert.equal(rows[3]!.fields.benchmark_run, undefined, "orphan is not joined to this run's assignment");
  const terminal = rows[4]!.fields.benchmark_run as Record<string, unknown>;
  assert.equal(terminal.phase, "terminal");
  assert.deepEqual((terminal.accounting as Record<string, unknown>).apiCostUsd, { state: "observed", value: 1.25 });
  assert.doesNotMatch(JSON.stringify(rows.map((row) => row.fields.benchmark_run)), /secret|private-assignment/);

  const badAssignment = { id: "bad", requested: { model: "m", effort: "high" },
    get selected(): never { throw new Error("instrumentation field unavailable"); } };
  assert.doesNotThrow(() => log("worker.assignment", { worker_assignment: badAssignment }));
  assert.equal(rows.at(-1)?.fields.benchmark_run_unavailable_reason, "receipt-build-failed");
});

test("real dispatch records benchmark assignment and terminal receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-dispatch-"));
  const bare = gitRepo({ bare: true, kind: "benchmark-dispatch-origin" });
  const seed = gitRepo({ kind: "benchmark-dispatch-seed" });
  seed.addRemote("origin", bare.dir);
  seed.git("push", "--quiet", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bare.dir, repoDir]);
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, `- id: T-BENCHMARK-DISPATCH
  title: benchmark dispatch fixture
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: fixture
  files: [src/lib/daemon.ts]
  status: queued
`);
  const assignment: WorkerSelectionAssignment = {
    version: 1, id: "bench-assignment-1", phase: "pre-execution",
    requested: { model: "requested-model", effort: "high", maxTurns: null },
    selected: { provider: "codex", model: "selected-model", effort: "high" },
    routing: { mode: "multi-provider", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
    candidates: [],
  };
  let calls = 0;
  const spawn: typeof spawnWorker = async (args) => {
    calls++;
    args.onSelectionAssignment?.(assignment);
    const worker: WorkerResult = {
      sessionId: `bench-session-${calls}`, costUsd: 0.25, numTurns: 1,
      text: calls === 1 ? "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" : "REPORT\nno PR opened\n",
      blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
      permissionDenials: [], childEnvKeys: [], model: "selected-model", servedModel: "served-model",
      effort: "high", tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {}, compactionEvents: [], qualitySuspect: false,
      selectionAssignmentId: assignment.id, workerDurationMs: 27,
    };
    return worker;
  };
  try {
    const outcome = await withLiveWritesAllowed(() => runTask("T-BENCHMARK-DISPATCH", {
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
    const assigned = rows.filter((row) => row.step === "worker.assignment");
    assert.equal(assigned.length, calls);
    assert.ok(assigned.every((row) => (row.benchmark_run as Record<string, unknown>)?.phase === "assignment"));
    const terminal = rows.find((row) => row.step === "verdict" && row.verdict === "no_pr");
    assert.ok(terminal);
    const receipt = terminal.benchmark_run as Record<string, unknown>;
    assert.equal(receipt.phase, "terminal");
    assert.deepEqual(receipt.servedModel, { state: "observed", value: "served-model" });
  } finally {
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    bare.cleanup();
  }
});

test("real dispatch reaches the benchmark logger without making a lint refusal into a benchmark outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-run-log-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, `- id: T-BENCHMARK-LOG
  title: deliberately malformed sizing fixture
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: fixture
  files: [src/lib/daemon.ts, src/lib/review.ts, src/lib/launchd.ts]
  acceptance:
    - claim: no worker may run
      proof: "unit test: run task wires benchmark run receipts at assignment and terminal"
  status: queued
`);
  const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  const github: GitHub = {
    prByRef: () => null, findMergedByTrailer: () => null,
    headRefName: () => undefined, prBody: () => undefined,
  };
  const spawn = (async () => { throw new Error("pre-dispatch refusal must never spawn"); }) as typeof spawnWorker;
  const result = await runTask("T-BENCHMARK-LOG", { skipGitSync: true, planPath, config, github, spawn });
  assert.equal(result.verdict, "blocked_illformed");
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(rows.some((row) => row.step === "lint.blocked"));
  assert.ok(rows.every((row) => row.benchmark_run === undefined));
});
