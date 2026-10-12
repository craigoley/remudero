// W1-T7952: a build PR is titled after its task, never after a checkpoint. A branch whose every subject is a
// `wip:` checkpoint was titled by `prTitleFromBranchCommits` with the checkpoint's own words, so W1-T7807 merged
// as "chore: tests and census repairs" (#10785), W1-T6085 as "chore: yield at worker" (#10834), and W1-T8047 as
// "chore: merge main into the restored checkpoint" (#10936), the harness's own restore merge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { checkCommitMessage } from "../src/lib/commit-message.js";
import { isWipSubject, prTitleForTask, prTitleFromBranchCommits } from "../src/lib/unfinished-checkpoint.js";
import { branchPrTitle, restoreBoundaryCheckpoint } from "./helpers/run-task-test.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const RUN_TASK = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

const T7807 = {
  id: "W1-T7807",
  title: "A HUNG WORKER STUCK IN ITS OWN WAIT LOOP IS DETECTED AND RECOVERED — W1-T7734's implement worker polled for a reporter line",
};
const T6085 = {
  id: "W1-T6085",
  title: "PURE TEST FILES SHARE ONE PROCESS — every test file pays its own node + tsx start and loads ~437 src modules",
};
const T6264 = {
  id: "W1-T6264",
  title: "EVERY VIEW'S BUILDS ARE COUNTED, NOT ONLY ITS SLOW ONES — read_model.slow_view logs a build only past its pass budget",
};
const T8047 = {
  id: "W1-T8047",
  title: "EVERY FILE IN A POOLED TEST PROCESS SHARES ONE SLOT DIR, AND NOTHING PROVES THE POOL IS CONTAINED — resolveTestSlotDir memoizes one test-process dir",
};
const YIELD_BODY = "[remudero-context]\ndecided: retain work for restart\nremaining: resume worker\nfailed: none";

/** A run branch whose given commits (oldest first) sit ahead of an `origin/main` ref, as runTask's worktree does. */
function runBranch(messages: readonly string[]): GitRepo {
  const repo = gitRepo({ kind: "titled-after-task" });
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  for (const message of messages) repo.git("commit", "--quiet", "--allow-empty", "-m", message);
  return repo;
}

test("W1-T7952: a checkpoint-only branch is titled after its task", () => {
  const subjects = ["chore(wip): tests and census repairs", "wip: yield at worker", "wip(sweep): add the hook"];
  const title = prTitleForTask(subjects, T6264);
  assert.equal(title, "feat: every view's builds are counted, not only its slow ones (W1-T6264)");
  assert.doesNotMatch(title ?? "", /yield at worker|census repairs|add the hook/, "a checkpoint's words never title a build PR");
  assert.doesNotMatch(title ?? "", /^chore/, "a stripped checkpoint's `chore` type is never used");
  assert.doesNotMatch(title ?? "", /wip/i);

  // The harness half: the open site reads the real branch and passes the task.
  const repo = runBranch([`wip: yield at worker\n\n${YIELD_BODY}`]);
  assert.equal(branchPrTitle(repo.dir), "chore: yield at worker", "without the task, the checkpoint's words (the defect)");
  assert.equal(branchPrTitle(repo.dir, T6264), "feat: every view's builds are counted, not only its slow ones (W1-T6264)");
  assert.match(RUN_TASK, /ghPrCreateFillCommandAsync\(worktreePath, owner, task\.repo, branch, branchPrTitle\(worktreePath, task\)/,
    "runTask's one build-PR open site titles the PR from its task");
});

test("W1-T7952: the #10785 and #10834 branches get their tasks titles", () => {
  // #10785's two commits, newest first, exactly as they merged under W1-T7807.
  const t7807 = ["chore(wip): tests and census repairs", "chore(wip): quiet worker watchdog module and wiring"];
  assert.equal(prTitleFromBranchCommits(t7807), "chore: tests and census repairs", "the reproduced #10785 title");
  assert.equal(prTitleForTask(t7807, T7807), "feat: a hung worker stuck in its own wait loop is detected and recovered (W1-T7807)");

  // #10834's branch as it OPENED: the restart checkpoint alone (the fix round came after).
  const t6085 = ["wip: yield at worker"];
  assert.equal(prTitleFromBranchCommits(t6085), "chore: yield at worker", "the reproduced #10834 title");
  assert.equal(prTitleForTask(t6085, T6085), "feat: pure test files share one process (W1-T6085)");
});

test("W1-T7952: a fix round commit does not replace the task title", () => {
  const subjects = ["fix(test): blank coverage env and carry pure-test-pool in tier fixtures (W1-T6085)", "wip: yield at worker"];
  const title = prTitleForTask(subjects, T6085) ?? "";
  assert.equal(title, "fix(test): pure test files share one process (W1-T6085)", "the type and scope may come from the real commit");
  assert.doesNotMatch(title, /blank coverage env/, "the fix round's words never become the title");
  assert.equal(prTitleForTask(["wip: another checkpoint", ...subjects], T6085), title, "a later checkpoint lends nothing either");
  // On a real branch, the fix round's commit is the newest, and the PR still names the task.
  const repo = runBranch([`wip: yield at worker\n\n${YIELD_BODY}`, subjects[0]!]);
  assert.equal(branchPrTitle(repo.dir), subjects[0], "without the task, the fix round's words (the defect)");
  assert.equal(branchPrTitle(repo.dir, T6085), title);
});

test("W1-T7952: a restored checkpoint merge subject never titles the PR", async () => {
  // #10936's branch, newest first: the harness's restore merge over two restart checkpoints.
  const t8047 = ["wip: merge main into the restored checkpoint", "wip: yield at checkpoint", "wip: yield at worker"];
  assert.equal(prTitleFromBranchCommits(t8047), "chore: merge main into the restored checkpoint", "the reproduced #10936 title");
  const expected = prTitleForTask(["wip: yield at worker"], T8047)!;
  assert.match(expected, /^feat: every file in a pooled test process shares one slot dir, .*… \(W1-T8047\)$/);
  assert.equal(prTitleForTask(t8047, T8047), expected);
  // An UNMARKED merge subject lends neither its words nor its type, and neither does git's own merge subject.
  assert.equal(prTitleForTask(["chore: merge main into the restored checkpoint", ...t8047.slice(1)], T8047), expected);
  assert.equal(prTitleForTask(["Merge remote-tracking branch 'origin/main' into run-W1-T8047-1", "wip: yield at worker"], T8047), expected);

  // End to end: restoreBoundaryCheckpoint merges a moved main into a real checkpoint branch, and the PR still names the task.
  const repo = gitRepo({ kind: "restored-merge-title" });
  const base = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "--quiet", "-b", "run-W1-T8047-1");
  repo.git("commit", "--quiet", "--allow-empty", "-m", `wip: yield at worker\n\n${YIELD_BODY}`);
  repo.git("commit", "--quiet", "--allow-empty", "-m", `wip: yield at checkpoint\n\n${YIELD_BODY}`);
  const checkpointSha = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "--quiet", "main");
  repo.git("commit", "--quiet", "--allow-empty", "-m", "fix(other): main moved on");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("remote", "add", "origin", repo.dir);
  const restored = await restoreBoundaryCheckpoint({ branch: "run-W1-T8047-1", headSha: checkpointSha }, T8047.id, async (args) => repo.git(...args));
  assert.equal(restored.base, "main");
  assert.equal(repo.git("rev-list", "--count", "--merges", `${base}..HEAD`), "1", "the restore wrote a real merge commit");
  const mergeSubject = repo.git("log", "-1", "--format=%s");
  assert.ok(isWipSubject(mergeSubject), `the restore merge stays a checkpoint: ${mergeSubject}`);
  assert.deepEqual(checkCommitMessage(mergeSubject), [], "the restore merge's own subject is a valid conventional header");
  assert.equal(branchPrTitle(repo.dir), "chore: merge main into the restored checkpoint", "without the task, the merge's words (the defect)");
  assert.equal(branchPrTitle(repo.dir, T8047), expected);
  // A later merge of main whose subject reads like a real change lends no type either: merges are not read at all.
  const restoredHead = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "--quiet", "--detach", "origin/main");
  repo.git("commit", "--quiet", "--allow-empty", "-m", "fix(other): main moved again");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("checkout", "--quiet", "--detach", restoredHead);
  repo.git("merge", "--quiet", "--no-ff", "-m", "fix(sync): bring the newest main in", "origin/main");
  assert.equal(branchPrTitle(repo.dir, T8047), expected);
});

