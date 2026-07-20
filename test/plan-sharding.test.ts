import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, PlanError } from "../src/lib/plan.js";

/**
 * test/plan-sharding.test.ts — W1-T122: PLAN SHARDING (plan/tasks.d/).
 *
 * One task per shard file (plan/tasks.d/<id>.yaml) so two concurrent filings add
 * DIFFERENT files instead of both appending to the single shared EOF of
 * plan/tasks.yaml — the exact collision surface the nine-PR appender train (#271)
 * hit. loadPlan globs plan/tasks.d/*.yaml and merges it with plan/tasks.yaml; every
 * consumer above loadPlan sees one merged view.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function task(id: string, deps: string[] = []): string {
  return `- id: ${id}
  title: ${id} title
  repo: remudero
  depends_on: [${deps.join(", ")}]
  type: implement
  verify: auto
  status: queued
  attempts: 0
`;
}

test("two branches each adding a DIFFERENT shard merge with zero textual conflict", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "rmd-plan-shard-merge-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env: GIT_ENV });

  execFileSync("git", ["init", "-b", "main", repoDir], { encoding: "utf8" });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");

  mkdirSync(join(repoDir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repoDir, "plan", "tasks.yaml"), task("BASE"));
  writeFileSync(join(repoDir, "plan", "tasks.d", ".gitkeep"), "");
  git("add", "-A");
  git("commit", "-m", "base plan");

  git("checkout", "-b", "branch-a");
  writeFileSync(join(repoDir, "plan", "tasks.d", "W1-TA.yaml"), task("W1-TA"));
  git("add", "-A");
  git("commit", "-m", "file shard W1-TA");

  git("checkout", "main");
  git("checkout", "-b", "branch-b");
  writeFileSync(join(repoDir, "plan", "tasks.d", "W1-TB.yaml"), task("W1-TB"));
  git("add", "-A");
  git("commit", "-m", "file shard W1-TB");

  git("checkout", "main");
  git("merge", "--no-ff", "branch-a", "-m", "merge branch-a");
  // The real assertion: merging branch-b (filed concurrently, off the SAME base as
  // branch-a) never conflicts, because it added a different file under tasks.d/.
  assert.doesNotThrow(() => git("merge", "--no-ff", "branch-b", "-m", "merge branch-b"));

  const plan = loadPlan(join(repoDir, "plan", "tasks.yaml"));
  assert.deepEqual(
    plan.tasks.map((t) => t.id).sort(),
    ["BASE", "W1-TA", "W1-TB"],
  );
});

test("a duplicate id across two shards fails loadPlan, preserving the single-file uniqueness guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-shard-dup-"));
  mkdirSync(join(dir, "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "tasks.yaml"), task("BASE"));
  writeFileSync(join(dir, "tasks.d", "a.yaml"), task("DUP"));
  writeFileSync(join(dir, "tasks.d", "b.yaml"), task("DUP"));

  assert.throws(() => loadPlan(join(dir, "tasks.yaml")), PlanError);
});

test("a duplicate id between tasks.yaml and a shard also fails loadPlan", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-shard-dup-main-"));
  mkdirSync(join(dir, "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "tasks.yaml"), task("BASE"));
  writeFileSync(join(dir, "tasks.d", "a.yaml"), task("BASE"));

  assert.throws(() => loadPlan(join(dir, "tasks.yaml")), PlanError);
});

test("the existing single-file plan/tasks.yaml still loads unchanged when tasks.d is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-noshard-"));
  writeFileSync(join(dir, "tasks.yaml"), task("A") + task("B", ["A"]));

  const plan = loadPlan(join(dir, "tasks.yaml"));
  assert.deepEqual(
    plan.tasks.map((t) => t.id),
    ["A", "B"],
  );
});

test("a shard can depend on a task declared in the base tasks.yaml (merged-view dependency resolution)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-shard-deps-"));
  mkdirSync(join(dir, "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "tasks.yaml"), task("BASE"));
  writeFileSync(join(dir, "tasks.d", "dep.yaml"), task("DEP", ["BASE"]));

  const plan = loadPlan(join(dir, "tasks.yaml"));
  assert.deepEqual(plan.byId.get("DEP")?.depends_on, ["BASE"]);
});
