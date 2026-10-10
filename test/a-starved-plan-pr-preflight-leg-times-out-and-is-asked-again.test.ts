/**
 * A STARVED PLAN-PR PREFLIGHT LEG TIMES OUT, IS RECORDED AS SUCH, AND IS ASKED AGAIN — NEVER A PASS.
 *
 * OBSERVED 2026-10-10 on the fleet host at load 30: the measurement cadence sat 78 minutes in one plan-reconcile
 * landing leg, a `check-proof --base origin/main` the emitter spawned with no timeout. Every in-tree check (and the
 * checkout of the tree they run in) is now killed at `inTreeCheckBudgetMs()` — the policy's per-proof hang guard
 * stretched by host load — and a killed leg is its own outcome: `timedOut`, which holds the push without caching a
 * red, so the lane's own not-landed path asks again on a later pass.
 *
 * The hung legs are real child processes that sleep past their budget and would exit 0 without one: at a base that
 * never kills them, each case waits them out and then reads green, which is exactly the silent pass this refuses.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as emitter from "../src/lib/plan-pr-emitter.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GREEN = { status: 0, output: "" };
/** How long a hung leg sleeps before it would exit 0 on its own: far past every budget below. */
const HANG_MS = 6_000;
const HANGS = `setTimeout(() => process.exit(0), ${HANG_MS});\n`;
/** A leg that starts a long-lived child of its own first — the shape of `git worktree add` and its `git reset --hard`. */
const HANGS_WITH_A_CHILD =
  `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\n` +
  `const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });\n` +
  `writeFileSync("grandchild.pid", String(child.pid));\n${HANGS}`;
type LogRow = { step: string; extra?: Record<string, unknown> };

/** A checkout whose lint script and check-proof entry both hang, with `origin/main` one commit back. */
function hungTree(): GitRepo {
  const repo = gitRepo({ kind: "starved-preflight" });
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  for (const [rel, body] of Object.entries({ "scripts/lint-plan-precheck.mjs": HANGS_WITH_A_CHILD, "src/run-task.ts": HANGS })) {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), body);
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(repo.dir, "node_modules"));
  repo.git("add", "scripts", "src");
  repo.git("commit", "-q", "-m", "chore: hung legs");
  return repo;
}

const PR = { title: "chore(plan): reconcile one shard", body: "## Acceptance\n- the shard reconciles | grep: status in plan/tasks.d/w1-t1.yaml" };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: gone
  }
}

test("the budget is the policy's proof guard stretched by host load per core, never below it, with no fixed cap", () => {
  const { inTreeCheckBudgetMs } = emitter;
  assert.equal(inTreeCheckBudgetMs({ cores: 8, load1: 0 }, () => 180_000), 180_000, "an idle host gives exactly the guard");
  assert.equal(inTreeCheckBudgetMs({ cores: 8, load1: 4 }, () => 180_000), 180_000, "load under one per core never shrinks it");
  assert.equal(inTreeCheckBudgetMs({ cores: 8, load1: 30 }, () => 180_000), 675_000, "the observed load 30 on 8 cores: 3.75x");
  assert.equal(inTreeCheckBudgetMs({ cores: 8, load1: 800 }, () => 180_000), 18_000_000, "no ceiling: pressure keeps stretching it");
  assert.equal(inTreeCheckBudgetMs({ cores: 0, load1: 3 }, () => 1_000), 3_000, "an unreadable core count reads as one core");
  assert.equal(inTreeCheckBudgetMs({ cores: 4, load1: Number.NaN }, () => 1_000), 1_000, "an unreadable load reads as idle");
  const unreadablePolicy = () => {
    throw new Error("plan/policy.yaml unreadable");
  };
  assert.equal(inTreeCheckBudgetMs({ cores: 2, load1: 4 }, unreadablePolicy), 120_000, "an unreadable policy still bounds it, at its 60 s floor");
  assert.ok(inTreeCheckBudgetMs() >= 60_000, "the real policy and host give at least the policy floor");
});

test("a hung in-tree check leg is killed at its budget with everything it started, and recorded as timed out: never a pass, never a red", async () => {
  const repo = hungTree();
  let grandchild: number | undefined;
  try {
    const started = Date.now();
    const result = emitter.planPrPreflight(
      { cwd: repo.dir, title: PR.title, body: "" },
      { taskIdExistence: () => GREEN, shardCensus: () => GREEN, checkProof: () => 0, budgetMs: () => 1_500 },
    );
    assert.ok(Date.now() - started < HANG_MS, "the leg was killed, not waited out");
    grandchild = Number(readFileSync(join(repo.dir, "grandchild.pid"), "utf8"));
    for (let waited = 0; alive(grandchild) && waited < 3_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(grandchild), false, "the child the leg started dies with it, never left running as an orphan");
    assert.equal(result.ok, true, "a timeout is no red");
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.timedOut?.map((f) => f.check), ["lint-plan"]);
    assert.match(result.timedOut?.[0]?.firstLine ?? "", /timed out after 1500 ms/);

    const rows: LogRow[] = [];
    const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
    assert.equal(emitter.planPrPreflightAllows(result, { lane: "plan-reconcile-landing", branch: "landing", log }), false, "the push waits");
    assert.deepEqual(rows, [{ step: "plan_pr.preflight_timed_out", extra: { lane: "plan-reconcile-landing", branch: "landing", timed_out: result.timedOut } }]);
    assert.throws(
      () => emitter.refuseRedPlanPr(result, { lane: "plan-reconcile-landing", branch: "landing" }),
      (e: unknown) => e instanceof emitter.PlanPrPreflightTimedOutError && e instanceof emitter.PlanPrPreflightRefusedError && /deferred .*\[lint-plan\] timed out/.test(e.message),
      "a lane whose not-landed outcome is a throw sees a deferral it can retry",
    );
  } finally {
    if (grandchild !== undefined && alive(grandchild)) process.kill(grandchild, "SIGKILL");
    repo.cleanup();
  }
});

