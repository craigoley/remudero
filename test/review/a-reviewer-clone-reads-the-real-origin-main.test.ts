/**
 * W1-T11343 — a semantic reviewer's disposable clone reads the source's OWN origin/main.
 *
 * `git clone <source>` maps the source's refs/heads/* to the clone's refs/remotes/origin/*, so
 * the clone's origin/main was the source's LOCAL main. The daemon never moves that branch, and
 * on 2026-11-04 every reviewer clone's origin/main was a commit from 2026-10-16. A pin test that
 * reads `git merge-base origin/main HEAD` then compared against that old base and grew to
 * 19.2 GiB. These fixtures give the source a local main that lags its origin/main.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeReviewerSnapshot } from "#src/cli/commands/review.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

function commit(repo: GitRepo, name: string): string {
  writeFileSync(join(repo.dir, `${name}.txt`), `${name}\n`);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", name);
  return repo.git("rev-parse", "HEAD");
}

/** A source whose local main sits at its first commit, origin/main three commits later, and
 *  HEAD one PR commit on top of origin/main. */
function laggingSource(): { repo: GitRepo; staleMain: string; originMain: string; head: string } {
  const repo = gitRepo({ kind: "reviewer-origin-main" });
  const staleMain = repo.git("rev-parse", "HEAD");
  for (const name of ["one", "two", "three"]) commit(repo, name);
  const originMain = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", originMain);
  repo.git("checkout", "--quiet", "-b", "pr");
  const head = commit(repo, "pr-change");
  repo.git("branch", "--force", "main", staleMain);
  return { repo, staleMain, originMain, head };
}

const reviewRoot = (): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reviewer-origin-main-root-`));
const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

test("the reviewer clone's origin/main and merge base equal the source's, not its stale local main", () => {
  const { repo, staleMain, originMain, head } = laggingSource();
  assert.notEqual(staleMain, originMain, "the control: the source's local main lags its origin/main");
  const sourceBase = repo.git("merge-base", "origin/main", "HEAD");
  assert.equal(sourceBase, originMain);

  const snapshot = materializeReviewerSnapshot(reviewRoot(), repo.dir, head);

  assert.equal(gitIn(snapshot.cwd, "rev-parse", "HEAD"), head);
  assert.equal(gitIn(snapshot.cwd, "rev-parse", "refs/remotes/origin/main"), originMain);
  assert.equal(gitIn(snapshot.cwd, "merge-base", "origin/main", "HEAD"), sourceBase);
  assert.equal(snapshot.originMain, originMain);
});

test("a source with no origin/main leaves the clone with no origin/main ref", () => {
  const { repo, head } = laggingSource();
  repo.git("update-ref", "-d", "refs/remotes/origin/main");

  const snapshot = materializeReviewerSnapshot(reviewRoot(), repo.dir, head);

  assert.equal(gitIn(snapshot.cwd, "rev-parse", "HEAD"), head);
  assert.equal(gitIn(snapshot.cwd, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/main"), "");
  assert.equal(snapshot.originMain, null);
});
