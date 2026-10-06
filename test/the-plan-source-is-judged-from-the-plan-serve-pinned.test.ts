// 2026-10-06 measurement: one serve generation reloaded core's plan in place eight times in an hour, yet
// 74 of 74 `now` reads that hour were stale with source `plan:core` phase `behind`. gitPlanBehind compared
// the generation's working tree HEAD, which never moves, with origin/main, so every plan merge after the
// generation booted read as unserved even after serve had pinned the plan to the merge that carries it.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitPlanBehind, planSource } from "../src/lib/now-view.js";
import type { Plan } from "../src/lib/plan.js";
import { publishThreadPlan, threadPlanPinnedRef } from "../src/lib/thread-plan.js";
import { PLAN_BUDGET_MS } from "../src/lib/view-freshness.js";
import { gitRepo } from "./helpers/git-repo.js";

/** A generation's checkout: HEAD at its boot commit while origin/main has gained one plan-only commit. */
function generationSlot(t: { after(fn: () => void): void }): { dir: string; planPath: string; boot: string; merged: string; mergedMs: number } {
  const repo = gitRepo({ kind: "plan-pin-behind" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  const planPath = join(repo.dir, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "boot");
  const boot = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9.yaml"), "[]\n");
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "a plan merge after boot");
  const merged = repo.git("rev-parse", "HEAD");
  const mergedMs = Number(repo.git("log", "-1", "--format=%ct")) * 1000;
  repo.git("update-ref", "refs/remotes/origin/main", merged);
  repo.git("reset", "-q", "--hard", boot);
  return { dir: repo.dir, planPath, boot, merged, mergedMs };
}

test("a plan serve reloaded at origin/main reads fresh though the generation checkout is behind", (t) => {
  const slot = generationSlot(t);
  const late = slot.mergedMs + PLAN_BUDGET_MS + 60_000;
  // Unpinned, the checkout is the plan served: one merge behind, stale once past the budget.
  const unpinned = gitPlanBehind(slot.planPath, {});
  assert.deepEqual(unpinned, { commits: 1, sinceMs: slot.mergedMs });
  assert.equal(planSource("plan:core", unpinned, late).phase, "behind");

  publishThreadPlan({ path: slot.planPath, repoDir: slot.dir, ref: slot.merged }, { plan: { tasks: [] } as unknown as Plan, quarantined: [] });
  assert.equal(threadPlanPinnedRef(slot.planPath), slot.merged);
  const pinned = gitPlanBehind(slot.planPath, {});
  assert.deepEqual(pinned, { commits: 0 }, "the pinned plan holds origin/main's plan commit");
  const judged = planSource("plan:core", pinned, late);
  assert.deepEqual([judged.state, judged.phase], ["fresh", undefined], `the pinned plan is not behind: ${JSON.stringify(judged)}`);
});

test("a plan pinned to an older merge is behind by only the plan commits after its pin", (t) => {
  const slot = generationSlot(t);
  assert.deepEqual(gitPlanBehind(slot.planPath, {}, undefined, slot.boot), { commits: 1, sinceMs: slot.mergedMs }, "an explicit base is the comparison's left side");
  assert.deepEqual(gitPlanBehind(slot.planPath, {}, undefined, slot.merged), { commits: 0 });
});
