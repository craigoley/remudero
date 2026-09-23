/**
 * test/lint-plan-fast-scopes-to-the-merge-base.test.ts — W1-T4381.
 *
 * `lint-plan:fast` ran `lint-plan --base origin/main`, which diffs the checkout against main's TIP.
 * A plan record main changed after a branch forked therefore read as changed IN THE BRANCH, and was
 * linted in the branch's older copy: PR #6737 went red twice naming W1-T115 and W1-T67, records
 * main had just reconciled and the PR never touched. `--merge-base` scopes to the fork point.
 *
 * Each test builds a real repo (fork commit, a later main commit, a branch checked out) and drives
 * the real `lintPlanCommand` with `repoRoot` pointed at it. The network seams are stubbed exactly as
 * test/base-lint-attributes-pre-existing-violations.test.ts stubs them.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { lintPlanCommand, lintScopeMergeBase } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const LINT_DEPS = {
  offline: true,
  loadConfig: (() => ({ root: "/synthetic" })) as never,
  resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
  ghGateway: (() => ({})) as never,
  projectPlan: ((plan: { tasks: { id: string }[] }) =>
    new Map(plan.tasks.map((t) => [t.id, { merged: false }]))) as never,
};

// A vibe proof trips proof-shape and proof-dialect, both BLOCK; a `unit test:` proof trips neither.
const BROKEN_PROOF = "works";
const CLEAN_PROOF = "unit test: test/w1-t4381-fixture.test.ts";

const task = (id: string, title: string, proof: string) =>
  [
    `- id: ${id}`,
    `  title: "${title}"`,
    `  repo: remudero`,
    `  depends_on: []`,
    `  type: implement`,
    `  verify: human`,
    `  risk: high`,
    `  status: queued`,
    `  origin: "W1-T4381 test fixture"`,
    `  acceptance:`,
    `    - claim: "something is proven"`,
    `      proof: "${proof}"`,
    ``,
  ].join("\n");

function writePlan(repo: GitRepo, records: string[]): void {
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), records.join(""), "utf8");
}

function commitPlan(repo: GitRepo, records: string[], message: string): void {
  writePlan(repo, records);
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-q", "-m", message);
}

/** main: the fork commit carries ZZ-Landmine BROKEN, then main fixes it. The branch forks before
 *  the fix and is checked out, so it still carries the broken copy it never touched. */
function planFork(): GitRepo {
  const repo = gitRepo({ kind: "w1-t4381" });
  mkdirSync(join(repo.dir, "plan"));
  commitPlan(repo, [task("ZZ-Landmine", "landmine", BROKEN_PROOF), task("ZZ-Clean", "clean", CLEAN_PROOF)], "fork");
  repo.git("branch", "feature");
  commitPlan(repo, [task("ZZ-Landmine", "landmine", CLEAN_PROOF), task("ZZ-Clean", "clean", CLEAN_PROOF)], "main fixes the landmine");
  repo.git("checkout", "-q", "feature");
  return repo;
}

async function lint(repo: GitRepo, args: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    const code = await lintPlanCommand(args, { ...LINT_DEPS, repoRoot: repo.dir } as never);
    return { code, out };
  } finally {
    Object.assign(console, orig);
  }
}

test("W1-T4381: a record main changed after the fork is not linted as this branchs change", async () => {
  const repo = planFork();
  commitPlan(repo, [task("ZZ-Landmine", "landmine", BROKEN_PROOF), task("ZZ-Clean", "clean, edited on the branch", CLEAN_PROOF)], "branch edit");

  // CONTROL: the tip diff is the defect this task fixes, so it must still reproduce it.
  const tip = await lint(repo, ["--base", "main"]);
  assert.equal(tip.code, 1, `the tip diff must still blame the branch:\n${tip.out.join("\n")}`);
  assert.ok(tip.out.some((l) => l.startsWith("✗ ZZ-Landmine:")), tip.out.join("\n"));

  const scoped = await lint(repo, ["--base", "main", "--merge-base"]);
  assert.equal(scoped.code, 0, `a record only main changed must not fail the branch:\n${scoped.out.join("\n")}`);
  assert.ok(!scoped.out.some((l) => l.includes("ZZ-Landmine")), scoped.out.join("\n"));
  const forkSha = repo.git("merge-base", "main", "HEAD");
  const summary = scoped.out.find((l) => /new\/changed vs main at merge-base /.test(l));
  assert.ok(summary, `the run must name its merge-base scope:\n${scoped.out.join("\n")}`);
  assert.match(summary!, new RegExp(`1 new/changed vs main at merge-base ${forkSha.slice(0, 12)}`));
});

test("W1-T4381: a record the branch changed is still in scope", async () => {
  const repo = planFork();
  commitPlan(repo, [task("ZZ-Landmine", "landmine", BROKEN_PROOF), task("ZZ-Clean", "clean, broken on the branch", BROKEN_PROOF)], "branch breaks clean");

  const scoped = await lint(repo, ["--base", "main", "--merge-base"]);
  assert.equal(scoped.code, 1, `the branch's own violation must still fail:\n${scoped.out.join("\n")}`);
  const line = scoped.out.find((l) => l.startsWith("✗ ZZ-Clean:"));
  assert.ok(line, scoped.out.join("\n"));
  assert.match(line!, /\(0 pre-existing on base main at merge-base [0-9a-f]{12}\)/);
  assert.ok(!scoped.out.some((l) => l.startsWith("✗ ZZ-Landmine:")), scoped.out.join("\n"));
});

test("W1-T4381: with no merge-base the scope stays at the ref itself and says so", () => {
  const out: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    const got = lintScopeMergeBase("/nowhere", "origin/main", () => {
      throw new Error("fatal: no merge base\nsecond line");
    });
    assert.equal(got, "origin/main");
  } finally {
    console.error = orig;
  }
  assert.equal(out.length, 1);
  assert.match(out[0]!, /no merge-base of origin\/main and HEAD \(fatal: no merge base\) — scoping to origin\/main itself/);
});

test("W1-T4381: the default git seam really answers the merge-base", () => {
  const repo = planFork();
  assert.equal(lintScopeMergeBase(repo.dir, "main"), repo.git("merge-base", "main", "HEAD"));
});
