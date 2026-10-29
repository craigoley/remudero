/**
 * THE MERGED PLAN IS READ BY BLOB ID, NOT BY `<tree>:<path>`.
 *
 * In 48 h to 2026-10-28 the direct-merge preflight refused 74 times on 50 PRs with "git cat-file --batch
 * exited null, killed by SIGTERM (its bound)". mergedTreePlanSteps asked the batch for every shard as
 * `<tree>:plan/tasks.d/<name>`, and git re-resolves each such path through tasks.d's 4,577-entry tree:
 * about 10 s for the whole plan, against 0.2 s for the same blobs asked by id. One `git ls-tree` now
 * lists each blob id, and the batch asks for the ids.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { runStepsSync } from "#src/lib/git-push.js";
import { planSafetyGitSync, readPlanMergeSafetySteps, type PlanSafetyGit } from "#src/lib/plan-pr-merge-safety.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TARGET = { owner: "craigoley", repo: "remudero", prNumber: 7 };

function shard(id: string): string {
  return `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  status: queued\n  attempts: 0\n`;
}

/** Main and a PR head that each add a shard over `count` base shards; `monolith` false leaves plan/tasks.yaml out. */
function fixture(t: TestContext, count: number, monolith = true): { dir: string; main: string; head: string } {
  const repo = gitRepo({ kind: "blob-id-read" });
  t.after(() => repo.cleanup());
  const put = (name: string) => writeFileSync(join(repo.dir, "plan", "tasks.d", `${name}.yaml`), shard(name));
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  if (monolith) writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "[]\n");
  for (let i = 1; i <= count; i++) put(`W1-T${i}`);
  writeFileSync(join(repo.dir, "plan", "tasks.d", "README.md"), "not a shard\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "base");
  repo.git("checkout", "-qb", "pr");
  put("W1-T9001");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "pr");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  put("W1-T9002");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main");
  return { dir: repo.dir, main: repo.git("rev-parse", "HEAD"), head };
}

function restFor(main: string, head: string) {
  return (a: string[]) =>
    String(a[1]).endsWith(`/pulls/${TARGET.prNumber}`) ? { base: { ref: "main" }, head: { sha: head } }
      : String(a[1]).includes("compare/main") ? { base_commit: { sha: main }, merge_base_commit: { sha: main }, files: [{ filename: "plan/feedback/x.yaml" }] }
      : { files: [{ filename: "plan/tasks.d/W1-T9001.yaml" }] };
}

/** The real sync runner, keeping what the batch was asked. */
function recording(dir: string): { git: PlanSafetyGit; batches: string[] } {
  const real = planSafetyGitSync(dir);
  const batches: string[] = [];
  return {
    batches,
    git: (args, stdin) => {
      if (args[0] === "cat-file" && args[1] === "--batch") batches.push(String(stdin));
      return real(args, stdin);
    },
  };
}

test("the merged plan's batch asks for blob ids only, and the merged plan still loads", (t) => {
  const { dir, main, head } = fixture(t, 300);
  const { git, batches } = recording(dir);

  const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, restFor(main, head), git));

  assert.deepEqual(reading.mergedTree, { state: "loads" });
  assert.equal(batches.length, 1, "one batch read for the whole plan");
  const lines = batches[0]!.split("\n").filter(Boolean);
  assert.equal(lines.length, 1 + 300 + 2, "the monolith, the base shards and both new shards; README.md is not a shard");
  for (const line of lines) assert.match(line, /^[0-9a-f]{40,64}$/, `asked by id, never by <tree>:<path>: ${line}`);
});

test("a merged tree with no monolith is still unreadable, in git's own `missing`", (t) => {
  const { dir, main, head } = fixture(t, 3, false);
  const { git, batches } = recording(dir);

  const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, restFor(main, head), git));

  assert.equal(reading.mergedTree?.state, "unreadable");
  assert.match((reading.mergedTree as { error: string }).error, /^the batch read was unusable: .*:plan\/tasks\.yaml \(.*:plan\/tasks\.yaml missing\)/);
  assert.match(batches[0]!.split("\n")[0]!, /^[0-9a-f]{40,64}:plan\/tasks\.yaml$/, "the absent monolith alone is asked by path");
});

test("a listing line ls-tree should never print is unreadable, naming the line", () => {
  const tree = "a".repeat(40);
  const git: PlanSafetyGit = (args) =>
    args[0] === "merge-tree" ? { status: 0, stdout: `${tree}\n` }
      : args[0] === "ls-tree" ? { status: 0, stdout: "plan/tasks.d/W1-T1.yaml\n" }
      : { status: 0, stdout: "" };

  const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, restFor("m".repeat(40), "h".repeat(40)), git));

  assert.deepEqual(reading.mergedTree, { state: "unreadable", error: "git ls-tree gave an unusable line: plan/tasks.d/W1-T1.yaml" });
});
