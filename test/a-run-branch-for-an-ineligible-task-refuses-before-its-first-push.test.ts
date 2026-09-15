/**
 * test/a-run-branch-for-an-ineligible-task-refuses-before-its-first-push.test.ts — W1-T3600.
 *
 * Replay of the #5603/W1-T3598 incident (2026-09-15): a session built W1-T3598 while its declared
 * dependency W1-T3597 was still an open PR, drove #5603 through a full build, a review-ready body
 * and every CI round, and only THEN was it closed by the sweep's `currentPlanIneligibilityReason`
 * (src/lib/sweep.ts) — correctly, but after everything spendable had already been spent. This is
 * the regression lock for the earlier refusal: a first push to a `run-<taskId>-*` branch whose task
 * has an unmet dependency in the CURRENT plan is refused before any of that cost is incurred.
 *
 * `scripts/run-branch-eligibility-check.mjs` is a plain `.mjs` file that imports `src/lib/*.ts`
 * directly (design (i): reuse the sweep's own predicate, never a second copy), so — like
 * `scripts/head-identity-gate.mjs`'s own suite — it is exercised here via a dynamic `import()`
 * rather than a static one, keeping `scripts/**` (outside tsconfig's `include`) out of typecheck.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import type { Plan, Task } from "../src/lib/plan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "run-branch-eligibility-check.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluateRunBranchEligibility: (input: {
    headRef: string | undefined;
    plan: Plan;
    projectionsById?: Map<string, { merged?: boolean; source?: "trailer" | "head-branch"; prNumber?: number }>;
    reachable?: boolean;
  }) => { applicable: boolean; taskId?: string; admitted?: boolean; reason?: string; unknown?: boolean; taskNotFound?: boolean };
};
const { evaluateRunBranchEligibility } = mod;

const TASK_ID = "W1-T9001";
const DEP_ID = "W1-T9000";

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "the dependent build",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planWith(depends_on: string[]): Plan {
  const dep: Task = baseTask({ id: DEP_ID, title: "the dependency", depends_on: [] });
  const task = baseTask({ depends_on });
  return { tasks: [task, dep], byId: new Map([[task.id, task], [dep.id, dep]]) };
}

const BRANCH = `run-${TASK_ID}-1789232400000`;

test("W1-T3600: a first push to a run-branch whose task has an unmet dependency is refused, naming it", () => {
  const plan = planWith([DEP_ID]);
  const verdict = evaluateRunBranchEligibility({ headRef: BRANCH, plan, projectionsById: new Map(), reachable: true });

  assert.equal(verdict.applicable, true);
  assert.equal(verdict.admitted, false, "an unmet dependency must refuse the first push");
  assert.match(verdict.reason ?? "", /unmet dependency in the current plan: W1-T9000/);
});

test("W1-T3600: a run-branch for a fully eligible task is admitted", () => {
  // FALSIFIER: this arm must be able to fail. If the check refused every run-branch it would pass
  // this assertion trivially only by refusing — asserting admitted===true against a task with NO
  // dependency at all is what a blanket-refuse implementation cannot satisfy.
  const plan = planWith([]);
  const verdict = evaluateRunBranchEligibility({ headRef: BRANCH, plan, projectionsById: new Map(), reachable: true });

  assert.equal(verdict.applicable, true);
  assert.equal(verdict.admitted, true, "a task with no dependency must be admitted, not refused");
  assert.equal(verdict.reason, undefined);
});

test("W1-T3600: a dependency merged by head branch alone (no trailer) still counts as merged", () => {
  // FALSIFIER: the fixture credits ONLY via `source: "head-branch"` — no trailer entry exists for
  // this dependency anywhere — so a resolver that reads trailers alone must fail this assertion.
  const plan = planWith([DEP_ID]);
  const projectionsById = new Map([[DEP_ID, { merged: true, source: "head-branch" as const, prNumber: 1657 }]]);
  const verdict = evaluateRunBranchEligibility({ headRef: BRANCH, plan, projectionsById, reachable: true });

  assert.equal(verdict.admitted, true, "a head-branch-only credited dependency must not read as unmet");
  assert.equal(verdict.reason, undefined);
});

test("W1-T3600: an unreadable merged surface degrades to unknown and does not refuse", () => {
  // FALSIFIER: the dependency is genuinely unmerged here (empty projection) AND the surface is
  // unreachable — a fail-closed degradation would refuse on the unmet dependency it cannot rule
  // out; this asserts the opposite, so an inverted implementation fails this exact line.
  const plan = planWith([DEP_ID]);
  const verdict = evaluateRunBranchEligibility({ headRef: BRANCH, plan, projectionsById: new Map(), reachable: false });

  assert.equal(verdict.admitted, true, "an unreadable merged surface must admit, never refuse");
  assert.equal(verdict.unknown, true, "the verdict must say the surface was unknown, not silently clean");
});

test("W1-T3600: a branch that names no task is not this check's business", () => {
  const plan = planWith([]);
  const verdict = evaluateRunBranchEligibility({ headRef: "chore/tidy-things", plan, projectionsById: new Map(), reachable: true });

  assert.equal(verdict.applicable, false, "a non-run-shaped branch must pass through untouched");
});
