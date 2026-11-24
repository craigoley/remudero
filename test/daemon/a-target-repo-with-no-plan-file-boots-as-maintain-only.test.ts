// W1-T14575 — a repository onboarded maintain-only has no plan/tasks.yaml and no plan/tasks.d by design. Its
// foreign-target daemon read the missing file at boot, threw "PlanError: cannot read plan file (...): ENOENT" and
// exited 1 on every restart until docker's restart budget ran out. An absent plan now boots as an empty plan with
// one daemon.plan_absent row naming the repo; a plan file that is present but does not parse still refuses the boot.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadTargetPlanOrEmptyWhenAbsent, loadTargetPlanQuarantiningDuplicates, targetPlanAbsent } from "#src/lib/drain.js";
import { PlanError } from "#src/lib/plan.js";
import { makeTempDir } from "#src/lib/tmp.js";

const REPO = "craigoley/maintain-only-fixture";

function checkout(t: TestContext): string {
  const root = makeTempDir("rmd-plan-absent");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function recorder(): { rows: Array<[string, Record<string, unknown> | undefined]>; log: (step: string, extra?: Record<string, unknown>) => void } {
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  return { rows, log: (step, extra) => rows.push([step, extra]) };
}

test("W1-T14575: a target with no plan file boots with an empty plan", (t) => {
  // Both shapes of "no plan": no plan/ directory at all, and an empty plan/ directory.
  for (const makePlanDir of [false, true]) {
    const root = checkout(t);
    if (makePlanDir) mkdirSync(join(root, "plan"));
    const path = join(root, "plan", "tasks.yaml");
    // Positive control: the loader this daemon used before refuses the same checkout with the observed error.
    assert.throws(() => loadTargetPlanQuarantiningDuplicates(path, REPO), (err: unknown) =>
      err instanceof PlanError && /cannot read plan file .*ENOENT/.test(err.message));
    assert.equal(targetPlanAbsent(path), true);

    const { rows, log } = recorder();
    const { plan, quarantined } = loadTargetPlanOrEmptyWhenAbsent(path, REPO, log);
    assert.deepEqual(plan.tasks, []);
    assert.deepEqual(quarantined, []);
    assert.equal(plan.byId.size, 0);
    assert.deepEqual(rows, [["daemon.plan_absent", { repo: REPO, plan_path: path }]], "exactly one row, naming the repo");
  }
});

test("W1-T14575: a malformed target plan file still refuses the boot", (t) => {
  const root = checkout(t);
  mkdirSync(join(root, "plan"));
  const path = join(root, "plan", "tasks.yaml");
  writeFileSync(path, "- id: [unterminated\n  title: {\n");
  assert.equal(targetPlanAbsent(path), false);
  const { rows, log } = recorder();
  assert.throws(() => loadTargetPlanOrEmptyWhenAbsent(path, REPO, log), (err: unknown) => err instanceof PlanError);
  assert.deepEqual(rows, [], "a present plan is never reported absent");
});

test("W1-T14575: a tasks.d directory without a monolith is not an absent plan", (t) => {
  const root = checkout(t);
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const path = join(root, "plan", "tasks.yaml");
  assert.equal(targetPlanAbsent(path), false);
  const { rows, log } = recorder();
  assert.throws(() => loadTargetPlanOrEmptyWhenAbsent(path, REPO, log), (err: unknown) =>
    err instanceof PlanError && /cannot read plan file .*ENOENT/.test(err.message));
  assert.deepEqual(rows, []);
});

test("W1-T14575: only ENOENT counts as absent; any other stat error keeps the plan present", () => {
  const denied = (): never => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  const missing = (): never => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  };
  assert.equal(targetPlanAbsent("/nowhere/plan/tasks.yaml", denied), false);
  assert.equal(targetPlanAbsent("/nowhere/plan/tasks.yaml", missing), true);
  // A monolith that cannot be stat'd for another reason still reaches the loader and its PlanError.
  const { rows, log } = recorder();
  assert.throws(() => loadTargetPlanOrEmptyWhenAbsent("/nowhere/plan/tasks.yaml", REPO, log, denied), PlanError);
  assert.deepEqual(rows, []);
});
