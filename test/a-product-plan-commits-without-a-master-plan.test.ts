import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlanProposalCommit, applyPlanProposalCommitAsync } from "#src/lib/plan-architect.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repository with one committed plan shard and, when `masterPlan`, a committed MASTER-PLAN.md. */
function repo(t: { after: (fn: () => void) => void }, masterPlan: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t14413-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.d", "WRECK-T2.yaml"), "- id: WRECK-T2\n  title: before\n");
  if (masterPlan) writeFileSync(join(dir, "MASTER-PLAN.md"), "# plan\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

const committed = (dir: string) => git(dir, "show", "--name-status", "--format=%s", "HEAD").trim().split("\n").filter(Boolean);

const commits = [
  ["sync", (dir: string, message: string) => { applyPlanProposalCommit(dir, message); return Promise.resolve(); }],
  ["async", (dir: string, message: string) => applyPlanProposalCommitAsync(dir, message)],
] as const;

for (const [name, commit] of commits) {
  test(`W1-T14413 criterion 1: in a repository with no MASTER-PLAN.md, the ${name} commit commits the plan/ changes`, async (t) => {
    const dir = repo(t, false);
    writeFileSync(join(dir, "plan", "tasks.d", "WRECK-T2.yaml"), "- id: WRECK-T2\n  title: clarified\n");
    writeFileSync(join(dir, "plan", "tasks.d", "WRECK-T7.yaml"), "- id: WRECK-T7\n  title: new\n");
    await commit(dir, "plan: clarify WRECK-T2");
    assert.deepEqual(committed(dir), ["plan: clarify WRECK-T2", "M\tplan/tasks.d/WRECK-T2.yaml", "A\tplan/tasks.d/WRECK-T7.yaml"]);
    assert.equal(git(dir, "status", "--porcelain"), "", "nothing is left unstaged");
  });

  test(`W1-T14413 criterion 2: with MASTER-PLAN.md changed or deleted, the ${name} commit stages it as before`, async (t) => {
    const changed = repo(t, true);
    writeFileSync(join(changed, "MASTER-PLAN.md"), "# plan\n\n## a new section\n");
    writeFileSync(join(changed, "plan", "tasks.d", "WRECK-T2.yaml"), "- id: WRECK-T2\n  title: clarified\n");
    writeFileSync(join(changed, "outside.txt"), "not plan scope\n");
    await commit(changed, "plan: a new section");
    assert.deepEqual(committed(changed), ["plan: a new section", "M\tMASTER-PLAN.md", "M\tplan/tasks.d/WRECK-T2.yaml"]);
    assert.equal(git(changed, "status", "--porcelain").trim(), "?? outside.txt", "a path outside plan scope is still never staged");

    const deleted = repo(t, true);
    rmSync(join(deleted, "MASTER-PLAN.md"));
    await commit(deleted, "plan: drop the master plan");
    assert.deepEqual(committed(deleted), ["plan: drop the master plan", "D\tMASTER-PLAN.md"], "a tracked deletion still stages");
  });
}

test("W1-T14413: any other refusal of the add reaches the caller unchanged", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t14413-bare-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "plan"));
  writeFileSync(join(dir, "plan", "a.yaml"), "a\n");
  // No repository: the add is refused for a reason that is not the absent master plan, so nothing is retried.
  const steps: string[] = [];
  assert.throws(() => applyPlanProposalCommit(dir, "plan: x", (step) => steps.push(step)), /refusing a host git call/);
  await assert.rejects(applyPlanProposalCommitAsync(dir, "plan: x", (step) => steps.push(step)), /refusing a host git call/);
  assert.ok(!steps.includes("plan_commit.optional_path_absent"), steps.join(", "));
});