test("a hung check-proof leg times out through the awaited preflight too, and a red still outranks it", async () => {
  const repo = hungTree();
  try {
    const started = Date.now();
    const result = await emitter.planPrPreflightAsync(
      { cwd: repo.dir, ...PR },
      { lintPlan: async () => GREEN, taskIdExistence: async () => GREEN, shardCensus: async () => GREEN, budgetMs: () => 1_500 },
    );
    assert.ok(Date.now() - started < HANG_MS, "the check-proof child was killed, not waited out");
    assert.equal(result.ok, true);
    assert.deepEqual(result.timedOut?.map((f) => f.check), ["proof-discrimination"]);
    assert.match(result.timedOut?.[0]?.firstLine ?? "", /timed out after 1500 ms/);

    const redAndHung = await emitter.planPrPreflightAsync(
      { cwd: repo.dir, title: "Plan: untyped", body: PR.body },
      { lintPlan: async () => ({ status: 1, output: "✗ W9-T1 [proof-dialect]" }), taskIdExistence: async () => GREEN, shardCensus: async () => GREEN, checkProof: async () => ({ timedOutMs: 9 }) },
    );
    assert.equal(redAndHung.ok, false, "a red check refuses whatever else timed out");
    assert.deepEqual(redAndHung.failures.map((f) => f.check), ["lint-plan", "pr-title"]);
    assert.deepEqual(redAndHung.timedOut?.map((f) => f.check), ["proof-discrimination"]);
    assert.equal(emitter.planPrPreflightAllows(redAndHung, { lane: "x", branch: "y" }), false);
    assert.throws(() => emitter.refuseRedPlanPr(redAndHung, { lane: "x", branch: "y" }), (e: unknown) => !(e instanceof emitter.PlanPrPreflightTimedOutError));
  } finally {
    repo.cleanup();
  }
});

test("a body proof whose check-proof times out holds the push even beside a proof that could not be checked", () => {
  const repo = hungTree();
  try {
    const body = "## Acceptance\n- one | grep: a in x.ts\n- two | grep: b in y.ts";
    const result = emitter.planPrPreflight(
      { cwd: repo.dir, title: PR.title, body },
      { lintPlan: () => GREEN, taskIdExistence: () => GREEN, shardCensus: () => GREEN, checkProof: (_cwd, proof) => (proof.includes("a in") ? { timedOutMs: 7 } : 4) },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.unreadable, [], "the undecided timeout outranks the unreadable sibling: the whole check waits");
    assert.match(result.timedOut?.[0]?.firstLine ?? "", /timed out after 7 ms/);
  } finally {
    repo.cleanup();
  }
});

test("a tree whose checkout is killed at its budget is held, not pushed unchecked, and leaves no worktree registered", async () => {
  const repo = hungTree();
  try {
    const head = repo.git("rev-parse", "HEAD");
    const checks = { lintPlan: () => GREEN, taskIdExistence: () => GREEN, shardCensus: () => GREEN, checkProof: () => 0, budgetMs: () => 1 };
    const sync = emitter.planPrPreflightAtCommit(repo.dir, head, PR, checks);
    assert.equal(sync.ok, true);
    assert.deepEqual(sync.unreadable, [], "a killed checkout is undecided, not merely unreadable");
    assert.deepEqual(sync.timedOut?.map((f) => f.check), ["tree"]);
    assert.equal(emitter.planPrPreflightAllows(sync, { lane: "x", branch: "y" }), false, "before this, an unmaterialized tree pushed with every check skipped");

    const awaited = await emitter.planPrPreflightAtCommitAsync(repo.dir, head, PR, {
      lintPlan: async () => GREEN, taskIdExistence: async () => GREEN, shardCensus: async () => GREEN, checkProof: async () => 0, budgetMs: () => 1,
    });
    assert.deepEqual(awaited.timedOut?.map((f) => f.check), ["tree"]);
    assert.equal(repo.git("worktree", "list").split("\n").length, 1, "the killed checkout is deregistered on the way out");

    const missing = emitter.planPrPreflightAtCommit(repo.dir, "0".repeat(40), PR, { ...checks, budgetMs: () => 60_000 });
    assert.equal(missing.timedOut, undefined, "a checkout that fails outright stays an unreadable check, as before");
    assert.deepEqual(missing.unreadable.map((f) => f.check), ["tree"]);
  } finally {
    repo.cleanup();
  }
});
