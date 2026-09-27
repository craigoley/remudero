import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBenchmarkCohortDaemonHooks, daemonCommand } from "../src/run-task.js";
import { runBenchmarkCohortIdlePass } from "../src/lib/benchmark-cohort.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";

test("run task wires benchmark cohort state root", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-benchmark-wiring-"));
  const root = join(home, "Remudero");
  const stateDir = join(root, "state");
  const planPath = join(home, "tasks.yaml");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  writeFileSync(planPath, "[]\n");
  writeFileSync(join(stateDir, "ledger.ndjson"), JSON.stringify({
    ts: "2026-09-26T12:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id: "cash-1", selected: { provider: "cash", model: "gpt-5-nano" } },
  }) + "\n");
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  }
  try {
    assert.equal(typeof captured?.checkBenchmarkCohort, "function");
    assert.equal(typeof captured?.runBenchmarkCohortPass, "function");
    const report = await captured!.runBenchmarkCohortPass!();
    assert.equal(report.snapshot.sourceRows.assignments, 1, "the hook reads config.root/state, not a test-only path");
    assert.equal(report.snapshot.cohorts[0].dimensions.model, "gpt-5-nano");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("benchmark cohort cadence does not scan again until its interval", () => {
  let now = 1_000;
  const hooks = buildBenchmarkCohortDaemonHooks({ clock: clockFromMillisFn(() => now), intervalMs: 30_000 });
  assert.equal(hooks.checkBenchmarkCohort(), true);
  assert.equal(hooks.checkBenchmarkCohort(), false);
  now += 29_999;
  assert.equal(hooks.checkBenchmarkCohort(), false);
  now += 1;
  assert.equal(hooks.checkBenchmarkCohort(), true);
});

test("benchmark cohort backlog progresses during supervised idle starvation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-idle-"));
  try {
    for (let i = 0; i < 9; i += 1) writeFileSync(join(stateDir,
      `ledger.2026-09-26T12-${String(i).padStart(2, "0")}-00-000Z.ndjson`), JSON.stringify({
      ts: "2026-09-26T12:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: `a${i}`, selected: { provider: "cash", model: "gpt-5-nano" } },
    }) + "\n");
    const entrypoint = readFileSync(new URL("../deploy/entrypoint.sh", import.meta.url), "utf8");
    assert.ok(entrypoint.includes('timeout -k 5s 120s node --import tsx "$TREE/src/lib/benchmark-cohort.ts" "$CONFIG_ROOT/state"'),
      "the supervised idle wait calls the model-free bounded projection");
    assert.ok(entrypoint.includes('remaining=$((300 - ($(date +%s) - pulse_started)))'),
      "maintenance time is part of the existing PR-probe interval");
    for (let i = 0; i < 3; i += 1) assert.equal(await runBenchmarkCohortIdlePass(stateDir), 0);
    const checkpoint = JSON.parse(readFileSync(join(stateDir, "benchmark-cohort-v1.json"), "utf8"));
    assert.equal(checkpoint.sources.length, 9);
    assert.equal(checkpoint.lastGood.sourceRows.assignments, 9,
      "finite backlog reaches a completed checkpoint without a model worker");
    const direct = spawnSync(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("../src/lib/benchmark-cohort.ts", import.meta.url)), stateDir], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(direct.status, 0, direct.stderr);
    assert.match(direct.stdout, /"event":"benchmark_cohort.idle_pass"/);
    assert.ok(!direct.stdout.includes("a1"), "the idle process emits metadata, never assignment IDs");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
