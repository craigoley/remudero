// #11708 (2026-10-14): GitHub served refs/pull/11708/merge but never created refs/pull/11708/head for a
// REST-opened PR. The review's materializer fetched only the pull ref, so it built no head checkout and the
// review posted a keyword-only FAIL ("id W1-T9483 reservation unreadable (UNKNOWN)") on a correct filing.
// The head commit is still fetchable by its sha, so the fetch now falls back to the sha on that one error.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { composeRealDeps } from "../src/lib/composition-root.js";
import { gitRepo } from "./helpers/git-repo.js";

test("a review fetches the PR head by sha when the remote has no refs/pull/N/head", () => {
  const origin = gitRepo({ kind: "review-fetch-origin" });
  origin.git("checkout", "--quiet", "-b", "plan-file-1");
  origin.git("commit", "--quiet", "--allow-empty", "-m", "the filing");
  const headSha = origin.git("rev-parse", "HEAD");
  const reviewer = gitRepo({ kind: "review-fetch-reviewer", seedCommit: false });
  reviewer.addRemote("origin", origin.dir);
  const fetch = composeRealDeps({ repoRoot: reviewer.dir }).reviewWorktree.fetch;

  assert.throws(() => fetch(reviewer.dir, 11708), /couldn't find remote ref refs\/pull\/11708\/head/);
  fetch(reviewer.dir, 11708, headSha);
  assert.equal(execFileSync("git", ["-C", reviewer.dir, "cat-file", "-t", headSha], { encoding: "utf8" }).trim(), "commit");
});

test("a review fetch failure other than a missing pull ref is rethrown without a sha fallback", () => {
  const calls: string[][] = [];
  const exec = (_cmd: string, args: string[]) => {
    calls.push(args);
    throw Object.assign(new Error("Command failed"), { stderr: "fatal: unable to access origin: Could not resolve host" });
  };
  const fetch = composeRealDeps({ repoRoot: "/nonexistent", reviewGitExec: exec }).reviewWorktree.fetch;
  assert.throws(() => fetch("/nonexistent", 7, "a".repeat(40)), /Command failed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), "refs/pull/7/head");
});
