import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommitMessage } from "../src/lib/commit-message.js";
import * as checkpoint from "../src/lib/unfinished-checkpoint.js";
import { branchPrTitle } from "./helpers/run-task-test.js";
import { gitRepo } from "./helpers/git-repo.js";

type TaskTitle = { id: string; title: string };

function titleFor(subjects: readonly string[], task: TaskTitle): string {
  const derive = (checkpoint as Record<string, unknown>).prTitleForTask;
  assert.equal(typeof derive, "function", "prTitleForTask must be exported");
  return (derive as (subjects: readonly string[], task: TaskTitle) => string)(subjects, task);
}

function branchTitle(subjects: readonly string[], task?: TaskTitle, withBase = true): string | undefined {
  const repo = gitRepo();
  try {
    if (withBase) repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    for (const subject of [...subjects].reverse()) repo.git("commit", "--quiet", "--allow-empty", "-m", subject);
    return branchPrTitle(repo.dir, task);
  } finally {
    repo.cleanup();
  }
}

test("W1-T7952: a checkpoint-only branch is titled after its task", () => {
  const task = { id: "W1-T7952", title: "A BUILD PR IS TITLED AFTER ITS TASK, NEVER AFTER A CHECKPOINT — incident detail" };
  const expected = "feat: a build pr is titled after its task, never after a checkpoint (W1-T7952)";
  for (const subjects of [["wip: yield at worker"], ["chore(wip): tests and census repairs", "wip(run): start"]]) {
    assert.equal(titleFor(subjects, task), expected);
    assert.equal(branchTitle(subjects, task), expected);
  }
  assert.equal(titleFor(["", "  "], task), expected);
  assert.equal(branchTitle([], task), expected);
});

test("W1-T7952: the #10785 and #10834 branches get their tasks titles", () => {
  const watchdog = { id: "W1-T7807", title: "A HUNG WORKER STUCK IN ITS OWN WAIT LOOP IS DETECTED AND RECOVERED — watchdog detail" };
  const pool = { id: "W1-T6085", title: "PURE TEST FILES SHARE ONE PROCESS — pool detail" };
  const cases = [
    { task: watchdog, subjects: ["chore(wip): tests and census repairs", "chore(wip): quiet worker watchdog module and wiring"],
      expected: "feat: a hung worker stuck in its own wait loop is detected and recovered (W1-T7807)" },
    { task: pool, subjects: ["wip: yield at worker"], expected: "feat: pure test files share one process (W1-T6085)" },
  ];
  for (const { task, subjects, expected } of cases) {
    assert.equal(titleFor(subjects, task), expected);
    assert.equal(branchTitle(subjects, task), expected);
  }
});

test("W1-T7952: a fix round commit does not replace the task title", () => {
  const task = { id: "W1-T6085", title: "PURE TEST FILES SHARE ONE PROCESS — pool detail" };
  const subjects = ["fix(test): blank coverage env and carry pure-test-pool in tier fixtures (W1-T6085)", "wip: yield at worker"];
  const expected = "fix(test): pure test files share one process (W1-T6085)";
  assert.equal(titleFor(subjects, task), expected);
  assert.equal(branchTitle(subjects, task), expected);
  assert.equal(titleFor(["wip: another checkpoint", ...subjects], task), expected);
  assert.equal(titleFor(["docs: explain the pool", ...subjects], task), "docs: pure test files share one process (W1-T6085)");
});

test("W1-T7952: a task-derived title passes the conventional header checks", () => {
  for (const title of ["A TASK WITHOUT A DASH", "A TASK — lead ends here — later rationale", "A VERY LONG SHARD TITLE ".repeat(15)]) {
    for (const subjects of [[], ["wip: start"], ["fix(run): repair"], ["not a conventional header"]]) {
      const header = titleFor(subjects, { id: "W1-T7952", title });
      assert.deepEqual(checkCommitMessage(header), []);
      assert.ok(header.length <= 100, header);
      assert.ok(header.endsWith(" (W1-T7952)"), header);
    }
  }
  assert.equal(titleFor([], { id: "W1-T7952", title: "A TASK WITHOUT A DASH" }), "feat: a task without a dash (W1-T7952)");
  assert.equal(titleFor([], { id: "W1-T7952", title: "A TASK — lead ends here — later rationale" }), "feat: a task (W1-T7952)");
});

test("task-aware branch titles retain the task when the git range or tip is unreadable", () => {
  const task = { id: "W1-T7952", title: "A BUILD PR IS TITLED AFTER ITS TASK" };
  assert.equal(branchTitle(["fix(run): terminal subject"], task, false), "fix(run): a build pr is titled after its task (W1-T7952)");
  assert.equal(branchPrTitle(new URL("./missing-title-worktree", import.meta.url).pathname, task), "feat: a build pr is titled after its task (W1-T7952)");
});

test("branch titles without a task retain the existing checkpoint and fallback behaviour", () => {
  assert.equal(branchTitle(["wip: yield at worker"]), "chore: yield at worker");
  assert.equal(branchTitle(["wip: latest", "fix(run): terminal subject"]), "fix(run): terminal subject");
  assert.equal(branchTitle([]), "initial commit");
  assert.equal(branchTitle(["fix(run): terminal subject"], undefined, false), "fix(run): terminal subject");
  assert.equal(branchPrTitle(new URL("./missing-title-worktree", import.meta.url).pathname), undefined);
});
