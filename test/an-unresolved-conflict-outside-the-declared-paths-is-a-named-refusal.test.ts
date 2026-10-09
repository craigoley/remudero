/**
 * test/an-unresolved-conflict-outside-the-declared-paths-is-a-named-refusal.test.ts — W1-T5868.
 *
 * A merge of current main can conflict in a file the task never declared. On the non-guarded path the
 * harness's bare `git commit` THREW on it (a generic error, no strike naming the file). The commit
 * now refuses by name, through the existing strike path, and a fully resolved merge still commits
 * with main as its second parent. Real git throughout.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "./helpers/git-repo.js";
import {
  commitWorkerEdits, harnessCommitForShellLessWorker, UNRESOLVED_CONFLICT_REFUSAL_PREFIX,
} from "./helpers/run-task-commit-seam.js";

const DECLARED = "declared.txt";
const OUTSIDE = "outside.txt";

/** A branch and main both edited two files; the merge of main is started and left conflicted in both. */
function conflictedMerge(): { repo: GitRepo; branchSha: string; mainSha: string } {
  const repo = gitRepo({ kind: "w1t5868" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  for (const file of [DECLARED, OUTSIDE]) writeFileSync(join(repo.dir, file), "base\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "base");
  repo.git("checkout", "-q", "-b", "side");
  for (const file of [DECLARED, OUTSIDE]) writeFileSync(join(repo.dir, file), "main edit\n");
  repo.git("commit", "-qam", "main edit");
  const mainSha = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  repo.git("checkout", "-q", "-b", "run-W1-T5868X-1");
  for (const file of [DECLARED, OUTSIDE]) writeFileSync(join(repo.dir, file), "branch edit\n");
  repo.git("commit", "-qam", "branch edit");
  const branchSha = repo.git("rev-parse", "HEAD");
  assert.throws(() => repo.git("merge", "--no-commit", "--no-ff", "side"));
  return { repo, branchSha, mainSha };
}

for (const guarded of [false, true]) {
  const options = (f: { branchSha: string }) => guarded ? { priorHeadSha: f.branchSha, branch: "run-W1-T5868X-1" } : {};
  const mode = guarded ? "guarded" : "non-guarded";

  test(`a merge round leaving an unmerged file outside the declared paths is refused by name (${mode})`, () => {
    const f = conflictedMerge();
    // The worker resolved only the declared file; the other one still holds markers.
    writeFileSync(join(f.repo.dir, DECLARED), "resolved\n");
    let result: ReturnType<typeof commitWorkerEdits> | undefined;
    assert.doesNotThrow(() => {
      result = commitWorkerEdits(f.repo.dir, [DECLARED], "fix: merge main", {}, [], options(f));
    });
    assert.equal(result!.committed, false);
    assert.deepEqual(result!.conflictMarkerFiles, [OUTSIDE]);
    assert.ok(result!.reason?.startsWith(UNRESOLVED_CONFLICT_REFUSAL_PREFIX), result!.reason);
    assert.ok(result!.reason?.includes(OUTSIDE));
    assert.equal(f.repo.git("rev-parse", "HEAD"), f.branchSha, "nothing was committed");
    assert.match(f.repo.git("status", "--porcelain", "--", DECLARED), /^UU /, "the declared path was not staged either");
  });

  test(`the refusal counts as a failed strike through the harness commit, with no thrown error (${mode})`, () => {
    const f = conflictedMerge();
    writeFileSync(join(f.repo.dir, DECLARED), "resolved\n");
    const refusals: { reason: string; files: readonly string[] | undefined }[] = [];
    let count = -1;
    assert.doesNotThrow(() => {
      count = harnessCommitForShellLessWorker({
        harnessOwnsGit: true, commitCount: 0, report: "COMMIT_MESSAGE: fix(x): merge main",
        worktreePath: f.repo.dir, declaredPaths: [DECLARED], requireMergeHead: true, ...options(f),
        log: () => {}, say: () => {},
        onRefusal: (reason, _undeclared, files) => refusals.push({ reason, files }),
      });
    });
    assert.equal(count, 0, "no commit landed");
    assert.equal(refusals.length, 1);
    assert.deepEqual(refusals[0]!.files, [OUTSIDE]);
    assert.ok(refusals[0]!.reason.includes(OUTSIDE));
  });

  test(`a fully resolved merge commits with main as its second parent (${mode})`, () => {
    const f = conflictedMerge();
    writeFileSync(join(f.repo.dir, DECLARED), "resolved\n");
    writeFileSync(join(f.repo.dir, OUTSIDE), "resolved too\n");
    const result = commitWorkerEdits(f.repo.dir, [DECLARED, OUTSIDE], "fix: merge main", {}, [], options(f));
    assert.equal(result.committed, true, result.reason);
    assert.equal(f.repo.git("rev-parse", "HEAD^1"), f.branchSha);
    assert.equal(f.repo.git("rev-parse", "HEAD^2"), f.mainSha);
  });
}
