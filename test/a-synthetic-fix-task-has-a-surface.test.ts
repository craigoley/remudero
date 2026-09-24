/**
 * test/a-synthetic-fix-task-has-a-surface.test.ts — W1-T4460.
 *
 * THE DEFECT (rationale, measured 2026-09-24 over 65 fix rounds since 2026-09-23T15:59Z): 8 of
 * them — #6807, #6804, #6803 ($9.55) and #6879 among them — made REAL edits with a valid
 * COMMIT_MESSAGE line, and every one was discarded by `commitWorkerEdits` (run-task.ts) as "the
 * task declares no files, so there is no surface to stage". `fixRungTaskFor` (sweep.ts) built a
 * synthetic task for any PR whose id was not found in the plan snapshot — RETRO/TRIAGE/PLAN/
 * APPROVE lanes, an agent PR with no trailer at all — and that synthetic task carried NO `files:`
 * at all, so `commitWorkerEdits`'s very first check (`declaredPaths.length === 0`) refused before
 * ever looking at what the worker actually touched.
 *
 * A SECOND, INDEPENDENT CAUSE (also measured): #6916/W1-T4413 went synthetic even though the task
 * WAS real and WAS in the plan — the sweep's own `plan` snapshot merely predated the shard that
 * filed it (#6910 landed after this poll's plan read). `fixRungTaskFor` never re-reads; a stale
 * snapshot therefore mints a permanent synthetic identity for a task that is, by the very next
 * poll's own read, genuinely filed.
 *
 * THE FIX, in two independent pieces mirrored by the two tests below: (i) `fixRungTaskFor` now
 * takes the PR's OWN changed-path list and gives a synthetic task that list as its `files:`
 * surface, so an edit that stays inside the PR's existing footprint has somewhere to stage. (ii)
 * `fixRungTaskWithPlanReload` re-reads the plan ONCE, only when the miss looks like it could be a
 * genuine (not lane, not `PR-<n>`) task id, before ever falling back to a synthetic identity.
 *
 * NO GATEWAY IS REACHED HERE — every test drives PURE functions or `commitWorkerEdits` fed a
 * hand-rolled fake `git`, never a real subprocess or `gh` call, the same discipline
 * `test/fix-rung-no-task.test.ts` and `test/the-harness-commits-a-workers-edits.test.ts` already
 * establish for this exact surface.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixRungTaskFor, fixRungTaskWithPlanReload } from "../src/lib/sweep.js";
import { commitWorkerEdits } from "../src/run-task.js";
import type { Plan, Task } from "../src/lib/plan.js";

const T = (id: string, over: Partial<Task> = {}): Task =>
  ({ id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued", attempts: 0, ...over }) as Task;

const planOf = (tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map((t) => [t.id, t])) });

const Z = (...entries: string[]) => entries.map((e) => `${e}\0`).join("");

function fakeGit(status: string) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "status") return status;
    if (args[0] === "rev-parse") return "cafebabe000000000000000000000000000000ff\n";
    return "";
  };
  return { run, calls };
}

// ── (i) THE SYNTHETIC TASK'S OWN SURFACE ─────────────────────────────────────────────────────

test("W1-T4460: a synthetic fix task commits inside the pull request's own paths", () => {
  const emptyPlan = planOf([]);
  // No taskId at all — the agent-authored, no-trailer shape #6807/#6804/#6803/#6879 all shared.
  const pr = { prNumber: 6807 };
  const changedPaths = ["src/lib/a.ts", "test/a.test.ts"];

  const { task, synthetic } = fixRungTaskFor(emptyPlan, pr, undefined, undefined, changedPaths);
  assert.equal(synthetic, true);
  assert.deepEqual(task.files, changedPaths, "the synthetic task's surface is the PR's own footprint");

  // The falsifier this task names: with the surface WIRED (task.files, not a hand-picked array),
  // a real edit inside that footprint now commits.
  const inside = fakeGit(Z("M  src/lib/a.ts"));
  const committed = commitWorkerEdits("/w", task.files, "fix: repair the failing check", { runGit: inside.run });
  assert.equal(committed.committed, true, "an edit inside the PR's own diff now has a surface to stage");
  assert.deepEqual(committed.undeclared, []);

  // AND THE FALSIFIER ITSELF, made concrete: keep the surface EMPTY (the pre-fix shape) and the
  // identical edit is refused exactly the way the 8 measured rounds were.
  const noSurface = fakeGit(Z("M  src/lib/a.ts"));
  const refused = commitWorkerEdits("/w", [], "fix: repair the failing check", { runGit: noSurface.run });
  assert.equal(refused.committed, false);
  assert.match(String(refused.reason), /declares no files/, "the exact refusal 8 of 65 measured rounds hit");
});

test("W1-T4460: RETRO/TRIAGE/PLAN/APPROVE lane PRs get the same PR-footprint surface, not just agent PRs", () => {
  const emptyPlan = planOf([]);
  const changedPaths = ["plan/tasks.d/some-shard.yaml"];
  // A RETRO PR deliberately carries no `Remudero-Task:` trailer at all — its lane identity comes
  // only from its own run branch (see fixRungTaskFor's own doc).
  const { task, synthetic } = fixRungTaskFor(
    emptyPlan,
    { prNumber: 3591 },
    undefined,
    "run-RETRO-1788350665543",
    changedPaths,
  );
  assert.equal(synthetic, true);
  assert.equal(task.id, "RETRO", "the lane identity is unchanged by this task");
  assert.deepEqual(task.files, changedPaths);
});

test("W1-T4460: a PR with a plan task is untouched — the real task's own `files:` still wins", () => {
  const real = T("W1-T500", { files: ["src/lib/only-this.ts"] });
  const plan = planOf([real]);
  const { task, synthetic } = fixRungTaskFor(plan, { prNumber: 9, taskId: "W1-T500" }, undefined, undefined, [
    "src/lib/unrelated.ts",
  ]);
  assert.equal(synthetic, false);
  assert.equal(task, real, "the identical plan object — changedPaths never overrides a real task's declared files");
  assert.deepEqual(task.files, ["src/lib/only-this.ts"]);
});

test("W1-T4460: no changed-path list at all still resolves to an empty (never undefined) surface", () => {
  const { task } = fixRungTaskFor(planOf([]), { prNumber: 1 });
  assert.deepEqual(task.files, [], "commitWorkerEdits reads `.length`, so this must be an array, never undefined");
});

// ── (ii) THE STALE-SNAPSHOT RELOAD ───────────────────────────────────────────────────────────

test("W1-T4460: a task missing from a stale snapshot is found by a plan reload", () => {
  const stale = planOf([T("W1-T500")]);
  const freshTask = T("W1-T4413");
  const fresh = planOf([T("W1-T500"), freshTask]);

  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => logs.push({ step, extra });

  const { task, synthetic } = fixRungTaskWithPlanReload(
    stale,
    { prNumber: 6916, taskId: "W1-T4413" },
    undefined,
    undefined,
    undefined,
    () => fresh,
    log,
  );

  assert.equal(synthetic, false, "the reload found the real task — it is never minted a synthetic identity");
  assert.equal(task, freshTask, "the identical object from the FRESH plan, no copy");
  const reloaded = logs.find((l) => l.step === "daemon.plan_reloaded");
  assert.ok(reloaded, "the reload is ledgered under the SAME step runDaemon's own top-of-tick reload already uses");
  assert.deepEqual(reloaded?.extra, { tasks: 2 }, "same shape as runDaemon's own daemon.plan_reloaded row");
});

test("W1-T4460: a genuinely absent task id is still synthetic even after the reload comes up empty too", () => {
  const stale = planOf([T("W1-T500")]);
  const { task, synthetic } = fixRungTaskWithPlanReload(
    stale,
    { prNumber: 42, taskId: "W1-T9999" },
    undefined,
    undefined,
    undefined,
    () => stale,
    () => {},
  );
  assert.equal(synthetic, true);
  assert.equal(task.id, "W1-T9999", "its own id is preserved, never renamed");
});

test("W1-T4460: an orchestrator-lane or PR-<n> id never triggers a reload — it is never a plan task", () => {
  const stale = planOf([]);
  let reloadCalls = 0;
  const reloadPlan = () => {
    reloadCalls++;
    return stale;
  };
  // RETRO carries no `Remudero-Task:` trailer at all (its lane identity comes from the run
  // branch alone — see `fixRungTaskFor`'s own doc); when a body somehow does set one it is the
  // bare literal "RETRO" (`taskIdFromRunBranch` strips a `run-<id>-<epoch>` head to exactly that).
  for (const taskId of [undefined, "RETRO", "TRIAGE-fb-1-04eac2", "PLAN-create-1", "APPROVE-fb-1", "PR-1132"]) {
    fixRungTaskWithPlanReload(stale, { prNumber: 1, taskId }, undefined, undefined, undefined, reloadPlan, () => {});
  }
  assert.equal(reloadCalls, 0, "a lane/escalation id is a closed, known-synthetic shape — reloading it wastes a disk read every poll");
});

test("W1-T4460: an omitted or failing reload degrades to today's plain fixRungTaskFor behaviour", () => {
  const stale = planOf([T("W1-T500")]);
  const noReload = fixRungTaskWithPlanReload(stale, { prNumber: 1, taskId: "W1-T4413" }, undefined, undefined, undefined, undefined, () => {});
  assert.equal(noReload.synthetic, true, "no reloader supplied — unchanged from before this task");

  const throwing = fixRungTaskWithPlanReload(
    stale,
    { prNumber: 1, taskId: "W1-T4413" },
    undefined,
    undefined,
    undefined,
    () => {
      throw new Error("plan unreadable");
    },
    () => {},
  );
  assert.equal(throwing.synthetic, true, "a reload failure is swallowed — never this dispatch's reason to throw");
});