test("W1-T7952: a task-derived title passes the conventional header checks", () => {
  const long = {
    id: "W1-T7952",
    title: "A BUILD PR IS TITLED AFTER ITS TASK, NEVER AFTER A CHECKPOINT, WHATEVER ITS WORKER NAMED THE COMMITS IT LEFT ON ITS BRANCH BEFORE IT STOPPED.",
  };
  const titles = [
    prTitleForTask(["wip: yield at worker"], long),
    prTitleForTask(["refactor(run-task): move the open site"], long),
    prTitleForTask(["not a conventional header"], long),
    prTitleForTask(["wip: yield at worker"], T7807),
    prTitleForTask(["wip: yield at worker"], T6264),
    prTitleForTask([], { id: "W1-T7952", title: "A TASK — lead ends here — later rationale." }),
  ];
  for (const title of titles) {
    assert.ok(title, "a filed task always yields a title");
    assert.ok(title.length <= 100, `header-max-length 100: ${title.length} chars in ${JSON.stringify(title)}`);
    assert.deepEqual(checkCommitMessage(title), [], `checkCommitMessage refuses ${JSON.stringify(title)}`);
  }
  assert.match(titles[0]!, /… \(W1-T7952\)$/, "a trimmed title still names its task");
  assert.match(titles[1]!, /^refactor\(run-task\): a build pr is titled after its task/);
  assert.match(titles[2]!, /^feat: /, "an unconventional subject lends no type");
  assert.equal(titles[5], "feat: a task (W1-T7952)");
  assert.equal(prTitleForTask(["wip: x"], { id: "W1-T1", title: "  " }), undefined, "no shard title, no task title");
});

test("W1-T7952: an unreadable branch still titles a filed PR after its task", () => {
  const repo = gitRepo({ kind: "titled-after-task" }); // no origin/main: the range is unreadable
  repo.git("commit", "--quiet", "--allow-empty", "-m", "fix(run): terminal subject");
  assert.equal(branchPrTitle(repo.dir, T6085), "fix(run): pure test files share one process (W1-T6085)");
  assert.equal(branchPrTitle(repo.dir), "fix(run): terminal subject", "with no task, the tip subject as before");
  const missing = join(repo.dir, "no-such-worktree");
  assert.equal(branchPrTitle(missing, T6085), "feat: pure test files share one process (W1-T6085)");
  assert.equal(branchPrTitle(missing), undefined);
  assert.equal(branchPrTitle(runBranch(["wip: x"]).dir, { id: "W1-T1", title: "" }), "chore: x", "a titleless task keeps the branch title");
});
