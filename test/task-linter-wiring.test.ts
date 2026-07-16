import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTask } from "../src/run-task.js";
import { assertLintClean } from "../src/lib/task-linter.js";
import { loadPlan } from "../src/lib/plan.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker } from "../src/lib/worker.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── §5C Layer A pre-dispatch guard is WIRED into the run path (W1-T20c) ───────

test("the run path INVOKES assertLintClean right after assertRunnable (the pre-dispatch guard is wired, not just implemented)", () => {
  assert.match(runTaskSrc, /assertLintClean\(/, "run-task.ts must call assertLintClean");
  assert.match(runTaskSrc, /TaskLintError/, "run-task.ts must convert a failing lint into a terminal verdict");
  const assertRunnableIdx = runTaskSrc.indexOf("assertRunnable(plan, task, isMerged)");
  const lintIdx = runTaskSrc.indexOf("assertLintClean(");
  assert.ok(assertRunnableIdx >= 0, "assertRunnable must be called");
  assert.ok(lintIdx > assertRunnableIdx, "the lint guard must run AFTER assertRunnable (unmet-deps/blocked/verify:human are checked first)");
});

test("the lint guard runs BEFORE the inflight lock and BEFORE any worktree/worker work — no spawn on a linter-failing task", () => {
  const lintIdx = runTaskSrc.indexOf("assertLintClean(");
  const inflightIdx = runTaskSrc.indexOf("acquireInflightLock(");
  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(");
  const reconIdx = runTaskSrc.indexOf('"recon worker"');
  assert.ok(lintIdx >= 0, "assertLintClean must be called somewhere in run-task.ts");
  assert.ok(lintIdx < inflightIdx, "the lint guard must precede the inflight lock");
  assert.ok(lintIdx < worktreeAddIdx, "the lint guard must precede worktreeAdd (repo/worktree setup)");
  assert.ok(lintIdx < reconIdx, "the lint guard must precede the recon worker spawn");
});

// ── CRITERION 5 (BEHAVIORAL, injected-exec): rmd run-task REFUSES a linter-failing ────────
// task with blocked_illformed and NEVER spawns; a clean task passes the guard. This drives
// the REAL runTask dispatch path through injected seams (spawn + github) — not a source grep.

/** A fixture plan: TST-BAD trips the sizing linter (3 subsystems @ risk medium); TST-OK is clean. */
const FIXTURE_PLAN = `- id: TST-BAD
  title: "malformed — spans three subsystems at medium risk (sizing block)"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  files: [src/lib/daemon.ts, src/lib/launchd.ts, src/lib/review.ts]
  acceptance:
    - claim: "does the thing"
      proof: "unit test test/foo.test.ts asserts the thing"
  status: queued
  attempts: 0
- id: TST-OK
  title: "clean — one subsystem, observable proof, origin present"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  files: [src/lib/daemon.ts]
  acceptance:
    - claim: "does the thing"
      proof: "unit test test/daemon.test.ts asserts the thing"
  status: queued
  attempts: 0
`;

/** An offline GitHub gateway: projectPlan runs with zero network round-trips. */
const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function fixturePlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lint-wiring-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  return planPath;
}

test("CRITERION 5 (behavioral): a linter-failing task -> verdict=blocked_illformed, costUsd 0, and the injected worker-spawn is NEVER called", async () => {
  const planPath = fixturePlanPath();
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-lint-root-"));
  const config: Config = { claudeBin: "/bin/true", root: configRoot };

  let spawnCalls = 0;
  // A spawn stub that COUNTS calls and hard-fails if ever reached — a linter-failing
  // task must return before any worker is spawned. Typed as the real spawnWorker.
  const spawn = (async () => {
    spawnCalls++;
    throw new Error("spawn must never run for a linter-failing task");
  }) as typeof spawnWorker;

  const res = await runTask("TST-BAD", {
    skipGitSync: true, // fixture plan is read literally, no git fetch
    planPath,
    config,
    github: OFFLINE_GITHUB, // projectPlan runs offline
    spawn, // the recon/first worker-spawn is routed through this
  });

  assert.equal(res.verdict, "blocked_illformed", "a linter-failing task is REFUSED with a terminal blocked_illformed verdict");
  assert.equal(res.costUsd, 0, "no cost is incurred — the run never reached a worker");
  assert.equal(spawnCalls, 0, "the injected worker-spawn was NEVER called (no lock, no worktree, no worker)");
});

test("CRITERION 5 (behavioral): a CLEAN task PASSES the pre-dispatch guard (assertLintClean does not throw), while the malformed one throws", () => {
  const plan = loadPlan(fixturePlanPath());
  // assertLintClean is the EXACT guard runTask invokes at dispatch (run-task.ts).
  assert.doesNotThrow(() => assertLintClean(plan.byId.get("TST-OK")!), "a clean task must pass the guard");
  assert.throws(() => assertLintClean(plan.byId.get("TST-BAD")!), /lint|violation/i, "the malformed task must be refused by the same guard");
});

test("blocked_illformed is a recognized terminal verdict on RunResult", () => {
  assert.match(runTaskSrc, /"blocked_illformed"/);
});

// ── the CI half is wired too ───────────────────────────────────────────────────

test("rmd lint-plan is wired into the CLI dispatch", () => {
  assert.match(runTaskSrc, /cmd === "lint-plan"/);
  assert.match(runTaskSrc, /lintPlanCommand/);
});
